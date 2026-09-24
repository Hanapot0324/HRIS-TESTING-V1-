const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const { logAudit, authenticateToken, requireAdmin, requireSelfOrAdmin } = require("../middleware/auth");
const { notifyAttendanceChanged } = require("../socket/socketService");
const {
  SALARY_VALUE: DEDUCTION_SALARY,
  buildHalfDayPolicySuggestionCore,
} = require("../services/deductionPolicyService");
const {
  getPromiseConnection,
  insertCreditUsageLine,
  refreshLeaveAssignmentCacheFromLedger,
  fetchLedgerSumForAssignment,
} = require("../services/leaveCreditUsageService");
const attendanceWriter = require("../services/attendanceResultWriter");
const { getCtoCreditRunningTotals } = require("../services/ctoCreditRunningTotals");
const { appendCtoDeductionSnapshotRowAsync } = require("../services/ctoLedgerSnapshots");
const {
  getServiceCreditRunningTotals,
  getScRemainingHoursTotal,
} = require("../services/serviceCreditRunningTotals");
const {
  toNum,
  getActivePeriods,
  sortPeriodsDesc,
  getLeaveTypeStatsActive,
  getPriorPeriodCarryForwardHoursForEmployee,
  recomputeAssignmentLedgerFields,
  buildNewPeriodAssignmentFields,
  repairPeriodCarryForwardIfEmpty,
  isCommutedLocked,
  isPeriodVoided,
  assertPeriodIsCurrentDisplay,
  latestPeriodsByKey,
  loadLeavePeriodHistoryAsync,
} = require("../utils/leaveAssignmentBalanceUtils");
const { isApprovedHalfDayInReviewJson } = require("../utils/halfDayReviewUtils");

let io;
router.setSocketIO = (socketIO) => {
  io = socketIO;
};

const emitLeaveChange = (eventName) => {
  if (io) {
    io.emit(eventName);
    console.log(`[Socket.IO] Emitted ${eventName}`);
  }
};

// Mounted at '/' in index.js: scope the guard to this router's own paths so it
// does not run on (and reject) every other request that passes through.
router.use(
  ['/employees', '/leave_assignment', '/leave_credit_usage', '/leave_request', '/leave_table'],
  authenticateToken,
);

// Convert DB hour values to numeric hours.
// Supports numeric values (number or numeric string) and HH:MM[:SS] strings like "33:29:49".
const parseDbHours = (val) => {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;

  const s = String(val).trim();
  if (!s) return 0;

  // Handle HH:MM or HH:MM:SS
  if (s.includes(":")) {
    const [hh, mm, ss] = s.split(":");
    const h = Number(hh) || 0;
    const m = Number(mm) || 0;
    const sec = Number(ss) || 0;
    return h + m / 60 + sec / 3600;
  }

  // Handle "1,234.50"
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const normalizeAssignmentRow = (r) => ({
  ...r,
  total_hours: parseDbHours(r.total_hours),
  remaining_hours: parseDbHours(r.remaining_hours),
  used_hours: parseDbHours(r.used_hours),
  carried_forward_hours: parseDbHours(r.carried_forward_hours),
  allocated_hours: parseDbHours(r.allocated_hours),
  commuted_hours: parseDbHours(r.commuted_hours),
  commuted_days: parseDbHours(r.commuted_days),
});

const semRank = (s) => {
  const v = String(s || "").toLowerCase().trim();
  if (!v) return 0;
  if (v.includes("2nd") || v === "2") return 3;
  if (v.includes("1st") || v === "1") return 2;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 1;
};

/**
 * HR modal context: employee employment type (label only) + hours/day for decimal↔hours sync.
 * Hours/day comes from the employee's official time schedule for the leave date (Time In →
 * Time Out, minus break) when available, else a flat 8-hour default. NOTE: leave_table.leave_hours
 * is NOT a per-day figure — it's the leave type's total entitlement hours (e.g. Maternity Leave
 * = 840h = 105 days × 8h), so it must never be used as a daily rate here. Actual deduction is
 * always what HR saves on leave_request (deduction_applied_hours / hr_approval_rate).
 */
const fetchLeaveDeductionMeta = (employeeNumber, leave_code, leave_date = null) =>
  new Promise((resolve) => {
    db.query(
      `SELECT etc.typeName AS employment_type_name
       FROM users u
       LEFT JOIN employment_category ec
         ON ec.employeeNumber = ?
       LEFT JOIN employment_type_config etc
         ON etc.id = COALESCE(ec.employmentCategory, u.employmentCategory)
       WHERE u.employeeNumber = ?
       LIMIT 1`,
      // Bound parameters instead of CAST(col AS CHAR): lets MySQL use the
      // users / employment_category indexes (this runs per leave deduction).
      [employeeNumber, employeeNumber],
      (err, rows) => {
        const baseMeta = !err && rows?.length ? rows[0] : {};
        fetchOfficialTimeHoursForDate(employeeNumber, leave_date).then((officialHoursPerDay) => {
          resolve({ ...baseMeta, official_hours_per_day: officialHoursPerDay });
        });
      },
    );
  });

const resolveHoursPerDayFromMeta = (meta) => {
  // Employee's actual scheduled hours (official time IN→OUT minus break) take priority
  // over the flat default, so e.g. a 10-hour daily schedule deducts 10 hours/day instead
  // of 8, with no manual override needed.
  const official = parseFloat(meta?.official_hours_per_day);
  if (Number.isFinite(official) && official > 0)
    return { hoursPerDay: official, rateSource: "official_time" };
  return { hoursPerDay: 8, rateSource: "default" };
};

/**
 * leave_table.gender_restriction was previously only enforced in the frontend UI (the
 * Autocomplete's leave-type filter) — nothing stopped a direct API call from creating an
 * assignment/request for a gender-restricted leave type against a mismatched employee.
 * Mirrors the frontend's isLeaveAllowedForGender logic in
 * frontend/src/components/LEAVE/leaveGenderUtils.js so both sides agree.
 */
const isLeaveAllowedForGender = (genderRestriction, employeeGender) => {
  const restriction = String(genderRestriction || "").trim().toLowerCase();
  if (!restriction) return true;
  const g = String(employeeGender || "").trim().toLowerCase();
  if (!g) return false;
  if (restriction === "male") return g === "male" || g === "m";
  if (restriction === "female") return g === "female" || g === "f";
  return true;
};

const getEmployeeGenderAndLeaveRestriction = (employeeNumber, leave_code) =>
  new Promise((resolve) => {
    db.query(
      `SELECT p.sex AS employee_gender, lt.gender_restriction
       FROM leave_table lt
       LEFT JOIN person_table p ON p.agencyEmployeeNum = ?
       WHERE TRIM(lt.leave_code) = TRIM(?)
       LIMIT 1`,
      [employeeNumber, leave_code],
      (err, rows) => resolve(rows?.[0] || {}),
    );
  });

/** Returns an error message string if the leave type's gender_restriction blocks this
 *  employee, or null if it's allowed. Callers just need: if (msg) return res.status(400)... */
const checkGenderRestriction = async (employeeNumber, leave_code) => {
  const meta = await getEmployeeGenderAndLeaveRestriction(employeeNumber, leave_code);
  if (isLeaveAllowedForGender(meta.gender_restriction, meta.employee_gender)) return null;
  const restriction = String(meta.gender_restriction || "").trim();
  return `This leave type is restricted to ${restriction} employees.`;
};

const getScRemainingHours = (employeeNumber, scType = "non_commutative") =>
  new Promise((resolve, reject) => {
    const emp = String(employeeNumber || "").trim();
    const st = String(scType || "non_commutative").trim() || "non_commutative";
    if (!emp) return resolve(0);
    getServiceCreditRunningTotals(emp, st, (err, cur) => {
      if (err) return reject(err);
      const n = Number(cur?.remaining);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });

const getScRemainingHoursAllTypes = (employeeNumber) =>
  new Promise((resolve, reject) => {
    const emp = String(employeeNumber || "").trim();
    if (!emp) return resolve(0);
    getScRemainingHoursTotal(emp, (err, total) => {
      if (err) return reject(err);
      const n = Number(total);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });

/**
 * Apply SC balance delta via service_credit ledger (NOT leave_assignment).
 * deltaHours > 0: deduct remaining; deltaHours < 0: restore remaining.
 */
const applyHoursDeltaAcrossServiceCredit = async ({
  req,
  employeeNumber,
  deltaHours,
  leaveDateOnly,
  requestId = null,
  reason,
  scType = "non_commutative",
  actorEmployeeNumber = null,
}) => {
  const emp = String(employeeNumber || "").trim();
  const st = String(scType || "non_commutative").trim() || "non_commutative";
  const abs = Math.abs(Number(deltaHours) || 0);
  if (!emp || !abs) return;

  const y = parseInt(String(leaveDateOnly || "").slice(0, 4), 10);
  const m = parseInt(String(leaveDateOnly || "").slice(5, 7), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error("Invalid leave_date for SC ledger period");
  }

  const cur = await new Promise((resolve, reject) => {
    getServiceCreditRunningTotals(emp, st, (err, totals) =>
      err ? reject(err) : resolve(totals || { earned: 0, used: 0, remaining: 0 }),
    );
  });

  const remainingBefore = Number(cur.remaining) || 0;
  const earnedSnap = Number(cur.earned) || 0;
  const usedBefore = Number(cur.used) || 0;

  let apply = abs;
  if (deltaHours > 0) {
    if (remainingBefore + 1e-6 < abs) {
      throw new Error(
        `Insufficient Service Credit (SC) balance. Need ${abs} hours but only ${remainingBefore} available.`,
      );
    }
  } else {
    // restore: don't restore more than what has been used
    apply = Math.min(abs, Math.max(0, usedBefore));
    if (apply <= 0) return;
  }

  const remainingAfter = deltaHours > 0 ? remainingBefore - apply : remainingBefore + apply;
  const usedAfter = deltaHours > 0 ? usedBefore + apply : Math.max(0, usedBefore - apply);
  const action = deltaHours > 0 ? "offset" : "restore";
  const remarks = [
    requestId != null ? `leave_request:${requestId}` : null,
    "SC",
    action === "offset" ? "deduct" : "restore",
    leaveDateOnly ? String(leaveDateOnly) : null,
    reason || null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);

  const newScId = await new Promise((resolve, reject) => {
    db.query(
      `INSERT INTO service_credit
        (employeeNumber, sc_type, ot_hours_regular, ot_hours_holiday, ot_hours_night_diff, total_ot_hours,
         earned_hours, remaining_hours, used_hours, period_year, period_month, remarks, emp_category_snapshot)
       VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        emp,
        st,
        earnedSnap,
        remainingAfter,
        usedAfter,
        y,
        m,
        remarks,
        null,
      ],
      (err, res) => {
        if (err) return reject(err);
        resolve(res.insertId);
      },
    );
  });

  // Minimal column set (matches serviceCredit.js inserts; other columns may exist but are optional).
  db.query(
    `INSERT INTO service_credit_usage
     (service_credit_id, employeeNumber, action, hours_applied, target_leave_code)
     VALUES (?,?,?,?,?)`,
    [newScId, emp, action, apply, null],
    (e) => {
      if (e) console.error("[leave] SC usage insert:", e.message);
    },
  );
};

/** Normalize leave_date / DB date to YYYY-MM-DD */
const toMysqlDateOnly = (leaveDateRaw) => {
  if (leaveDateRaw == null) return null;
  if (leaveDateRaw instanceof Date && !isNaN(leaveDateRaw.getTime())) {
    const y = leaveDateRaw.getFullYear();
    const m = String(leaveDateRaw.getMonth() + 1).padStart(2, "0");
    const d = String(leaveDateRaw.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(leaveDateRaw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
};

const punchFieldEmpty = (v) =>
  v == null ||
  String(v).trim() === "" ||
  String(v).trim().toUpperCase() === "N/A";

/** Parses "hh:mm:ss AM/PM" (the officialtime table's stored format) into minutes-of-day. */
const officialTimeToMinutes = (val) => {
  if (punchFieldEmpty(val)) return null;
  const m = String(val).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10) % 12;
  if (m[4].toUpperCase() === "PM") hh += 12;
  return hh * 60 + parseInt(m[2], 10);
};

/** Scheduled work hours for a day-row (Time In → Time Out, minus break if both are set). */
const computeOfficialHoursPerDay = (row) => {
  const inMin = officialTimeToMinutes(row?.officialTimeIN);
  const outMin = officialTimeToMinutes(row?.officialTimeOUT);
  if (inMin == null || outMin == null) return null;
  let totalMin = outMin - inMin;
  if (totalMin <= 0) totalMin += 24 * 60;
  const breakInMin = officialTimeToMinutes(row?.officialBreaktimeIN);
  const breakOutMin = officialTimeToMinutes(row?.officialBreaktimeOUT);
  if (breakInMin != null && breakOutMin != null && breakOutMin > breakInMin) {
    totalMin -= breakOutMin - breakInMin;
  }
  const hours = totalMin / 60;
  return hours > 0 && hours <= 24 ? hours : null;
};

/** Employee's scheduled hours/day for the leave date, from their official time schedule. */
const fetchOfficialTimeHoursForDate = (employeeNumber, leaveDateRaw) =>
  new Promise((resolve) => {
    const leaveDate = toMysqlDateOnly(leaveDateRaw);
    if (!employeeNumber || !leaveDate) return resolve(null);
    db.query(
      `SELECT officialTimeIN, officialTimeOUT, officialBreaktimeIN, officialBreaktimeOUT
       FROM officialtime
       WHERE employeeID = ?
         AND day = DAYNAME(?)
         AND ? BETWEEN startDate AND endDate
       ORDER BY startDate DESC
       LIMIT 1`,
      [employeeNumber, leaveDate, leaveDate],
      (err, rows) => {
        if (err || !rows?.length) return resolve(null);
        resolve(computeOfficialHoursPerDay(rows[0]));
      },
    );
  });

/**
 * When HR approves leave, ensure attendancerecord exists for that date with official
 * schedule times so DTR / modules show a full day (tardiness already zeroed in UI when ON LEAVE).
 * Only inserts or fills rows that have no punch data yet (does not overwrite real device punches).
 */
const syncApprovedLeaveToAttendanceRecord = (employeeNumber, leaveDateRaw) =>
  new Promise((resolve, reject) => {
    const leaveDate = toMysqlDateOnly(leaveDateRaw);
    const emp = String(employeeNumber || "").trim();
    if (!leaveDate || !emp) return resolve({ skipped: true, reason: "bad-args" });

    const otSql = `
      SELECT officialTimeIN, officialTimeOUT, officialBreaktimeIN, officialBreaktimeOUT
      FROM officialtime
      WHERE employeeID = ?
        AND day = DAYNAME(?)
        AND ? BETWEEN startDate AND endDate
      ORDER BY startDate DESC
      LIMIT 1
    `;
    db.query(otSql, [emp, leaveDate, leaveDate], (e1, otRows) => {
      if (e1) return reject(e1);
      const ot = otRows?.[0];
      if (
        !ot ||
        punchFieldEmpty(ot.officialTimeIN) ||
        punchFieldEmpty(ot.officialTimeOUT)
      ) {
        return resolve({ skipped: true, reason: "no-official-time" });
      }

      const timeIN = ot.officialTimeIN;
      const timeOUT = ot.officialTimeOUT;
      const breaktimeIN = ot.officialBreaktimeIN || null;
      const breaktimeOUT = ot.officialBreaktimeOUT || null;

      const exSql = `SELECT id, timeIN, breaktimeIN, breaktimeOUT, timeOUT FROM attendancerecord WHERE personID = ? AND date = ? LIMIT 1`;
      db.query(exSql, [emp, leaveDate], (e2, exRows) => {
        if (e2) return reject(e2);
        const ex = exRows?.[0];

        const notifyUpdated = (recordId) => {
          notifyAttendanceChanged("updated", {
            scope: "leave-hr-approved",
            personIDs: [emp],
            recordIds: recordId ? [recordId] : [],
          });
        };

        if (ex) {
          const allEmpty =
            punchFieldEmpty(ex.timeIN) &&
            punchFieldEmpty(ex.breaktimeIN) &&
            punchFieldEmpty(ex.breaktimeOUT) &&
            punchFieldEmpty(ex.timeOUT);
          if (!allEmpty) {
            return resolve({ skipped: true, reason: "existing-punches" });
          }
          const up = `UPDATE attendancerecord SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ? WHERE id = ?`;
          db.query(
            up,
            [timeIN, breaktimeIN, breaktimeOUT, timeOUT, ex.id],
            (e3) => {
              if (e3) return reject(e3);
              notifyUpdated(ex.id);
              resolve({ updated: true });
            },
          );
          return;
        }

        db.query(`SELECT DAYNAME(?) AS dow`, [leaveDate], (e4, drows) => {
          if (e4) return reject(e4);
          const dow = drows?.[0]?.dow || "Monday";
          const ins = `INSERT INTO attendancerecord (personID, date, day, timeIN, breaktimeIN, breaktimeOUT, timeOUT) VALUES (?, ?, ?, ?, ?, ?, ?)`;
          db.query(
            ins,
            [emp, leaveDate, dow, timeIN, breaktimeIN, breaktimeOUT, timeOUT],
            (e5) => {
              if (e5) return reject(e5);
              notifyAttendanceChanged("updated", {
                scope: "leave-hr-approved",
                personIDs: [emp],
              });
              resolve({ inserted: true });
            },
          );
        });
      });
    });
  });

const getLeaveAssignmentsForCode = (employeeNumber, leave_code) =>
  new Promise((resolve) => {
    db.query(
      `SELECT *
       FROM leave_assignment
       WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)
       ORDER BY period_year DESC,
         CASE
           WHEN period_semester IN ('2nd','2nd semester','2') THEN 3
           WHEN period_semester IN ('1st','1st semester','1') THEN 2
           ELSE 1
         END DESC,
         id DESC`,
      [employeeNumber, leave_code],
      (err, rows) => {
        if (err) return resolve([]);
        resolve(Array.isArray(rows) ? rows.map(normalizeAssignmentRow) : []);
      },
    );
  });

/** Matches Assignment Management: latest active period only (not SUM of all historical rows). */
const getTotalRemainingHours = async (employeeNumber, leave_code) => {
  const rows = await getLeaveAssignmentsForCode(employeeNumber, leave_code);
  return getLeaveTypeStatsActive(rows).remainingHours;
};

const safeJsonStringify = (value) => {
  try {
    return JSON.stringify(value ?? null);
  } catch (_e) {
    return null;
  }
};

const nearlyEqual = (a, b, tolerance = 0.0001) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= tolerance;
};

const getActorEmployeeNumber = (req, fallback = null) => {
  if (req.user?.employeeNumber) return String(req.user.employeeNumber);

  const authHeader = req.headers?.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded?.employeeNumber) return String(decoded.employeeNumber);
      if (decoded?.username) return String(decoded.username);
    } catch (err) {
      console.warn("[leave] Failed to decode auth token:", err.message);
    }
  }

  return fallback ? String(fallback) : "unknown";
};

const buildDeductionSuggestion = async ({
  employeeNumber,
  leave_code,
  leave_date = null,
  has_leave_form = true,
  is_half_day_absence = false,
  requested_rate_decimal = null,
}) => {
  const hasLeaveForm = has_leave_form !== false;
  const isHalfDayAbsence = Boolean(is_half_day_absence);

  const suggestedLeaveCode = hasLeaveForm
    ? leave_code
    : isHalfDayAbsence
      ? "VL"
      : leave_code || "VL";

  const meta = await fetchLeaveDeductionMeta(employeeNumber, suggestedLeaveCode, leave_date);
  const { hoursPerDay } = resolveHoursPerDayFromMeta(meta);

  const requestedRate = parseFloat(requested_rate_decimal);
  const defaultRate = isHalfDayAbsence ? 0.5 : 1;
  const recommendedRate =
    Number.isFinite(requestedRate) && requestedRate > 0
      ? requestedRate
      : defaultRate;
  const recommendedHours = Number((recommendedRate * hoursPerDay).toFixed(4));

  const availableHours = suggestedLeaveCode
    ? await getTotalRemainingHours(employeeNumber, suggestedLeaveCode)
    : 0;
  const hasSufficientBalance = availableHours >= recommendedHours;
  const recommendedChargeTo = hasSufficientBalance
    ? suggestedLeaveCode
    : DEDUCTION_SALARY;

  return {
    employeeNumber: String(employeeNumber || ""),
    leave_code: leave_code || null,
    leave_date: toMysqlDateOnly(leave_date),
    has_leave_form: hasLeaveForm,
    is_half_day_absence: isHalfDayAbsence,
    recommended_leave_code: suggestedLeaveCode || null,
    recommended_charge_to: recommendedChargeTo,
    recommended_rate_decimal: Number(recommendedRate.toFixed(3)),
    recommended_hours: recommendedHours,
    hours_per_day: Number(hoursPerDay.toFixed(4)),
    available_hours: Number((availableHours || 0).toFixed(4)),
    has_sufficient_balance: hasSufficientBalance,
    recommendation_reason: hasLeaveForm
      ? "Leave form exists; prefill based on selected leave type."
      : isHalfDayAbsence
        ? "No leave form + half-day absence; prefill VL 0.5 day."
        : "No leave form; default prefill applied.",
  };
};

const getFiledLeaveRequestForDate = ({ employeeNumber, leave_date }) =>
  new Promise((resolve, reject) => {
    const dateOnly = toMysqlDateOnly(leave_date);
    if (!employeeNumber || !dateOnly) return resolve(null);
    db.query(
      `SELECT lr.id, lr.leave_code, lr.status, lt.leave_description
       FROM leave_request lr
       LEFT JOIN leave_table lt ON TRIM(lt.leave_code) = TRIM(lr.leave_code)
       WHERE CAST(lr.employeeNumber AS CHAR) = CAST(? AS CHAR)
         AND DATE(lr.leave_date) = DATE(?)
         AND lr.status IN (0, 1, 2)
       ORDER BY lr.status DESC, lr.id DESC
       LIMIT 1`,
      [employeeNumber, dateOnly],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows?.[0] || null);
      },
    );
  });

/** Latest CTO snapshot remaining (aligned with ctoCreditRunningTotals / earnings module). */
const getCtoRemainingHours = (employeeNumber) =>
  new Promise((resolve) => {
    const emp = String(employeeNumber || "").trim();
    if (!emp) return resolve(0);
    getCtoCreditRunningTotals(emp, (err, cur) => {
      if (err) return resolve(0);
      const n = Number(cur?.remaining);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });

const buildHalfDayPolicySuggestion = async ({
  employeeNumber,
  leave_date,
  preferred_charge_to = null,
}) => {
  const core = await buildHalfDayPolicySuggestionCore({
    employeeNumber,
    leave_date: toMysqlDateOnly(leave_date),
    preferred_charge_to,
    getFiledLeaveRequestForDate,
  });
  return core;
};

const insertDeductionDecisionLog = ({
  leaveRequestId = null,
  employeeNumber,
  leave_code = null,
  leave_date = null,
  decision = "accepted",
  decisionSource = "hr_approval",
  actorEmployeeNumber = null,
  systemRecommendation = null,
  finalApplied = null,
  overrideReason = null,
}) =>
  new Promise((resolve) => {
    const sql = `
      INSERT INTO deduction_decision_log (
        leave_request_id,
        employeeNumber,
        leave_code,
        leave_date,
        decision,
        decision_source,
        actor_employeeNumber,
        system_recommendation_json,
        final_applied_json,
        override_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.query(
      sql,
      [
        leaveRequestId,
        String(employeeNumber || ""),
        leave_code || null,
        toMysqlDateOnly(leave_date),
        decision || "accepted",
        decisionSource || "hr_approval",
        actorEmployeeNumber ? String(actorEmployeeNumber) : null,
        safeJsonStringify(systemRecommendation),
        safeJsonStringify(finalApplied),
        overrideReason || null,
      ],
      (err, result) => {
        if (err) {
          console.error("[leave] Failed to insert deduction decision log:", err.message);
          return resolve(null);
        }
        resolve(result && result.insertId != null ? result.insertId : null);
      },
    );
  });

/** Half-day policy applies are logged via transaction_table + audit_log (leave_transaction) only;
 *  earnings_audit_log is reserved for leave / SC / CTO ledger rows. */

/** Mirrors POST /api/leave-salary-shortfall so SalaryShortfallRegistry lists half-day salary applies. */
const insertLeaveSalaryShortfallForHalfDaySalary = ({
  employeeNumber,
  leaveDateOnly,
  shortfallDaysDecimal,
  shortfallHours,
  decisionLogId,
}) =>
  new Promise((resolve) => {
    const s = String(leaveDateOnly || "").slice(0, 10);
    const parts = s.split("-");
    const py = parseInt(parts[0], 10);
    const pm = parseInt(parts[1], 10);
    if (!Number.isFinite(py) || !Number.isFinite(pm) || pm < 1 || pm > 12) {
      return resolve();
    }
    const daysFromPolicy = Math.abs(Number(shortfallDaysDecimal));
    const hrsIn = Number(shortfallHours);
    const posDays =
      daysFromPolicy > 0
        ? Number(daysFromPolicy.toFixed(6))
        : Number.isFinite(hrsIn) && hrsIn > 0
          ? Number((hrsIn / 8).toFixed(6))
          : 0;
    if (!(posDays > 0)) return resolve();
    const posHrs =
      Number.isFinite(hrsIn) && hrsIn > 0
        ? Number(hrsIn.toFixed(6))
        : Number((posDays * 8).toFixed(6));
    const negDays = Number((-posDays).toFixed(6));
    const remarks = `Half-day attendance charged to salary — date ${s}${
      decisionLogId != null ? ` (policy ref #${decisionLogId})` : ""
    }`;
    db.query(
      `INSERT INTO leave_salary_shortfall (
        employee_number, period_year, period_month,
        negative_balance_days, shortfall_days, shortfall_hours,
        leave_code, entry_type, leave_earning_id, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        String(employeeNumber || ""),
        py,
        pm,
        negDays,
        posDays,
        posHrs,
        "HALF_DAY",
        "HALF_DAY_POLICY_SALARY",
        remarks.slice(0, 4000),
      ],
      (err) => {
        if (err) {
          console.error("[leave] leave_salary_shortfall insert (half-day salary):", err.message);
        }
        resolve();
      },
    );
  });

const getHalfDayDeductionAppliedLogs = ({
  employeeNumber,
  leave_code,
  leave_date,
  decisionSource = "half_day_policy_manual_apply",
}) =>
  new Promise((resolve) => {
    const sql = `
      SELECT id, decision, decision_source, leave_date
      FROM deduction_decision_log
      WHERE employeeNumber = ?
        AND leave_code = ?
        AND leave_date = ?
        AND decision_source = ?
        AND decision IN ('accepted','overridden')
      ORDER BY id DESC
    `;
    db.query(
      sql,
      [
        String(employeeNumber || ""),
        String(leave_code || ""),
        toMysqlDateOnly(leave_date),
        decisionSource,
      ],
      (err, rows) => {
        if (err) {
          console.error("[leave] Failed to fetch half-day applied logs:", err.message);
          return resolve([]);
        }
        resolve(Array.isArray(rows) ? rows : []);
      },
    );
  });

const getHalfDayDeductionAppliedDates = ({
  employeeNumber,
  leave_code = "VL",
  startDate,
  endDate,
  decisionSource = "half_day_policy_manual_apply",
}) =>
  new Promise((resolve) => {
    const allCodes =
      !leave_code ||
      String(leave_code).trim() === "*" ||
      String(leave_code).trim().toUpperCase() === "__ALL__";
    const sql = `
      SELECT DISTINCT DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date
      FROM deduction_decision_log
      WHERE employeeNumber = ?
        ${allCodes ? "" : "AND leave_code = ?"}
        AND decision_source = ?
        AND decision IN ('accepted','overridden')
        AND leave_date BETWEEN ? AND ?
      ORDER BY leave_date ASC
    `;
    const params = allCodes
      ? [
          String(employeeNumber || ""),
          decisionSource,
          toMysqlDateOnly(startDate),
          toMysqlDateOnly(endDate),
        ]
      : [
          String(employeeNumber || ""),
          String(leave_code || ""),
          decisionSource,
          toMysqlDateOnly(startDate),
          toMysqlDateOnly(endDate),
        ];
    db.query(
      sql,
      params,
      (err, rows) => {
        if (err) {
          console.error("[leave] Failed to fetch half-day applied dates:", err.message);
          return resolve([]);
        }
        resolve(
          (Array.isArray(rows) ? rows : [])
            .map((r) => r?.leave_date)
            .filter(Boolean),
        );
      },
    );
  });

// Deduct or restore hours across multiple rows (newest-first).
// deltaHours > 0: deduct from remaining, add to used
// deltaHours < 0: restore to remaining, subtract from used
// Persists each slice as a row in leave_credit_usage and refreshes assignment caches from the ledger.
const applyHoursDeltaAcrossAssignments = async ({
  req,
  actorEmployeeNumber,
  employeeNumber,
  leave_code,
  deltaHours,
  requestId = null,
  reason,
  sourceType = null,
}) => {
  const abs = Math.abs(Number(deltaHours) || 0);
  if (!employeeNumber || !leave_code || !abs) return;

  const allRows = await getLeaveAssignmentsForCode(employeeNumber, leave_code);
  const rows = sortPeriodsDesc(getActivePeriods(allRows));
  if (!rows.length) {
    if (Number(deltaHours) > 0) {
      throw new Error(
        `No active leave_assignment for leave code "${leave_code}". Assign credits first or choose a different charge-to balance.`,
      );
    }
    return;
  }

  const resolvedSourceType =
    sourceType ||
    (requestId != null ? "LEAVE_REQUEST" : "LEAVE_BALANCE_ADJUSTMENT");

  const conn = await getPromiseConnection();
  const createdBy = String(actorEmployeeNumber || getActorEmployeeNumber(req));
  try {
    await conn.beginTransaction();

    // Lock every active period row up front and read its fresh balance BEFORE applying
    // anything. This lets a deduction be rejected as a whole when the sum across periods
    // is insufficient, instead of the previous behavior: silently applying whatever
    // partial amount happened to be available while the caller's own audit trail (e.g.
    // leave_request.deduction_applied_hours) still recorded the full requested amount.
    const locked = [];
    for (const row of rows) {
      const [freshRows] = await conn.execute(
        `SELECT remaining_hours, used_hours, period_year, period_semester
         FROM leave_assignment WHERE id = ? FOR UPDATE`,
        [row.id],
      );
      const fr = freshRows?.[0];
      if (!fr) continue;

      const periodMonthRaw = fr.period_semester;
      let periodMonth = null;
      if (periodMonthRaw != null && String(periodMonthRaw).trim() !== "") {
        const n = parseInt(String(periodMonthRaw).replace(/\D/g, "") || "0", 10);
        periodMonth = Number.isFinite(n) && n > 0 ? n : null;
      }
      const periodYear =
        fr.period_year != null ? parseInt(fr.period_year, 10) : null;

      locked.push({
        rowId: row.id,
        curRem: parseDbHours(fr.remaining_hours) || 0,
        curUsed: parseDbHours(fr.used_hours) || 0,
        periodMonth,
        periodYear,
      });
    }

    if (deltaHours > 0) {
      const totalAvailable = locked.reduce((s, r) => s + r.curRem, 0);
      if (totalAvailable + 1e-6 < abs) {
        throw new Error(
          `Insufficient ${leave_code} balance. Need ${abs} hours but only ${totalAvailable} available.`,
        );
      }
    }

    let remaining = abs;
    for (const { rowId, curRem, curUsed, periodMonth, periodYear } of locked) {
      if (remaining <= 0) break;

      if (deltaHours > 0) {
        if (curRem <= 0) continue;
        const take = Math.min(curRem, remaining);
        const newRem = Math.max(0, curRem - take);
        const newUsed = Math.max(0, curUsed + take);
        await insertCreditUsageLine(conn, {
          leave_assignment_id: rowId,
          employee_number: employeeNumber,
          leave_code,
          period_year: Number.isFinite(periodYear) ? periodYear : null,
          period_month: periodMonth,
          hours_delta: -take,
          source_type: resolvedSourceType,
          source_id: requestId,
          remarks: reason || null,
          created_by: createdBy,
        });
        await refreshLeaveAssignmentCacheFromLedger(conn, rowId);
        auditLeaveBalanceAdjustment({
          req,
          actorEmployeeNumber,
          employeeNumber,
          leave_code,
          requestId,
          reason,
          oldRemaining: curRem,
          newRemaining: newRem,
          oldUsed: curUsed,
          newUsed,
          deltaHours: -take,
          assignmentRowId: rowId,
        });
        remaining -= take;
        continue;
      }

      const canRestore = curUsed > 0;
      if (!canRestore) continue;
      const putBack = Math.min(curUsed, remaining);
      const newRem = curRem + putBack;
      const newUsed = Math.max(0, curUsed - putBack);
      await insertCreditUsageLine(conn, {
        leave_assignment_id: rowId,
        employee_number: employeeNumber,
        leave_code,
        period_year: Number.isFinite(periodYear) ? periodYear : null,
        period_month: periodMonth,
        hours_delta: putBack,
        source_type: resolvedSourceType,
        source_id: requestId,
        remarks: reason || null,
        created_by: createdBy,
      });
      await refreshLeaveAssignmentCacheFromLedger(conn, rowId);
      auditLeaveBalanceAdjustment({
        req,
        actorEmployeeNumber,
        employeeNumber,
        leave_code,
        requestId,
        reason,
        oldRemaining: curRem,
        newRemaining: newRem,
        oldUsed: curUsed,
        newUsed,
        deltaHours: +putBack,
        assignmentRowId: rowId,
      });
      remaining -= putBack;
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

const insertTransactionLog = (
  employeeId,
  message,
  actorEmployeeNumber = null,
  auditDetailsPayload = null,
) =>
  new Promise((resolve) => {
    if (!employeeId || !message) return resolve();

    db.query(
      "INSERT INTO transaction_table (employee_id, message) VALUES (?, ?)",
      [employeeId, message],
      (err, result) => {
        if (err) {
          console.error("[leave] Failed to insert transaction log:", err.message);
          return resolve();
        }
        // Mirror to audit_log so it appears in the Audit Trail in real-time
        try {
          let detailsJson = null;
          if (auditDetailsPayload != null) {
            try {
              detailsJson =
                typeof auditDetailsPayload === "string"
                  ? auditDetailsPayload
                  : JSON.stringify({
                      message,
                      ...auditDetailsPayload,
                    });
            } catch (e) {
              detailsJson = JSON.stringify({ message });
            }
          }
          const auditLabel =
            (auditDetailsPayload &&
              typeof auditDetailsPayload === "object" &&
              auditDetailsPayload.audit_action) ||
            (auditDetailsPayload != null
              ? "Half-day deduction applied"
              : message);
          logAudit(
            { employeeNumber: actorEmployeeNumber || employeeId },
            auditLabel,
            "leave_transaction",
            result.insertId,
            employeeId,
            detailsJson,
          );
        } catch (e) {
          console.error("[leave] Failed to mirror to audit_log:", e.message);
        }
        resolve();
      },
    );
  });

const getEmployeeFullName = (employeeNumber) =>
  new Promise((resolve) => {
    if (!employeeNumber) return resolve("");

    db.query(
      `SELECT CONCAT_WS(' ', firstName, middleName, lastName, nameExtension) AS fullName
       FROM person_table
       WHERE agencyEmployeeNum = ?
       LIMIT 1`,
      [employeeNumber],
      (err, rows) => {
        if (err) {
          console.error("[leave] Failed to fetch employee full name:", err.message);
          return resolve("");
        }
        resolve((rows && rows[0] && rows[0].fullName) || "");
      },
    );
  });

const formatUserDisplayName = (employeeNumber, fullName) => {
  const emp = employeeNumber ? String(employeeNumber) : "unknown";
  const name = (fullName || "").trim();
  return name ? `${name} (${emp})` : emp;
};

/** Same pattern as earnings transaction logs (before → after, signed delta). */
const formatBalanceUpdatedSuffix = (beforeH, afterH, deltaH) => {
  const before = Number(beforeH || 0);
  const after = Number(afterH || 0);
  const delta = Number(deltaH || 0);
  const sign = delta >= 0 ? "−" : "+";
  return ` Balance updated: ${before.toFixed(3)} hrs → ${after.toFixed(3)} hrs (${sign}${Math.abs(delta).toFixed(3)} hrs).`;
};

/** HR modal "charge to" — may differ from leave_code on the filed request (e.g. Half Day form → VL balance). */
const resolveHrDeductionChargeCode = ({
  charge_to = null,
  decision_context = null,
  requestLeaveCode = null,
  systemRecommendation = null,
}) => {
  const raw =
    charge_to ||
    decision_context?.charge_to ||
    systemRecommendation?.recommended_charge_to ||
    requestLeaveCode;
  const code = String(raw || requestLeaveCode || "").trim();
  return code || String(requestLeaveCode || "").trim();
};

const buildLeaveTransactionMessage = ({
  action,
  actorDisplayName,
  requesterDisplayName,
  leaveDesc,
  leaveDates,
}) => {
  if (!action) return null;

  const dateStr = (() => {
    if (!leaveDates) return '';
    const arr = Array.isArray(leaveDates)
      ? leaveDates.filter(Boolean)
      : String(leaveDates).split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.length) return '';
    if (arr.length === 1) return ` on ${arr[0]}`;
    const sorted = [...arr].sort();
    return ` from ${sorted[0]} to ${sorted[sorted.length - 1]} (${arr.length} day(s))`;
  })();

  if (action === "request") {
    if (
      requesterDisplayName &&
      actorDisplayName &&
      requesterDisplayName !== actorDisplayName
    ) {
      return `${actorDisplayName} submitted a ${leaveDesc} request${dateStr} for ${requesterDisplayName}.`;
    }
    return `${actorDisplayName} submitted a ${leaveDesc} request${dateStr}.`;
  }

  if (action === "denied") {
    return `${actorDisplayName} denied ${requesterDisplayName}'s ${leaveDesc} request.`;
  }

  if (action === "immediateSupervisor_approved") {
    return `Immediate Supervisor ${actorDisplayName} approved ${requesterDisplayName}'s ${leaveDesc} request.`;
  }

  if (action === "hr_approved") {
    return `HR Officer ${actorDisplayName} fully approved ${requesterDisplayName}'s ${leaveDesc} request.`;
  }

  if (action === "cancelled") {
    return `${actorDisplayName} cancelled their ${leaveDesc} request.`;
  }

  return null;
};

const statusToLeaveAction = (statusValue) => {
  const s = Number(statusValue);
  if (s === 1) return "immediateSupervisor_approved";
  if (s === 2) return "hr_approved";
  if (s === 3) return "denied";
  if (s === 4) return "cancelled";
  return null;
};

const auditLeaveBalanceAdjustment = ({
  req,
  actorEmployeeNumber,
  employeeNumber,
  leave_code,
  requestId = null,
  reason,
  oldRemaining,
  newRemaining,
  oldUsed,
  newUsed,
  deltaHours,
  assignmentRowId = null,
}) => {
  try {
    const details = {
      reason,
      source: "leave_request_status_change",
      request_id: requestId,
      employeeNumber,
      leave_code,
      delta_hours: deltaHours,
      before: {
        remaining_hours: oldRemaining,
        used_hours: oldUsed,
      },
      after: {
        remaining_hours: newRemaining,
        used_hours: newUsed,
      },
      assignment_row_id: assignmentRowId,
    };
    logAudit(
      { employeeNumber: actorEmployeeNumber },
      `Auto-adjust leave balance (${deltaHours >= 0 ? "+" : ""}${deltaHours} hrs)`,
      "leave_assignment",
      assignmentRowId,
      employeeNumber,
      details,
    );
  } catch (e) {
    console.error("[leave] Failed to audit leave balance adjustment:", e.message);
  }
};

// ============================================
// EMPLOYEES
// ============================================
router.get("/employees", requireAdmin, (req, res) => {
  const query = `
    SELECT u.employeeNumber, u.email, u.role,
      p.firstName, p.middleName, p.lastName, p.nameExtension,
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) as fullName
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE u.role != 'superadmin'
    ORDER BY p.lastName, p.firstName
  `;
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching employees:", err);
      return res.status(500).json({ error: "Failed to fetch employees" });
    }
    res.json(results);
  });
});

// ============================================
// LEAVE TABLE
// ============================================
router.get("/leave_table", requireAdmin, (req, res) => {
  db.query("SELECT * FROM leave_table ORDER BY leave_code", (err, results) => {
    if (err)
      return res.status(500).json({ error: "Failed to fetch leave types" });
    res.json(results);
  });
});

const normalizeLeaveTableHours = (leave_hours) => {
  if (leave_hours === null || leave_hours === undefined || leave_hours === "") return 0;
  if (typeof leave_hours === "number")
    return Number.isFinite(leave_hours) ? leave_hours : 0;
  const n = parseFloat(String(leave_hours).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

router.post("/leave_table", requireAdmin, (req, res) => {
  const { leave_code, leave_description, leave_hours, gender_restriction } = req.body;
  const hoursVal = normalizeLeaveTableHours(leave_hours);
  const genderVal =
    gender_restriction && String(gender_restriction).trim()
      ? String(gender_restriction).trim()
      : null;
  db.query(
    "INSERT INTO leave_table (leave_code, leave_description, leave_hours, gender_restriction) VALUES (?, ?, ?, ?)",
    [leave_code, leave_description, hoursVal, genderVal],
    (err, result) => {
      if (err) {
        console.error("[leave_table] INSERT error:", err.code, err.sqlMessage || err.message);
        logAudit(
          { employeeNumber: getActorEmployeeNumber(req) },
          "Insert Failed",
          "leave_table",
          null,
          null,
        );
        if (err.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A leave type with this code already exists." });
        }
        if (err.code === "ER_BAD_FIELD_ERROR") {
          return res.status(500).json({
            error:
              "Database schema is missing column gender_restriction on leave_table. Run backend/migrations/add_leave_table_gender_restriction.sql",
          });
        }
        return res.status(500).json({ error: "Failed to create leave type" });
      }
      logAudit({ employeeNumber: getActorEmployeeNumber(req) }, 'Insert', 'leave_table', result.insertId, null);
      res.json({
        id: result.insertId,
        leave_code,
        leave_description,
        leave_hours: hoursVal,
      });
    },
  );
});

router.put("/leave_table/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { leave_code, leave_description, leave_hours, gender_restriction } = req.body;
  const hoursVal = normalizeLeaveTableHours(leave_hours);
  const genderVal =
    gender_restriction && String(gender_restriction).trim()
      ? String(gender_restriction).trim()
      : null;
  db.query(
    "UPDATE leave_table SET leave_code = ?, leave_description = ?, leave_hours = ?, gender_restriction = ? WHERE id = ?",
    [leave_code, leave_description, hoursVal, genderVal, id],
    (err) => {
      if (err) {
        console.error("[leave_table] UPDATE error:", err.code, err.sqlMessage || err.message);
        logAudit(
          { employeeNumber: getActorEmployeeNumber(req) },
          "Update Failed",
          "leave_table",
          id,
          null,
        );
        if (err.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A leave type with this code already exists." });
        }
        if (err.code === "ER_BAD_FIELD_ERROR") {
          return res.status(500).json({
            error:
              "Database schema is missing column gender_restriction on leave_table. Run backend/migrations/add_leave_table_gender_restriction.sql",
          });
        }
        return res.status(500).json({ error: "Failed to update leave type" });
      }
      logAudit({ employeeNumber: getActorEmployeeNumber(req) }, "Update", "leave_table", id, null);
      res.json({ id, leave_code, leave_description, leave_hours: hoursVal });
    },
  );
});

router.delete("/leave_table/:id", requireAdmin, (req, res) => {
  db.query("DELETE FROM leave_table WHERE id = ?", [req.params.id], (err) => {
    if (err) {
      logAudit({ employeeNumber: getActorEmployeeNumber(req) }, 'Delete Failed', 'leave_table', req.params.id, null);
      return res.status(500).json({ error: "Failed to delete leave type" });
    }
    logAudit({ employeeNumber: getActorEmployeeNumber(req) }, 'Delete', 'leave_table', req.params.id, null);
    res.json({ message: "Leave type deleted successfully" });
  });
});

// ============================================
// LEAVE ASSIGNMENT
// ============================================
router.get("/leave_assignment", requireAdmin, (req, res) => {
  const query = `
    SELECT la.id, la.employeeNumber, la.leave_code, la.total_hours, la.remaining_hours, la.used_hours,
      la.approve_date AS approved_date, la.carried_forward_hours, la.allocated_hours, la.period_year, la.period_semester,
      COALESCE(la.commuted, 0) AS commuted, la.voided_at,
      lc.commuted_hours, lc.commuted_days, lc.commutation_id,
      lt.leave_description, lt.leave_hours as default_hours,
      p.firstName, p.middleName, p.lastName, p.nameExtension,
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) as fullName
    FROM leave_assignment la
    LEFT JOIN (
      SELECT leave_assignment_id,
             MAX(id) AS commutation_id,
             MAX(commuted_hours) AS commuted_hours,
             MAX(commuted_days) AS commuted_days
      FROM leave_commutation
      WHERE status != 3
      GROUP BY leave_assignment_id
    ) lc ON lc.leave_assignment_id = la.id
    LEFT JOIN leave_table lt ON la.leave_code = lt.leave_code
    LEFT JOIN person_table p ON la.employeeNumber = p.agencyEmployeeNum
    ORDER BY p.lastName, p.firstName, la.leave_code
  `;
  db.query(query, (err, results) => {
    if (err) {
      console.error("[GET /leave_assignment] DB Error:", err.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch leave assignments: " + err.message });
    }
    // Normalize hour fields so frontend receives numeric hour values
    const out = Array.isArray(results) ? results.map(normalizeAssignmentRow) : results;
    res.json(out);
  });
});

router.get("/leave_assignment/employee/:employeeNumber", requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const query = `
    SELECT la.id, la.employeeNumber, la.leave_code, la.total_hours, la.remaining_hours, la.used_hours,
      la.approve_date AS approved_date, la.carried_forward_hours, la.allocated_hours, la.period_year, la.period_semester,
      COALESCE(la.commuted, 0) AS commuted, la.voided_at,
      lc.commuted_hours, lc.commuted_days, lc.commutation_id,
      lt.leave_description
    FROM leave_assignment la
    LEFT JOIN (
      SELECT leave_assignment_id,
             MAX(id) AS commutation_id,
             MAX(commuted_hours) AS commuted_hours,
             MAX(commuted_days) AS commuted_days
      FROM leave_commutation
      WHERE status != 3
      GROUP BY leave_assignment_id
    ) lc ON lc.leave_assignment_id = la.id
    LEFT JOIN leave_table lt ON la.leave_code = lt.leave_code
    WHERE la.employeeNumber = ?
  `;
  db.query(query, [req.params.employeeNumber], (err, results) => {
    if (err)
      return res
        .status(500)
        .json({ error: "Failed to fetch leave assignments" });
    const out = Array.isArray(results) ? results.map(normalizeAssignmentRow) : results;
    res.json(out);
  });
});

router.get(
  "/leave_assignment/calculate-carryforward/:employeeNumber/:leave_code",
  requireSelfOrAdmin('employeeNumber'),
  async (req, res) => {
    const { employeeNumber, leave_code } = req.params;
    const { period_year, period_month } = req.query;
    const targetYear = period_year ? parseInt(period_year, 10) : new Date().getFullYear();
    const targetMonth =
      period_month != null && String(period_month).trim() !== ""
        ? parseInt(period_month, 10)
        : null;

    try {
      const suggestedCarryForward = await getPriorPeriodCarryForwardHoursForEmployee(
        db,
        employeeNumber,
        leave_code,
        targetYear,
        targetMonth,
      );
      res.json({
        hasHistory: suggestedCarryForward > 0,
        suggestedCarryForward,
        previousPeriod: null,
      });
    } catch (err) {
      console.error("[GET calculate-carryforward]", err.message);
      res.status(500).json({ error: "Failed to calculate carry forward" });
    }
  },
);

router.post("/leave_assignment", requireAdmin, async (req, res) => {
  const {
    employeeNumber,
    leave_code,
    total_hours,
    allocated_hours,
    period_year,
    period_semester,
  } = req.body;

  const currentYear = period_year || new Date().getFullYear();
  const semester = period_semester ?? null;
  const semNum = semester != null && String(semester).trim() !== ""
    ? parseInt(String(semester), 10)
    : null;
  const targetMonth = Number.isFinite(semNum) && semNum > 0 ? semNum : null;

  const queryAsync = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    const genderBlockMsg = await checkGenderRestriction(employeeNumber, leave_code);
    if (genderBlockMsg) {
      return res.status(400).json({ error: genderBlockMsg });
    }

    const existing = await queryAsync(
  "SELECT id FROM leave_assignment WHERE employeeNumber = ? AND leave_code = ? AND period_year = ? AND period_semester <=> ? AND voided_at IS NULL",
  [employeeNumber, leave_code, currentYear, semester],
);
if (existing.length > 0) {
  return res.status(400).json({
    error: "This employee already has an assignment for this leave type and period",
  });
}

    const openingBalance = await getPriorPeriodCarryForwardHoursForEmployee(
      db,
      employeeNumber,
      leave_code,
      currentYear,
      targetMonth,
    );

    let clientAllocated = null;
    const hasAllocated =
      allocated_hours !== undefined && allocated_hours !== null && allocated_hours !== "";
    const hasTotal =
      req.body.hasOwnProperty("total_hours") &&
      total_hours !== null &&
      total_hours !== undefined &&
      total_hours !== "";

    if (hasAllocated) {
      clientAllocated = Math.max(0, parseDbHours(allocated_hours));
    } else if (hasTotal) {
      clientAllocated = Math.max(0, parseDbHours(total_hours));
    }

    const fields = await buildNewPeriodAssignmentFields(db, {
      employeeNumber,
      leave_code,
      period_year: currentYear,
      period_semester: semester,
      allocated_hours: clientAllocated ?? openingBalance,
      used_hours: 0,
    });

    const insertResult = await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO leave_assignment
          (leave_code, employeeNumber, total_hours, remaining_hours, used_hours,
           approve_date, carried_forward_hours, allocated_hours, period_year, period_semester, earning_status)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          leave_code,
          employeeNumber,
          fields.total_hours,
          fields.remaining_hours,
          fields.used_hours,
          fields.carried_forward_hours,
          fields.allocated_hours,
          currentYear,
          semester,
          fields.earning_status,
        ],
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    });

    const insertedId = insertResult.insertId;
    const actorEmpNum = getActorEmployeeNumber(req, employeeNumber);
    try {
      const [empName, actorName] = await Promise.all([
        getEmployeeFullName(String(employeeNumber)),
        getEmployeeFullName(actorEmpNum),
      ]);
      const ltRows = await queryAsync(
        "SELECT leave_description FROM leave_table WHERE leave_code = ? LIMIT 1",
        [leave_code],
      );
      const leaveDesc = ltRows[0]?.leave_description || leave_code;
      const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
      const empDisplay = formatUserDisplayName(String(employeeNumber), empName);
      logAudit(
        { employeeNumber: actorEmpNum },
        `Assign Leave - ${leaveDesc} (${fields.allocated_hours} hrs)`,
        "leave_assignment",
        insertedId,
        employeeNumber,
      );
      await insertTransactionLog(
        String(employeeNumber),
        `${actorDisplay} assigned ${leaveDesc} (${fields.allocated_hours} hrs) to ${empDisplay}`,
        actorEmpNum,
      );
    } catch (e) {
      console.error("[leave] Assign log error:", e.message);
    }

    emitLeaveChange("leaveAssignmentChanged");
    res.json({
      id: insertedId,
      leave_code,
      employeeNumber,
      total_hours: fields.total_hours,
      remaining_hours: fields.remaining_hours,
      used_hours: fields.used_hours,
      approved_date: null,
      carried_forward_hours: fields.carried_forward_hours,
      allocated_hours: fields.allocated_hours,
      period_year: currentYear,
      period_semester: semester,
      earning_status: fields.earning_status,
    });
  } catch (err) {
    console.error("[POST leave_assignment]", err.message);
    logAudit(
      { employeeNumber: getActorEmployeeNumber(req, employeeNumber) },
      "Assign Leave Failed",
      "leave_assignment",
      null,
      employeeNumber,
    );
    res.status(500).json({ error: "Failed to create leave assignment: " + err.message });
  }
});

router.put("/leave_assignment/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    employeeNumber,
    leave_code,
    allocated_hours,
    period_year,
    period_semester,
  } = req.body;

  const queryAsync = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    const current = await queryAsync("SELECT * FROM leave_assignment WHERE id = ?", [id]);
    if (!current.length) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    const row = current[0];

    if (isCommutedLocked(row)) {
      return res.status(400).json({ error: "This assignment is commuted and cannot be modified" });
    }

    const newAllocated =
      allocated_hours !== undefined && allocated_hours !== ""
        ? parseDbHours(allocated_hours)
        : parseDbHours(row.allocated_hours);

    const currentUsed = parseDbHours(row.used_hours) || 0;
    const newYear = period_year !== undefined ? period_year : row.period_year;
    const newSemester =
      period_semester !== undefined ? period_semester : row.period_semester;

    let working = {
      ...row,
      employeeNumber: employeeNumber ?? row.employeeNumber,
      leave_code: leave_code ?? row.leave_code,
      allocated_hours: newAllocated,
      used_hours: currentUsed,
      period_year: newYear,
      period_semester: newSemester,
      carried_forward_hours: toNum(row.carried_forward_hours),
    };

    working = await repairPeriodCarryForwardIfEmpty(db, working);
    working.allocated_hours = Math.max(toNum(working.allocated_hours), newAllocated);

    const recomputed = await recomputeAssignmentLedgerFields(db, working, currentUsed);

    await queryAsync(
      `UPDATE leave_assignment SET
         leave_code = ?, employeeNumber = ?, total_hours = ?, remaining_hours = ?,
         used_hours = ?, carried_forward_hours = ?, allocated_hours = ?,
         period_year = ?, period_semester = ?, earning_status = ?
       WHERE id = ?`,
      [
        working.leave_code,
        working.employeeNumber,
        recomputed.total_hours,
        recomputed.remaining_hours,
        recomputed.used_hours,
        recomputed.carried_forward_hours,
        recomputed.allocated_hours,
        newYear,
        newSemester,
        recomputed.earning_status,
        id,
      ],
    );

    const actorEmpNum = getActorEmployeeNumber(req);
try {
      const [empName, actorName] = await Promise.all([
        getEmployeeFullName(String(working.employeeNumber)),
        getEmployeeFullName(actorEmpNum),
      ]);
      const ltRows = await queryAsync(
        "SELECT leave_description FROM leave_table WHERE leave_code = ? LIMIT 1",
        [working.leave_code],
      );
      const leaveDesc = ltRows[0]?.leave_description || working.leave_code;
      const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
      const empDisplay = formatUserDisplayName(String(working.employeeNumber), empName);

      // Capture before/after for the transaction log
      const beforeRemaining = parseDbHours(row.remaining_hours);
      const afterRemaining = recomputed.remaining_hours;
      const beforeAllocated = parseDbHours(row.allocated_hours);
      const afterAllocated = recomputed.allocated_hours;
      const deltaHrs = afterRemaining - beforeRemaining;
      const sign = deltaHrs >= 0 ? "+" : "−";
      const balanceSuffix = ` Balance updated: ${beforeRemaining.toFixed(3)} hrs → ${afterRemaining.toFixed(3)} hrs (${sign}${Math.abs(deltaHrs).toFixed(3)} hrs).`;

      logAudit(
        { employeeNumber: actorEmpNum },
        `Update Leave Assignment - ${leaveDesc} (${recomputed.allocated_hours} hrs)`,
        "leave_assignment",
        id,
        working.employeeNumber,
      );
      await insertTransactionLog(
        String(working.employeeNumber),
        `${actorDisplay} updated ${leaveDesc} assignment for ${empDisplay} (allocated: ${beforeAllocated.toFixed(3)} hrs → ${afterAllocated.toFixed(3)} hrs).${balanceSuffix}`,
        actorEmpNum,
      );
    } catch (e) {
      console.error("[leave] Update assignment log error:", e.message);
    }

    emitLeaveChange("leaveAssignmentChanged");
    res.json({
      id,
      leave_code: working.leave_code,
      employeeNumber: working.employeeNumber,
      total_hours: recomputed.total_hours,
      remaining_hours: recomputed.remaining_hours,
      used_hours: recomputed.used_hours,
      carried_forward_hours: 0,
      allocated_hours: recomputed.allocated_hours,
      period_year: newYear,
      period_semester: newSemester,
      earning_status: recomputed.earning_status,
    });
  } catch (err) {
    console.error("[PUT leave_assignment]", err.message);
    logAudit(
      { employeeNumber: getActorEmployeeNumber(req) },
      "Update Leave Assignment Failed",
      "leave_assignment",
      id,
      employeeNumber,
    );
    res.status(500).json({ error: "Failed to update leave assignment" });
  }
});

router.delete("/leave_assignment/:id", requireAdmin, (req, res) => {
  const actorEmpNum = getActorEmployeeNumber(req);
  // Fetch first so we have employee info for logging
  db.query(
    "SELECT employeeNumber, leave_code FROM leave_assignment WHERE id = ?",
    [req.params.id],
    (fetchErr, rows) => {
      const targetRecord = (!fetchErr && rows && rows[0]) ? rows[0] : null;
      db.query(
        "DELETE FROM leave_assignment WHERE id = ?",
        [req.params.id],
        (err) => {
          if (err) {
            if (targetRecord) logAudit({ employeeNumber: actorEmpNum }, 'Delete Leave Assignment Failed', 'leave_assignment', req.params.id, targetRecord.employeeNumber);
            return res
              .status(500)
              .json({ error: "Failed to delete leave assignment" });
          }
          if (targetRecord) {
            (async () => {
              try {
                const [empName, actorName] = await Promise.all([
                  getEmployeeFullName(String(targetRecord.employeeNumber)),
                  getEmployeeFullName(actorEmpNum),
                ]);
                const leaveDesc = await new Promise(resolve =>
                  db.query('SELECT leave_description FROM leave_table WHERE leave_code = ? LIMIT 1', [targetRecord.leave_code], (e, r) =>
                    resolve((r && r[0] && r[0].leave_description) || targetRecord.leave_code)
                  )
                );
                const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
                const empDisplay = formatUserDisplayName(String(targetRecord.employeeNumber), empName);
                logAudit({ employeeNumber: actorEmpNum }, `Delete Leave Assignment - ${leaveDesc}`, 'leave_assignment', req.params.id, targetRecord.employeeNumber);
                await insertTransactionLog(String(targetRecord.employeeNumber), `${actorDisplay} deleted ${leaveDesc} assignment for ${empDisplay}`, actorEmpNum);
              } catch (e) { console.error('[leave] Delete assignment log error:', e.message); }
            })();
          }
          emitLeaveChange("leaveAssignmentChanged");
          res.json({ message: "Leave assignment deleted successfully" });
        },
      );
    },
  );
});

// ─── GET /leave_assignment/period-history ─────────────────────────────────────
router.get("/leave_assignment/period-history", requireAdmin, async (req, res) => {
  const emp = String(req.query.employeeNumber || "").trim();
  const leaveCode = String(req.query.leave_code || "").trim();
  const py = req.query.period_year;
  const semRaw = req.query.period_semester ?? req.query.period_month;

  if (!emp || !leaveCode || py == null || String(py).trim() === "") {
    return res.status(400).json({ error: "employeeNumber, leave_code, and period_year are required" });
  }

  const sem =
    semRaw != null && String(semRaw).trim() !== ""
      ? (/^\d+$/.test(String(semRaw).trim()) ? parseInt(String(semRaw), 10) : semRaw)
      : null;

  try {
    const history = await loadLeavePeriodHistoryAsync(db, emp, leaveCode, py, sem);
    res.json(history);
  } catch (e) {
    console.error("[leave] period-history:", e.message);
    res.status(500).json({ error: e.message || "Failed to load period transaction record" });
  }
});

// ─── DELETE /leave_assignment/:id/void-period ───────────────────────────────
// Soft-void current period assignment + matching leave_earnings + credit usage.
router.delete("/leave_assignment/:id/void-period", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const queryAsync = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

  try {
    const seedRows = await queryAsync("SELECT * FROM leave_assignment WHERE id = ? LIMIT 1", [id]);
    const seed = seedRows[0];
    if (!seed) {
      return res.status(404).json({ error: "Leave assignment period not found" });
    }

    let rec = seed.voided_at ? null : seed;
    if (!rec) {
      const latestRows = await queryAsync(
        `SELECT * FROM leave_assignment
         WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)
           AND period_year <=> ? AND period_semester <=> ?
         ORDER BY id DESC LIMIT 1`,
        [seed.employeeNumber, seed.leave_code, seed.period_year, seed.period_semester],
      );
      if (latestRows[0] && !latestRows[0].voided_at) rec = latestRows[0];
    }
    if (!rec) {
      return res.status(404).json({ error: "Period not found or already voided" });
    }

    if (isCommutedLocked(rec)) {
      return res.status(400).json({ error: "Cannot void a commuted period" });
    }
    if (isPeriodVoided(rec)) {
      return res.status(400).json({ error: "Period is already voided" });
    }

    const allRows = (await queryAsync(
      `SELECT * FROM leave_assignment WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)`,
      [rec.employeeNumber, rec.leave_code],
    )).map(normalizeAssignmentRow);

    const currentCheck = assertPeriodIsCurrentDisplay(rec, allRows);
    if (!currentCheck.ok) {
      return res.status(400).json({ error: currentCheck.error });
    }

    const voidId = rec.id;
    const emp = String(rec.employeeNumber || "").trim();
    const leaveCode = String(rec.leave_code || "").trim();
    const py = rec.period_year;
    const sem = rec.period_semester ?? rec.period_month;
    const semPad = sem != null ? String(sem).padStart(2, "0") : null;
    const beforeRemaining = toNum(rec.remaining_hours);

    const conn = await getPromiseConnection();
    try {
      await conn.beginTransaction();

      const [voidAssignResult] = await conn.execute(
        `UPDATE leave_assignment SET voided_at = NOW()
         WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)
           AND period_year <=> ? AND period_semester <=> ?
           AND voided_at IS NULL`,
        [emp, leaveCode, py, sem],
      );
      if (!voidAssignResult.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: "Period not found or already voided" });
      }

      await conn.execute(
        `UPDATE leave_earnings SET voided_at = NOW(), voided = 1, is_applied = 0
         WHERE employee_number = ? AND TRIM(leave_code) = TRIM(?)
           AND voided_at IS NULL
           AND period_year <=> ?
           AND (period_month = ? OR period_month = ? OR (? IS NULL AND period_month IS NULL))`,
        [emp, leaveCode, py, sem, semPad, sem],
      );

      const assignIds = allRows
        .filter((a) => String(a.period_year) === String(py)
          && String(a.period_semester ?? a.period_month) === String(sem ?? ""))
        .map((a) => a.id)
        .filter((aid) => aid != null);

      if (assignIds.length) {
        await conn.execute(
          `UPDATE leave_credit_usage SET voided_at = NOW()
           WHERE leave_assignment_id IN (${assignIds.map(() => "?").join(",")}) AND voided_at IS NULL`,
          assignIds,
        );
      }

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    const actorEmpNum = getActorEmployeeNumber(req);
    try {
      const [empName, actorName, leaveDesc] = await Promise.all([
        getEmployeeFullName(emp),
        getEmployeeFullName(actorEmpNum),
        new Promise((resolve) =>
          db.query(
            "SELECT leave_description FROM leave_table WHERE leave_code = ? LIMIT 1",
            [leaveCode],
            (e, r) => resolve((r && r[0] && r[0].leave_description) || leaveCode),
          ),
        ),
      ]);
      const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
      const empDisplay = formatUserDisplayName(emp, empName);
      const periodLbl = `${py}${sem != null ? ` / ${sem}` : ""}`;
      logAudit(
        { employeeNumber: actorEmpNum },
        `Void Leave Assignment Period - ${leaveDesc}`,
        "leave_assignment",
        voidId,
        emp,
      );
      await insertTransactionLog(
        String(emp),
        `${actorDisplay} voided ${leaveDesc} period ${periodLbl} for ${empDisplay} (prior remaining ${beforeRemaining.toFixed(3)} hrs).`,
        actorEmpNum,
      );
    } catch (e) {
      console.error("[leave] void-period audit:", e.message);
    }

    emitLeaveChange("leaveAssignmentChanged");
    res.json({
      message: "Period voided",
      id: voidId,
      employeeNumber: emp,
      leave_code: leaveCode,
    });
  } catch (e) {
    console.error("[leave] void-period:", e.message);
    res.status(500).json({ error: e.message || "Failed to void period" });
  }
});

// ============================================
// LEAVE REQUESTS
// ============================================
router.get("/leave_request", requireAdmin, (req, res) => {
  const query = `
    SELECT lr.*, lt.leave_description, p.firstName, p.lastName,
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) as fullName,
      DATE_FORMAT(lr.leave_date, '%Y-%m-%d') as leave_date,
      DATE_FORMAT(lr.created_at, '%Y-%m-%d %H:%i:%s') as created_at
    FROM leave_request lr
    LEFT JOIN leave_table lt ON lr.leave_code = lt.leave_code
    LEFT JOIN person_table p ON lr.employeeNumber = p.agencyEmployeeNum
    ORDER BY lr.created_at DESC
  `;
  db.query(query, (err, results) => {
    if (err)
      return res.status(500).json({ error: "Failed to fetch leave requests" });
    res.json(results);
  });
});

router.get("/leave_request/transactions", requireAdmin, (req, res) => {
  const query = `
    SELECT *
    FROM transaction_table
    ORDER BY id ASC
  `;
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching all transaction logs:", err);
      return res.status(500).json({ error: "Failed to fetch transaction logs" });
    }
    res.json(results);
  });
});

// HR: employment category hours/day for leave deduction (LeaveRequest.jsx modal).
router.post("/leave_request/deduction-suggestion", requireAdmin, (req, res) => {
  const {
    employeeNumber,
    leave_code,
    leave_date = null,
    has_leave_form = true,
    is_half_day_absence = false,
    requested_rate_decimal = null,
  } = req.body || {};

  if (!employeeNumber) {
    return res.status(400).json({ error: "employeeNumber is required" });
  }
  if (has_leave_form !== false && !leave_code) {
    return res
      .status(400)
      .json({ error: "leave_code is required when has_leave_form is true" });
  }

  (async () => {
    try {
      if (Boolean(is_half_day_absence)) {
        const suggestion = await buildHalfDayPolicySuggestion({
          employeeNumber,
          leave_date,
        });
        return res.json(suggestion);
      }
      const suggestion = await buildDeductionSuggestion({
        employeeNumber,
        leave_code,
        leave_date,
        has_leave_form,
        is_half_day_absence,
        requested_rate_decimal,
      });
      res.json(suggestion);
    } catch (e) {
      console.error("[deduction-suggestion]", e.message);
      res.status(500).json({ error: "Failed to compute deduction suggestion" });
    }
  })();
});

router.post("/leave_request/halfday-deduction-suggestion", requireAdmin, (req, res) => {
  const { employeeNumber, leave_date, preferred_charge_to = null } = req.body || {};
  if (!employeeNumber || !leave_date) {
    return res
      .status(400)
      .json({ error: "employeeNumber and leave_date are required" });
  }
  (async () => {
    try {
      const suggestion = await buildHalfDayPolicySuggestion({
        employeeNumber,
        leave_date,
        preferred_charge_to,
      });
      res.json(suggestion);
    } catch (e) {
      console.error("[halfday-deduction-suggestion]", e.message);
      res.status(500).json({ error: "Failed to compute half-day deduction suggestion" });
    }
  })();
});

// Fetch already-applied half-day deductions (used to disable duplicate UI actions after reload)
router.post("/leave_request/halfday-deduction-applied-dates", requireAdmin, (req, res) => {
  const { employeeNumber, leave_code = "VL", startDate, endDate } = req.body || {};
  if (!employeeNumber || !startDate || !endDate) {
    return res.status(400).json({
      error: "employeeNumber, startDate, and endDate are required",
    });
  }

  (async () => {
    try {
      const dates = await getHalfDayDeductionAppliedDates({
        employeeNumber,
        leave_code,
        startDate,
        endDate,
        decisionSource: "half_day_policy_manual_apply",
      });
      res.json({ dates });
    } catch (e) {
      console.error("[halfday-deduction-applied-dates]", e.message);
      res.status(500).json({ error: "Failed to fetch applied half-day dates" });
    }
  })();
});

router.post("/leave_request/halfday-deduction-apply", requireAdmin, (req, res) => {
  const {
    employeeNumber,
    leave_date,
    chosen_charge_to,
    rate_decimal,
    deduction_hours,
    decision_context = {},
  } = req.body || {};
  const actorEmployeeNumber = getActorEmployeeNumber(req);
  if (!employeeNumber || !leave_date || !chosen_charge_to) {
    return res.status(400).json({
      error: "employeeNumber, leave_date, and chosen_charge_to are required",
    });
  }

  (async () => {
    try {
      const leaveDateNorm = String(leave_date).trim().slice(0, 10);
      const attendanceRows = await new Promise((resolve, reject) => {
        db.query(
          `SELECT half_day_review
           FROM overall_attendance_record
           WHERE CAST(personID AS CHAR) = CAST(? AS CHAR)
             AND startDate <= ?
             AND endDate >= ?
           ORDER BY startDate DESC
           LIMIT 1`,
          [employeeNumber, leaveDateNorm, leaveDateNorm],
          (err, rows) => (err ? reject(err) : resolve(rows || [])),
        );
      });
      const reviewRaw = attendanceRows[0]?.half_day_review;
      if (!isApprovedHalfDayInReviewJson(reviewRaw, leaveDateNorm)) {
        return res.status(400).json({
          error:
            "Half-day leave deduction requires HR approval in the attendance module (rendered hours confirmed).",
        });
      }

      const suggestion = await buildHalfDayPolicySuggestion({
        employeeNumber,
        leave_date,
        preferred_charge_to: chosen_charge_to,
      });
      const chargeTo = String(chosen_charge_to || "").trim().toUpperCase();
      if (!suggestion.allowed_charge_to.includes(chargeTo)) {
        return res.status(400).json({
          error: `Invalid charge_to for half-day policy. Allowed: ${suggestion.allowed_charge_to.join(", ")}`,
        });
      }

      // Prevent duplicates even if the UI state resets after reload.
      // We consider duplicates as any prior accepted/overridden half-day policy apply for the same employee/date/leave_code.
      const alreadyAppliedLogs = await getHalfDayDeductionAppliedLogs({
        employeeNumber,
        leave_code: chargeTo,
        leave_date,
        decisionSource: "half_day_policy_manual_apply",
      });
      if (alreadyAppliedLogs.length > 0) {
        await insertDeductionDecisionLog({
          leaveRequestId: suggestion?.filed_leave_request?.id || null,
          employeeNumber,
          leave_code: chargeTo,
          leave_date,
          decision: "duplicate_rejected",
          decisionSource: "half_day_policy_manual_apply",
          actorEmployeeNumber,
          systemRecommendation: suggestion,
          finalApplied: {
            charge_to: chargeTo,
            attempted_rate_decimal: rate_decimal,
            attempted_deduction_hours: deduction_hours,
            available_hours_before: Number(suggestion.available_hours || 0),
            hours_per_day: Number(suggestion.hours_per_day || 8),
            has_leave_form: suggestion.has_leave_form,
            duplicate_check: {
              already_applied_count: alreadyAppliedLogs.length,
              existing_decisions: alreadyAppliedLogs.map((r) => r?.decision).filter(Boolean),
            },
          },
          overrideReason: null,
        });

        return res.status(400).json({
          error: "This half-day is already deducted.",
          already_applied: alreadyAppliedLogs,
        });
      }

      if (chargeTo !== DEDUCTION_SALARY && !suggestion.has_sufficient_balance) {
        return res.status(400).json({
          error: `Insufficient ${chargeTo} balance for half-day deduction`,
          suggestion,
        });
      }

      const inputHours = parseFloat(deduction_hours);
      const inputRate = parseFloat(rate_decimal);
      const effectiveHoursPerDay = Number(suggestion.hours_per_day || 8);
      const hours = Number.isFinite(inputHours) && inputHours > 0
        ? Number(inputHours.toFixed(4))
        : Number.isFinite(inputRate) && inputRate > 0
          ? Number((inputRate * effectiveHoursPerDay).toFixed(4))
          : Number(suggestion.recommended_hours || 0);
      if (!(Number.isFinite(hours) && hours > 0)) {
        return res.status(400).json({
          error: "A positive rate_decimal and/or deduction_hours is required",
        });
      }
      const appliedRate = Number((hours / (effectiveHoursPerDay || 8)).toFixed(3));
      const availableBefore = Number(suggestion.available_hours || 0);
      if (chargeTo !== DEDUCTION_SALARY && availableBefore < hours) {
        return res.status(400).json({
          error: `Insufficient ${chargeTo} balance for ${hours} hours deduction`,
          suggestion,
        });
      }
      let availableAfter = availableBefore;
      const leaveDateOnly = toMysqlDateOnly(leave_date);
      let ctoHalfDayLedger = null;

      if (chargeTo === DEDUCTION_SALARY) {
        const overrideReason = String(decision_context?.override_reason || "").trim() || null;
        const systemRecommendation = decision_context?.system_recommendation || suggestion;
        const decision =
          overrideReason ||
          String(systemRecommendation?.recommended_charge_to || "").toUpperCase() !== chargeTo
            ? "overridden"
            : "accepted";

        const decisionLogId = await insertDeductionDecisionLog({
          leaveRequestId: suggestion?.filed_leave_request?.id || null,
          employeeNumber,
          leave_code: chargeTo,
          leave_date,
          decision,
          decisionSource: "half_day_policy_manual_apply",
          actorEmployeeNumber,
          systemRecommendation,
          finalApplied: {
            charge_to: chargeTo,
            applied_rate_decimal: appliedRate,
            applied_hours: hours,
            requested_rate_decimal: rate_decimal,
            requested_deduction_hours: deduction_hours,
            effective_hours_per_day: effectiveHoursPerDay,
            available_hours_before: availableBefore,
            available_hours_after: availableBefore,
            has_leave_form: suggestion.has_leave_form,
            salary_deduction: true,
          },
          overrideReason,
        });

        const [empName, actorName] = await Promise.all([
          getEmployeeFullName(String(employeeNumber)),
          getEmployeeFullName(actorEmployeeNumber),
        ]);
        const actorDisplay = formatUserDisplayName(actorEmployeeNumber, actorName);
        const empDisplay = formatUserDisplayName(String(employeeNumber), empName);
        const txMsg = `${actorDisplay} recorded half-day as salary deduction (${hours} hrs policy equivalent) for ${empDisplay} (${leaveDateOnly}). Balance unchanged (salary deduction).`;
        await insertTransactionLog(String(employeeNumber), txMsg, actorEmployeeNumber, {
          deduction_decision_log_id: decisionLogId,
          charge_to: chargeTo,
          deducted_hours: hours,
          leave_date: leaveDateOnly,
          salary_deduction: true,
        });

        await insertLeaveSalaryShortfallForHalfDaySalary({
          employeeNumber,
          leaveDateOnly,
          shortfallDaysDecimal: appliedRate,
          shortfallHours: hours,
          decisionLogId,
        });

        try {
          await attendanceWriter.upsertFromHalfDaySalary({
            employee_number: String(employeeNumber),
            leave_date_only: leaveDateOnly,
            hours,
            deduction_decision_log_id: decisionLogId,
            remarks: `Half-day salary (policy ref #${decisionLogId})`,
          });
        } catch (e) {
          console.error("[leave] attendance_result (half-day salary):", e.message);
        }

        return res.json({
          message: "Half-day recorded as salary deduction (no leave credits posted).",
          employeeNumber,
          leave_date: leaveDateOnly,
          charge_to: chargeTo,
          deducted_hours: hours,
        });
      }

      if (chargeTo === "CTO") {
        const y = parseInt(String(leaveDateOnly).slice(0, 4), 10);
        const m = parseInt(String(leaveDateOnly).slice(5, 7), 10);
        if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
          return res.status(400).json({ error: "Invalid leave_date for CTO ledger period" });
        }
        const baseRemark = `Half-day policy · ${leaveDateOnly}`;
        ctoHalfDayLedger = await appendCtoDeductionSnapshotRowAsync({
          employeeNumber,
          needHours: hours,
          period_year: y,
          period_month: m,
          expiry_date: null,
          remarksForLedger: baseRemark,
          emp_category_snapshot: null,
          usageDateUsed: leaveDateOnly,
          usageAction: "offset",
        });
        if (
          !Number.isFinite(ctoHalfDayLedger?.deducted) ||
          ctoHalfDayLedger.deducted + 1e-6 < hours
        ) {
          return res.status(400).json({
            error: "CTO deduction failed due to insufficient remaining credits",
          });
        }
        availableAfter = await getCtoRemainingHours(employeeNumber);
      } else if (chargeTo === "SC") {
        await applyHoursDeltaAcrossServiceCredit({
          req,
          actorEmployeeNumber,
          employeeNumber,
          deltaHours: hours,
          leaveDateOnly,
          requestId: null,
          reason: `Half-day policy deduction (SC) — deducted ${hours} hours`,
          scType: "non_commutative",
        });
        availableAfter = await getScRemainingHoursAllTypes(employeeNumber);
      } else {
        await applyHoursDeltaAcrossAssignments({
          req,
          actorEmployeeNumber,
          employeeNumber,
          leave_code: chargeTo,
          deltaHours: hours,
          requestId: null,
          reason: `Half-day policy deduction (${chargeTo}) — deducted ${hours} hours`,
          sourceType: "HALF_DAY_POLICY",
        });
        availableAfter = await getTotalRemainingHours(employeeNumber, chargeTo);
      }

      const overrideReason = String(decision_context?.override_reason || "").trim() || null;
      const systemRecommendation = decision_context?.system_recommendation || suggestion;
      const decision =
        overrideReason ||
        String(systemRecommendation?.recommended_charge_to || "").toUpperCase() !== chargeTo
          ? "overridden"
          : "accepted";

      const decisionLogId = await insertDeductionDecisionLog({
        leaveRequestId: suggestion?.filed_leave_request?.id || null,
        employeeNumber,
        leave_code: chargeTo,
        leave_date,
        decision,
        decisionSource: "half_day_policy_manual_apply",
        actorEmployeeNumber,
        systemRecommendation,
        finalApplied: {
          charge_to: chargeTo,
          applied_rate_decimal: appliedRate,
          applied_hours: hours,
          requested_rate_decimal: rate_decimal,
          requested_deduction_hours: deduction_hours,
          effective_hours_per_day: effectiveHoursPerDay,
          available_hours_before: availableBefore,
          available_hours_after: Number((availableAfter || 0).toFixed(4)),
          has_leave_form: suggestion.has_leave_form,
          ...(ctoHalfDayLedger?.newCtoCreditId
            ? {
                cto_credit_id: ctoHalfDayLedger.newCtoCreditId,
                cto_usage_id: ctoHalfDayLedger.usageId,
              }
            : {}),
        },
        overrideReason,
      });

      if (
        chargeTo === "CTO" &&
        decisionLogId &&
        ctoHalfDayLedger?.usageId &&
        ctoHalfDayLedger?.newCtoCreditId
      ) {
        const rmk = `Half-day policy · ${leaveDateOnly} · deduction_decision_log #${decisionLogId}`;
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE cto_usage SET remarks = ? WHERE id = ?`,
            [rmk, ctoHalfDayLedger.usageId],
            (e) => (e ? reject(e) : resolve()),
          );
        });
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE cto_credit SET remarks = ? WHERE id = ?`,
            [rmk, ctoHalfDayLedger.newCtoCreditId],
            (e) => (e ? reject(e) : resolve()),
          );
        });
      }

      const [empName, actorName] = await Promise.all([
        getEmployeeFullName(String(employeeNumber)),
        getEmployeeFullName(actorEmployeeNumber),
      ]);
      const actorDisplay = formatUserDisplayName(actorEmployeeNumber, actorName);
      const empDisplay = formatUserDisplayName(String(employeeNumber), empName);
      const beforeH = Number(availableBefore || 0);
      const afterH = Number(availableAfter || 0);
      const txMsg = `${actorDisplay} applied half-day deduction of ${hours} hrs to ${chargeTo} for ${empDisplay} (${leaveDateOnly}). Balance updated: ${beforeH.toFixed(3)} hrs → ${afterH.toFixed(3)} hrs (−${Number(hours).toFixed(3)} hrs).`;
      await insertTransactionLog(String(employeeNumber), txMsg, actorEmployeeNumber, {
        deduction_decision_log_id: decisionLogId,
        charge_to: chargeTo,
        deducted_hours: hours,
        leave_date: leaveDateOnly,
        salary_deduction: false,
        available_hours_after: Number((availableAfter || 0).toFixed(4)),
      });

      try {
        await attendanceWriter.upsertFromHalfDayLeaveCovered({
          employee_number: String(employeeNumber),
          leave_date_only: leaveDateOnly,
          hours,
          charge_to: chargeTo,
          deduction_decision_log_id: decisionLogId,
          remarks: `Half-day leave-covered (policy ref #${decisionLogId})`,
        });
      } catch (e) {
        console.error("[leave] attendance_result (half-day leave):", e.message);
      }

      emitLeaveChange("leaveAssignmentChanged");
      res.json({
        message: "Half-day deduction applied successfully",
        employeeNumber,
        leave_date: leaveDateOnly,
        charge_to: chargeTo,
        deducted_hours: hours,
      });
    } catch (e) {
      console.error("[halfday-deduction-apply]", e);
      res.status(500).json({ error: e.message || "Half-day deduction apply failed" });
    }
  })();
});

// HR: employment category hours/day for leave deduction (LeaveRequest.jsx modal).
router.post("/leave_request/hr-deduction-context", requireAdmin, (req, res) => {
  const { employeeNumber, leave_code, leave_date = null } = req.body || {};
  if (!employeeNumber || !leave_code) {
    return res
      .status(400)
      .json({ error: "employeeNumber and leave_code are required" });
  }
  (async () => {
    try {
      const meta = await fetchLeaveDeductionMeta(employeeNumber, leave_code, leave_date);
      const { hoursPerDay, rateSource } = resolveHoursPerDayFromMeta(meta);
      res.json({
        hoursPerDay,
        rateSource,
        employmentTypeName: meta.employment_type_name || null,
      });
    } catch (e) {
      console.error("[hr-deduction-context]", e.message);
      res.status(500).json({ error: "Failed to load deduction context" });
    }
  })();
});

router.get("/leave_request/:employeeNumber", requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const query = `
    SELECT lr.*, lt.leave_description,
      DATE_FORMAT(lr.leave_date, '%Y-%m-%d') as leave_date,
      DATE_FORMAT(lr.created_at, '%Y-%m-%d %H:%i:%s') as created_at
    FROM leave_request lr
    LEFT JOIN leave_table lt ON lr.leave_code = lt.leave_code
    WHERE lr.employeeNumber = ?
    ORDER BY lr.created_at DESC
  `;
  db.query(query, [req.params.employeeNumber], (err, results) => {
    if (err)
      return res.status(500).json({ error: "Failed to fetch leave requests" });
    res.json(results);
  });
});

router.get("/leave_request/transactions/:employeeNumber", requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const query = `
    SELECT *
    FROM transaction_table
    WHERE employee_id = ?
    ORDER BY id ASC
  `;
  db.query(query, [req.params.employeeNumber], (err, results) => {
    if (err) {
      console.error("Error fetching transaction logs:", err);
      return res.status(500).json({ error: "Failed to fetch transaction logs" });
    }
    res.json(results);
  });
});

// ============================================================
// POST /leave_request
//
// RULES:
//  1. Each requested date = 8 hours (for HR deduction workflows).
//  2. Employees may file even with low/zero balance; HR approves or denies
//     and applies deductions via the admin leave flow.
// ============================================================
router.post("/leave_request", (req, res) => {
  const { employeeNumber, leave_code, leave_dates } = req.body;
  let status = req.body.status;
  const actorEmployeeNumber = getActorEmployeeNumber(req, employeeNumber);
  const dates = Array.isArray(leave_dates) ? leave_dates : [leave_dates];

  // Only HR/admin roles may file a request on behalf of someone else or preset its
  // status; a regular employee session may only file for themselves, starting at
  // "submitted" (0) — the approval workflow (PUT /leave_request/:id) is the only
  // path allowed to advance status from there.
  const callerRole = String(req.user?.role || "").toLowerCase();
  const callerIsAdmin = ["admin", "administrator", "superadmin", "technical"].includes(callerRole);
  if (!callerIsAdmin) {
    const callerEmployeeNumber = String(actorEmployeeNumber || "").trim();
    const targetEmployeeNumber = String(employeeNumber || "").trim();
    if (!callerEmployeeNumber || !targetEmployeeNumber || callerEmployeeNumber !== targetEmployeeNumber) {
      return res.status(403).json({ error: "You may only file a leave request for yourself." });
    }
    status = 0;
  }

  if (!dates.length)
    return res
      .status(400)
      .json({ error: "At least one leave date is required" });

  const proceed = async () => {
    const genderBlockMsg = await checkGenderRestriction(employeeNumber, leave_code);
    if (genderBlockMsg) {
      return res.status(400).json({ error: genderBlockMsg });
    }

    // ── INSERT all leave request rows ──────────────────────────
    const insertPromises = dates.map(
      (date) =>
        new Promise((resolve, reject) => {
          db.query(
            "INSERT INTO leave_request (employeeNumber, leave_code, leave_date, status, created_at) VALUES (?, ?, ?, ?, NOW())",
            [employeeNumber, leave_code, date, status || 0],
            (err, result) => (err ? reject(err) : resolve(result)),
          );
        }),
    );

    Promise.all(insertPromises)
.then(() => {
  db.query(
    "SELECT leave_description FROM leave_table WHERE TRIM(leave_code) = TRIM(?) LIMIT 1",
    [leave_code],
    async (err, leaveTypeRows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Leave type lookup failed" });
      }

      const leave_description =
        (leaveTypeRows &&
          leaveTypeRows[0] &&
          leaveTypeRows[0].leave_description) ||
        leave_code;

      const [actorFullName, requesterFullName] = await Promise.all([
        getEmployeeFullName(actorEmployeeNumber),
        getEmployeeFullName(employeeNumber),
      ]);

      const actorDisplayName = formatUserDisplayName(
        actorEmployeeNumber,
        actorFullName
      );
      const requesterDisplayName = formatUserDisplayName(
        employeeNumber,
        requesterFullName
      );

      const requestMessage = buildLeaveTransactionMessage({
        action: "request",
        actorDisplayName,
        requesterDisplayName,
        leaveDesc: leave_description,
        leaveDates: dates,
      });

      await insertTransactionLog(
        employeeNumber,
        requestMessage,
        actorEmployeeNumber
      );

      logAudit({ employeeNumber: actorEmployeeNumber }, `Submit Leave Request - ${leave_description} (${dates.length} day(s))`, 'leave_request', null, employeeNumber);
      emitLeaveChange("leaveRequestChanged");

      res.json({
        message: "Leave requests created successfully",
        count: dates.length,
      });
    }
  );
})
      .catch((err) => {
        console.error("Error creating leave requests:", err);
        logAudit({ employeeNumber: actorEmployeeNumber }, 'Submit Leave Request Failed', 'leave_request', null, employeeNumber);
        res.status(500).json({ error: "Failed to create leave requests" });
      });
  };
  proceed().catch((e) => {
    console.error("[leave_request] submit error:", e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to submit leave request" });
    }
  });
});

// ============================================================
// PUT /leave_request/bulk-update
//
// HR bulk approve (status 2): requires hr_approval_rate and/or deduction_hours_each
// in the body. Per row: hours = deduction_hours_each OR hr_approval_rate × hours/day.
// ============================================================
router.put("/leave_request/bulk-update", requireAdmin, (req, res) => {
  const {
    ids,
    status,
    hr_approval_rate,
    deduction_hours_each,
    charge_to,
    decision_context,
  } = req.body;
  const actorEmployeeNumber = getActorEmployeeNumber(req);
  if (!Array.isArray(ids) || !ids.length)
    return res.status(400).json({ error: "ids must be a non-empty array" });
  const newStatus = Number(status);
  if (![0, 1, 2, 3, 4].includes(newStatus))
    return res.status(400).json({ error: "Invalid status value" });

  const bulkRate = parseFloat(hr_approval_rate);
  const bulkHoursEach = parseFloat(deduction_hours_each);
  if (newStatus === 2) {
    const hasRate = Number.isFinite(bulkRate) && bulkRate > 0;
    const hasHours = Number.isFinite(bulkHoursEach) && bulkHoursEach > 0;
    if (!hasRate && !hasHours) {
      return res.status(400).json({
        error:
          "Bulk HR approval requires hr_approval_rate and/or deduction_hours_each in the request body.",
      });
    }
  }

  const placeholders = ids.map(() => "?").join(",");
  db.query(
    `SELECT lr.id, lr.employeeNumber, lr.leave_code, lr.leave_date, lr.status,
            lr.deduction_applied_hours, lt.leave_description
     FROM leave_request lr
     LEFT JOIN leave_table lt ON lr.leave_code = lt.leave_code
     WHERE lr.id IN (${placeholders})`,
    ids,
    (err, requests) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!requests.length)
        return res
          .status(404)
          .json({ error: "No leave requests found with provided IDs" });

      // Claim each row individually, guarded by ITS OWN current status, instead of one
      // blanket UPDATE across every id — this closes the race that let two overlapping
      // bulk/single approval calls both deduct or restore the same request twice, and
      // safely skips any row whose status already changed since the SELECT above (e.g. a
      // concurrent single-update on one of these same ids).
      const claimRow = (row) =>
        new Promise((resolve) => {
          db.query(
            "UPDATE leave_request SET status = ? WHERE id = ? AND status = ?",
            [newStatus, row.id, Number(row.status)],
            (claimErr, result) => {
              resolve(!claimErr && !!result && result.affectedRows === 1);
            },
          );
        });

      const revertRowClaim = (row) =>
        new Promise((resolve) => {
          db.query(
            "UPDATE leave_request SET status = ? WHERE id = ?",
            [Number(row.status), row.id],
            () => resolve(),
          );
        });

      (async () => {
        try {
          const claimedFlags = await Promise.all(requests.map(claimRow));
          const claimed = requests.filter((_, i) => claimedFlags[i]);
          const skippedIds = requests
            .filter((_, i) => !claimedFlags[i])
            .map((r) => r.id);
          const failedIds = [];

          const hasRate = Number.isFinite(bulkRate) && bulkRate > 0;
          const hasHours =
            Number.isFinite(bulkHoursEach) && bulkHoursEach > 0;

          if (newStatus === 2) {
            for (const reqRow of claimed) {
              const oldSt = Number(reqRow.status);
              if (oldSt === 2) continue;
              try {
                const rowSuggestion = await buildDeductionSuggestion({
                  employeeNumber: reqRow.employeeNumber,
                  leave_code: reqRow.leave_code,
                  leave_date: reqRow.leave_date,
                  has_leave_form: true,
                  is_half_day_absence: false,
                  requested_rate_decimal: hasRate ? bulkRate : null,
                });
                const chargeCode = resolveHrDeductionChargeCode({
                  charge_to,
                  decision_context,
                  requestLeaveCode: reqRow.leave_code,
                  systemRecommendation:
                    decision_context?.system_recommendation || rowSuggestion,
                });
                const availableBefore = await getTotalRemainingHours(
                  reqRow.employeeNumber,
                  chargeCode,
                );
                const meta = await fetchLeaveDeductionMeta(
                  reqRow.employeeNumber,
                  reqRow.leave_code,
                  reqRow.leave_date,
                );
                const { hoursPerDay } = resolveHoursPerDayFromMeta(meta);
                let delta;
                let storedRate;
                if (hasHours) {
                  delta = bulkHoursEach;
                  storedRate = hasRate
                    ? Number(bulkRate.toFixed(3))
                    : Number((delta / hoursPerDay).toFixed(3));
                } else {
                  delta = bulkRate * hoursPerDay;
                  storedRate = Number(bulkRate.toFixed(3));
                }
                await applyHoursDeltaAcrossAssignments({
                  req,
                  actorEmployeeNumber,
                  employeeNumber: reqRow.employeeNumber,
                  leave_code: chargeCode,
                  deltaHours: delta,
                  requestId: reqRow.id,
                  reason: `HR Approved (bulk) — deducted ${delta} hours from ${chargeCode}`,
                });
                const availableAfter = await getTotalRemainingHours(
                  reqRow.employeeNumber,
                  chargeCode,
                );
                await new Promise((resolve) => {
                  db.query(
                    `UPDATE leave_request SET deduction_applied_hours = ?, hr_approval_rate = ?, deduction_charge_to = ?, deduction_balance_before_hours = ?, deduction_balance_after_hours = ? WHERE id = ?`,
                    [
                      delta,
                      storedRate,
                      chargeCode,
                      Number(availableBefore.toFixed(4)),
                      Number(availableAfter.toFixed(4)),
                      reqRow.id,
                    ],
                    () => resolve(),
                  );
                });
                try {
                  await syncApprovedLeaveToAttendanceRecord(
                    reqRow.employeeNumber,
                    reqRow.leave_date,
                  );
                } catch (syncErr) {
                  console.error(
                    "[leave] bulk attendance sync:",
                    syncErr.message,
                  );
                }

                const fallbackSuggestion = await buildDeductionSuggestion({
                  employeeNumber: reqRow.employeeNumber,
                  leave_code: reqRow.leave_code,
                  leave_date: reqRow.leave_date,
                  has_leave_form: true,
                  is_half_day_absence: false,
                  requested_rate_decimal: storedRate,
                });
                const systemRecommendation =
                  decision_context?.system_recommendation || fallbackSuggestion;
                const overrideReason =
                  (decision_context?.override_reason || "").trim() || null;
                const decision =
                  overrideReason ||
                  !nearlyEqual(systemRecommendation?.recommended_hours, delta) ||
                  !nearlyEqual(
                    systemRecommendation?.recommended_rate_decimal,
                    storedRate,
                  )
                    ? "overridden"
                    : "accepted";
                await insertDeductionDecisionLog({
                  leaveRequestId: reqRow.id,
                  employeeNumber: reqRow.employeeNumber,
                  leave_code: reqRow.leave_code,
                  leave_date: reqRow.leave_date,
                  decision,
                  decisionSource: "hr_bulk_approval",
                  actorEmployeeNumber,
                  systemRecommendation,
                  finalApplied: {
                    applied_rate_decimal: storedRate,
                    applied_hours: delta,
                    charge_to: chargeCode,
                    request_leave_code: reqRow.leave_code,
                    available_hours_before: availableBefore,
                    available_hours_after: availableAfter,
                  },
                  overrideReason,
                });

                try {
                  const [empName, actorName] = await Promise.all([
                    getEmployeeFullName(String(reqRow.employeeNumber)),
                    getEmployeeFullName(actorEmployeeNumber),
                  ]);
                  const chargeDesc = await new Promise((resolve) =>
                    db.query(
                      "SELECT leave_description FROM leave_table WHERE TRIM(leave_code) = TRIM(?) LIMIT 1",
                      [chargeCode],
                      (e, r) =>
                        resolve(
                          (r && r[0] && r[0].leave_description) || chargeCode,
                        ),
                    ),
                  );
                  const actorDisplay = formatUserDisplayName(
                    actorEmployeeNumber,
                    actorName,
                  );
                  const empDisplay = formatUserDisplayName(
                    String(reqRow.employeeNumber),
                    empName,
                  );
                  const beforeH = Number(availableBefore || 0);
                  const afterH = Number(availableAfter || 0);
                  const txMsg = `${actorDisplay} deducted ${delta} hrs from ${chargeDesc} (${chargeCode}) balance for ${empDisplay} (HR bulk approval).${formatBalanceUpdatedSuffix(beforeH, afterH, delta)}`;
                  await insertTransactionLog(
                    String(reqRow.employeeNumber),
                    txMsg,
                    actorEmployeeNumber,
                    {
                      audit_action: "HR leave bulk approval deduction",
                      transaction_message: txMsg,
                      leave_request_id: reqRow.id,
                      request_leave_code: reqRow.leave_code,
                      charge_to: chargeCode,
                      deducted_hours: delta,
                      available_hours_before: beforeH,
                      available_hours_after: afterH,
                    },
                  );
                } catch (e) {
                  console.error(
                    "[leave] bulk HR deduction transaction log:",
                    e.message,
                  );
                }
              } catch (rowErr) {
                console.error(
                  `[bulk-update] deduction failed for request ${reqRow.id}:`,
                  rowErr.message,
                );
                await revertRowClaim(reqRow);
                failedIds.push(reqRow.id);
              }
            }
          } else if (newStatus === 3 || newStatus === 4) {
            for (const reqRow of claimed) {
              const oldSt = Number(reqRow.status);
              if (oldSt !== 2) continue;
              try {
                const applied = parseFloat(reqRow.deduction_applied_hours);
                const restoreAmt =
                  Number.isFinite(applied) && applied > 0 ? applied : 8;
                await applyHoursDeltaAcrossAssignments({
                  req,
                  actorEmployeeNumber,
                  employeeNumber: reqRow.employeeNumber,
                  leave_code: reqRow.leave_code,
                  deltaHours: -restoreAmt,
                  requestId: reqRow.id,
                  reason: `HR approval reversed (bulk) — restored ${restoreAmt} hours`,
                });
                await new Promise((resolve) => {
                  db.query(
                    `UPDATE leave_request SET deduction_applied_hours = NULL, hr_approval_rate = NULL WHERE id = ?`,
                    [reqRow.id],
                    () => resolve(),
                  );
                });
              } catch (rowErr) {
                console.error(
                  `[bulk-update] restore failed for request ${reqRow.id}:`,
                  rowErr.message,
                );
                await revertRowClaim(reqRow);
                failedIds.push(reqRow.id);
              }
            }
          }

          const action = statusToLeaveAction(newStatus);
          if (action && newStatus !== 2) {
            const actorFullName =
              await getEmployeeFullName(actorEmployeeNumber);
            const actorDisplayName = formatUserDisplayName(
              actorEmployeeNumber,
              actorFullName,
            );

            const nameCache = new Map();
            const getRequesterDisplayName = async (empNo) => {
              const key = String(empNo || "");
              if (nameCache.has(key)) return nameCache.get(key);
              const fullName = await getEmployeeFullName(empNo);
              const display = formatUserDisplayName(empNo, fullName);
              nameCache.set(key, display);
              return display;
            };

            await Promise.all(
              claimed
                .filter((request) => !failedIds.includes(request.id))
                .map(async (request) => {
                  const requesterDisplayName = await getRequesterDisplayName(
                    request.employeeNumber,
                  );
                  const message = buildLeaveTransactionMessage({
                    action,
                    actorDisplayName,
                    requesterDisplayName,
                    leaveDesc: request.leave_description,
                    leaveDates: request.leave_date,
                  });
                  return insertTransactionLog(
                    String(request.employeeNumber),
                    message,
                    actorEmployeeNumber,
                  );
                }),
            );
          }

          emitLeaveChange("leaveRequestChanged");
          emitLeaveChange("leaveAssignmentChanged");
          res.json({
            message: "Bulk update successful",
            updated: claimed.length - failedIds.length,
            newStatus,
            skipped_ids: skippedIds,
            failed_ids: failedIds,
          });
        } catch (e) {
          console.error("[bulk-update]", e);
          res
            .status(500)
            .json({ error: e.message || "Bulk update failed" });
        }
      })();
    },
  );
});

// ============================================================
// PUT /leave_request/:id
//
// Deducts / restores ONLY from the ALLOCATED row.
// ============================================================
router.put("/leave_request/:id", (req, res) => {
  const { id } = req.params;
  let {
    employeeNumber,
    leave_code,
    leave_date,
    status,
    deduction_hours,
    rate_decimal,
    charge_to,
    decision_context,
    denial_reason,
  } = req.body;
  const actorEmployeeNumber = getActorEmployeeNumber(req);

  db.query(
    "SELECT * FROM leave_request WHERE id = ?",
    [id],
    (err, currentReq) => {
      if (err)
        return res.status(500).json({ error: "Failed to fetch request" });
      if (!currentReq.length)
        return res.status(404).json({ error: "Leave request not found" });

      const request = currentReq[0];
      const oldStatus = parseInt(request.status);
      const newStatus = parseInt(status);

      // Identity of the request (whose it is, which leave type/date) is authoritative
      // from the DB row — never trust the client body for these, or a caller could
      // reassign an existing request to a different employee/leave type before
      // approving/denying/cancelling it.
      employeeNumber = request.employeeNumber;
      leave_code = request.leave_code;
      leave_date = toMysqlDateOnly(request.leave_date) || request.leave_date;

      // Only HR/admin may drive the approval workflow (submitted → supervisor →
      // HR, or deny). A plain employee session may only cancel their OWN request.
      const callerRole = String(req.user?.role || "").toLowerCase();
      const callerIsAdmin = ["admin", "administrator", "superadmin", "technical"].includes(callerRole);
      const callerEmployeeNumber = String(actorEmployeeNumber || "").trim();
      const isSelfCancel =
        newStatus === 4 &&
        callerEmployeeNumber &&
        String(request.employeeNumber || "").trim() === callerEmployeeNumber;
      if (!callerIsAdmin && !isSelfCancel) {
        return res.status(403).json({
          error:
            "Only HR/admin may change a leave request's status; employees may only cancel their own request.",
        });
      }

      if (!Number.isInteger(newStatus) || ![0, 1, 2, 3, 4].includes(newStatus)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      const denialReasonTrimmed = String(denial_reason || "").trim().slice(0, 2000) || null;
      if (newStatus === 3 && !denialReasonTrimmed) {
        return res.status(400).json({ error: "A reason is required when denying a leave request." });
      }

      // Atomically claim this status transition before touching any leave/CTO/SC balance.
      // If another request already changed this row's status since we read it above, this
      // UPDATE affects 0 rows and we abort here — this is what closes the race that let a
      // single approval/denial/cancel be deducted or restored twice by two concurrent calls.
      db.query(
        "UPDATE leave_request SET status = ? WHERE id = ? AND status = ?",
        [newStatus, id, oldStatus],
        (claimErr, claimResult) => {
          if (claimErr) {
            return res.status(500).json({ error: "Failed to update status" });
          }
          if (!claimResult || claimResult.affectedRows !== 1) {
            return res.status(409).json({
              error:
                "This request was already updated by someone else. Please refresh and try again.",
            });
          }

          // Compensating rollback: only used if the deduction/restore pipeline below fails
          // AFTER we've already claimed the status change — puts the row back exactly as it
          // was so the request can be retried instead of being stuck half-applied.
          const revertClaim = (respond) => {
            db.query(
              "UPDATE leave_request SET status = ? WHERE id = ?",
              [oldStatus, id],
              () => respond(),
            );
          };

      const updateStatus = (opts = {}) => {
        const {
          setDeduction = null,
          clearDeduction = false,
          skipTransactionLog = false,
        } = opts;
        let sql =
          "UPDATE leave_request SET employeeNumber = ?, leave_code = ?, leave_date = ?, status = ?, denial_reason = ?";
        const params = [
          employeeNumber,
          leave_code,
          leave_date,
          newStatus,
          newStatus === 3 ? denialReasonTrimmed : null,
        ];
        if (setDeduction) {
          sql +=
            ", deduction_applied_hours = ?, hr_approval_rate = ?, deduction_charge_to = ?, deduction_balance_before_hours = ?, deduction_balance_after_hours = ?";
          params.push(
            setDeduction.hours,
            setDeduction.rate,
            setDeduction.chargeTo || null,
            setDeduction.balanceBefore ?? null,
            setDeduction.balanceAfter ?? null,
          );
        } else if (clearDeduction) {
          sql +=
            ", deduction_applied_hours = NULL, hr_approval_rate = NULL, deduction_charge_to = NULL, deduction_balance_before_hours = NULL, deduction_balance_after_hours = NULL";
        }
        sql += " WHERE id = ?";
        params.push(id);
        db.query(sql, params, async (updateErr) => {
          if (updateErr) {
            logAudit(
              { employeeNumber: actorEmployeeNumber },
              "Update Leave Request Failed",
              "leave_request",
              id,
              employeeNumber,
            );
            return res.status(500).json({ error: "Failed to update status" });
          }
          db.query(
            "SELECT leave_description FROM leave_table WHERE leave_code = ?",
            [leave_code],
            async (err2, leaveRows) => {
              if (err2) {
                console.error(
                  "[Update Status] Error fetching leave description:",
                  err2,
                );
                return res
                  .status(500)
                  .json({ error: "Failed to fetch leave description" });
              }

              const leave_description =
                leaveRows[0]?.leave_description || "Unknown Leave Type";
              const action = statusToLeaveAction(newStatus);
              if (action && !skipTransactionLog) {
                const actorFullName = await getEmployeeFullName(
                  actorEmployeeNumber,
                );
                const requesterFullName = await getEmployeeFullName(
                  employeeNumber,
                );
                const actorDisplayName = formatUserDisplayName(
                  actorEmployeeNumber,
                  actorFullName,
                );
                const requesterDisplayName = formatUserDisplayName(
                  employeeNumber,
                  requesterFullName,
                );
                const message = buildLeaveTransactionMessage({
                  action,
                  actorDisplayName,
                  requesterDisplayName,
                  leaveDesc: leave_description,
                  leaveDates: leave_date,
                });
                await insertTransactionLog(
                  String(employeeNumber),
                  message,
                  actorEmployeeNumber,
                );
              }

              const auditActionStr =
                {
                  immediateSupervisor_approved: "Supervisor Approved Leave",
                  hr_approved: "HR Approved Leave",
                  denied: "Leave Request Denied",
                  cancelled: "Cancel Leave Request",
                }[statusToLeaveAction(newStatus)] || "Update Leave Request";
              logAudit(
                { employeeNumber: actorEmployeeNumber },
                `${auditActionStr} - ${leave_description}`,
                "leave_request",
                id,
                employeeNumber,
              );

              emitLeaveChange("leaveRequestChanged");
              res.json({
                id,
                employeeNumber,
                leave_code,
                leave_date,
                status: newStatus,
                message: "Status updated successfully",
              });
            },
          );
        });
      };

      // DEDUCT: status → 2 (HR Approved) — hours from HR modal (deduction_hours and/or rate_decimal)
      if (newStatus === 2 && oldStatus !== 2) {
        (async () => {
          try {
            const fallbackSuggestion = await buildDeductionSuggestion({
              employeeNumber,
              leave_code,
              leave_date,
              has_leave_form: true,
              is_half_day_absence: false,
              requested_rate_decimal: parseFloat(rate_decimal) || null,
            });
            const systemRecommendation =
              decision_context?.system_recommendation || fallbackSuggestion;
            const chargeCode = resolveHrDeductionChargeCode({
              charge_to,
              decision_context,
              requestLeaveCode: leave_code,
              systemRecommendation,
            });

            const leaveDateOnly = toMysqlDateOnly(leave_date);
            const availableBefore =
              String(chargeCode || "").trim().toUpperCase() === "CTO"
                ? await getCtoRemainingHours(employeeNumber)
                : String(chargeCode || "").trim().toUpperCase() === "SC"
                  ? await getScRemainingHours(employeeNumber)
                  : await getTotalRemainingHours(employeeNumber, chargeCode);
            const meta = await fetchLeaveDeductionMeta(
              request.employeeNumber,
              request.leave_code,
              leave_date,
            );
            const { hoursPerDay } = resolveHoursPerDayFromMeta(meta);
            const dh = parseFloat(deduction_hours);
            const rr = parseFloat(rate_decimal);
            let delta;
            let storedRate;
            if (Number.isFinite(dh) && dh > 0) {
              delta = dh;
              storedRate =
                Number.isFinite(rr) && rr > 0
                  ? Number(rr.toFixed(3))
                  : Number((delta / hoursPerDay).toFixed(3));
            } else if (Number.isFinite(rr) && rr > 0) {
              delta = rr * hoursPerDay;
              storedRate = Number(rr.toFixed(3));
            } else {
              return revertClaim(() =>
                res.status(400).json({
                  error:
                    "HR approval requires a positive deduction_hours and/or rate_decimal in the request body.",
                }),
              );
            }

            if (String(chargeCode || "").trim().toUpperCase() === "CTO") {
              const y = parseInt(String(leaveDateOnly).slice(0, 4), 10);
              const m = parseInt(String(leaveDateOnly).slice(5, 7), 10);
              if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
                return revertClaim(() =>
                  res.status(400).json({ error: "Invalid leave_date for CTO ledger period" }),
                );
              }
              const baseRemark = `Leave request HR approval · ${leaveDateOnly} · leave_request:${id}`;
              const ctoLedger = await appendCtoDeductionSnapshotRowAsync({
                employeeNumber,
                needHours: delta,
                period_year: y,
                period_month: m,
                expiry_date: null,
                remarksForLedger: baseRemark,
                emp_category_snapshot: null,
                usageDateUsed: leaveDateOnly,
                usageAction: "offset",
              });
              if (
                !Number.isFinite(ctoLedger?.deducted) ||
                ctoLedger.deducted + 1e-6 < delta
              ) {
                return revertClaim(() =>
                  res.status(400).json({
                    error: "CTO deduction failed due to insufficient remaining credits",
                  }),
                );
              }
            } else if (String(chargeCode || "").trim().toUpperCase() === "SC") {
              await applyHoursDeltaAcrossServiceCredit({
                req,
                actorEmployeeNumber,
                employeeNumber,
                deltaHours: delta,
                leaveDateOnly,
                requestId: id,
                reason: `HR Approved — deducted ${delta} hours from SC balance`,
                scType: "non_commutative",
              });
            } else {
              await applyHoursDeltaAcrossAssignments({
                req,
                actorEmployeeNumber,
                employeeNumber,
                leave_code: chargeCode,
                deltaHours: delta,
                requestId: id,
                reason: `HR Approved — deducted ${delta} hours from ${chargeCode} balance`,
              });
            }

            try {
              await syncApprovedLeaveToAttendanceRecord(
                employeeNumber,
                leave_date,
              );
            } catch (syncErr) {
              console.error(
                "[leave] attendance sync (HR approve):",
                syncErr.message,
              );
            }

            const availableAfter =
              String(chargeCode || "").trim().toUpperCase() === "CTO"
                ? await getCtoRemainingHours(employeeNumber)
                : String(chargeCode || "").trim().toUpperCase() === "SC"
                  ? await getScRemainingHours(employeeNumber)
                  : await getTotalRemainingHours(employeeNumber, chargeCode);
            const overrideReason =
              (decision_context?.override_reason || "").trim() || null;
            const decision =
              overrideReason ||
              !nearlyEqual(systemRecommendation?.recommended_hours, delta) ||
              !nearlyEqual(
                systemRecommendation?.recommended_rate_decimal,
                storedRate,
              ) ||
              String(chargeCode).trim().toUpperCase() !==
                String(
                  systemRecommendation?.recommended_charge_to || "",
                )
                  .trim()
                  .toUpperCase()
                ? "overridden"
                : "accepted";
            await insertDeductionDecisionLog({
              leaveRequestId: id,
              employeeNumber,
              leave_code,
              leave_date,
              decision,
              decisionSource: "hr_single_approval",
              actorEmployeeNumber,
              systemRecommendation,
              finalApplied: {
                applied_rate_decimal: storedRate,
                applied_hours: delta,
                charge_to: chargeCode,
                request_leave_code: leave_code,
                available_hours_before: availableBefore,
                available_hours_after: availableAfter,
              },
              overrideReason,
            });

            try {
              const [empName, actorName] = await Promise.all([
                getEmployeeFullName(String(employeeNumber)),
                getEmployeeFullName(actorEmployeeNumber),
              ]);
              const chargeDesc = await new Promise((resolve) =>
                db.query(
                  "SELECT leave_description FROM leave_table WHERE TRIM(leave_code) = TRIM(?) LIMIT 1",
                  [chargeCode],
                  (e, r) =>
                    resolve(
                      (r && r[0] && r[0].leave_description) || chargeCode,
                    ),
                ),
              );
              const actorDisplay = formatUserDisplayName(
                actorEmployeeNumber,
                actorName,
              );
              const empDisplay = formatUserDisplayName(
                String(employeeNumber),
                empName,
              );
              const beforeH = Number(availableBefore || 0);
              const afterH = Number(availableAfter || 0);
              const txMsg = `${actorDisplay} deducted ${delta} hrs from ${chargeDesc} (${chargeCode}) balance for ${empDisplay} (HR approval).${formatBalanceUpdatedSuffix(beforeH, afterH, delta)}`;
              await insertTransactionLog(
                String(employeeNumber),
                txMsg,
                actorEmployeeNumber,
                {
                  audit_action: "HR leave approval deduction",
                  transaction_message: txMsg,
                  leave_request_id: id,
                  request_leave_code: leave_code,
                  charge_to: chargeCode,
                  deducted_hours: delta,
                  available_hours_before: beforeH,
                  available_hours_after: afterH,
                },
              );
            } catch (e) {
              console.error(
                "[leave] Failed to insert deduction transaction log:",
                e.message,
              );
            }

            emitLeaveChange("leaveAssignmentChanged");
            updateStatus({
              setDeduction: {
                hours: delta,
                rate: storedRate,
                chargeTo: chargeCode,
                balanceBefore: Number(availableBefore.toFixed(4)),
                balanceAfter: Number(availableAfter.toFixed(4)),
              },
              skipTransactionLog: true,
            });
          } catch (e) {
            console.error("[Deduct] Error:", e.message);
            return revertClaim(() =>
              res.status(500).json({ error: e.message || "Deduction failed" }),
            );
          }
        })();
        return;
      }
      // RESTORE: was HR Approved (2), now denied/cancelled
      if (oldStatus === 2 && (newStatus === 3 || newStatus === 4)) {
        (async () => {
          try {
            const applied = parseFloat(request.deduction_applied_hours);
            const restoreAmt =
              Number.isFinite(applied) && applied > 0 ? applied : 8;
            const restoreChargeCode =
              String(request.deduction_charge_to || "").trim() || leave_code;
            const leaveDateOnly = toMysqlDateOnly(leave_date);
            const availableBefore =
              String(restoreChargeCode || "").trim().toUpperCase() === "CTO"
                ? await getCtoRemainingHours(employeeNumber)
                : String(restoreChargeCode || "").trim().toUpperCase() === "SC"
                  ? await getScRemainingHours(employeeNumber)
                  : await getTotalRemainingHours(employeeNumber, restoreChargeCode);

            if (String(restoreChargeCode || "").trim().toUpperCase() === "CTO") {
              const y = parseInt(String(leaveDateOnly).slice(0, 4), 10);
              const m = parseInt(String(leaveDateOnly).slice(5, 7), 10);
              if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
                return revertClaim(() =>
                  res.status(400).json({ error: "Invalid leave_date for CTO ledger period" }),
                );
              }
              const baseRemark = `Leave request HR reversal · ${leaveDateOnly} · leave_request:${id}`;
              await appendCtoDeductionSnapshotRowAsync({
                employeeNumber,
                needHours: -restoreAmt,
                period_year: y,
                period_month: m,
                expiry_date: null,
                remarksForLedger: baseRemark,
                emp_category_snapshot: null,
                usageDateUsed: leaveDateOnly,
                usageAction: "restore",
              });
            } else if (String(restoreChargeCode || "").trim().toUpperCase() === "SC") {
              await applyHoursDeltaAcrossServiceCredit({
                req,
                actorEmployeeNumber,
                employeeNumber,
                deltaHours: -restoreAmt,
                leaveDateOnly,
                requestId: id,
                reason: `HR approval reversed (${newStatus === 3 ? "denied" : "cancelled"}) — restored ${restoreAmt} hours to SC`,
                scType: "non_commutative",
              });
            } else {
              await applyHoursDeltaAcrossAssignments({
                req,
                actorEmployeeNumber,
                employeeNumber,
                leave_code: restoreChargeCode,
                deltaHours: -restoreAmt,
                requestId: id,
                reason: `HR approval reversed (${newStatus === 3 ? "denied" : "cancelled"}) — restored ${restoreAmt} hours to ${restoreChargeCode}`,
              });
            }

            const availableAfter =
              String(restoreChargeCode || "").trim().toUpperCase() === "CTO"
                ? await getCtoRemainingHours(employeeNumber)
                : String(restoreChargeCode || "").trim().toUpperCase() === "SC"
                  ? await getScRemainingHours(employeeNumber)
                  : await getTotalRemainingHours(employeeNumber, restoreChargeCode);

            try {
              const [empName, actorName] = await Promise.all([
                getEmployeeFullName(String(employeeNumber)),
                getEmployeeFullName(actorEmployeeNumber),
              ]);
              const leaveDesc = await new Promise((resolve) =>
                db.query(
                  "SELECT leave_description FROM leave_table WHERE TRIM(leave_code) = TRIM(?) LIMIT 1",
                  [restoreChargeCode],
                  (e, r) =>
                    resolve(
                      (r && r[0] && r[0].leave_description) || restoreChargeCode,
                    ),
                ),
              );
              const actorDisplay = formatUserDisplayName(
                actorEmployeeNumber,
                actorName,
              );
              const empDisplay = formatUserDisplayName(
                String(employeeNumber),
                empName,
              );
              const beforeH = Number(availableBefore || 0);
              const afterH = Number(availableAfter || 0);
              const txMsg = `${actorDisplay} restored ${restoreAmt} hrs to ${leaveDesc} (${restoreChargeCode}) balance for ${empDisplay} (reversal).${formatBalanceUpdatedSuffix(beforeH, afterH, -restoreAmt)}`;
              await insertTransactionLog(
                String(employeeNumber),
                txMsg,
                actorEmployeeNumber,
                {
                  audit_action: "HR leave approval reversal",
                  transaction_message: txMsg,
                  leave_request_id: id,
                  charge_to: restoreChargeCode,
                  restored_hours: restoreAmt,
                  available_hours_before: beforeH,
                  available_hours_after: afterH,
                },
              );
            } catch (e) {
              console.error(
                "[leave] Failed to insert restoration transaction log:",
                e.message,
              );
            }

            emitLeaveChange("leaveAssignmentChanged");
            updateStatus({ clearDeduction: true });
          } catch (e) {
            console.error("[Restore] Error:", e.message);
            return revertClaim(() =>
              res.status(500).json({ error: e.message || "Restore balance failed" }),
            );
          }
        })();
        return;
      }
      updateStatus();
        },
      );
    },
  );
});

// ─── Leave credit usage ledger (transaction history + reconcile) ─────────────
router.get("/leave_credit_usage", requireAdmin, (req, res) => {
  const { employeeNumber, leave_code, leave_assignment_id } = req.query;
  let sql = `
    SELECT lcu.*
    FROM leave_credit_usage lcu
    WHERE 1 = 1
  `;
  const params = [];
  if (employeeNumber) {
    sql += ` AND lcu.employee_number = ?`;
    params.push(String(employeeNumber));
  }
  if (leave_code) {
    sql += ` AND TRIM(lcu.leave_code) = TRIM(?)`;
    params.push(String(leave_code));
  }
  if (leave_assignment_id) {
    sql += ` AND lcu.leave_assignment_id = ?`;
    params.push(parseInt(leave_assignment_id, 10));
  }
  sql += ` ORDER BY lcu.created_at DESC, lcu.id DESC LIMIT 1000`;
  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("[leave_credit_usage]", err.message);
      return res.status(500).json({ error: "Failed to fetch leave credit usage" });
    }
    res.json(rows || []);
  });
});

/** Sum leave hours posted for attendance tardiness (ledger: TARDINESS_DEDUCTION or legacy LEAVE_EARNING rows). */
router.get("/leave_credit_usage/tardiness_posted", requireAdmin, (req, res) => {
  const { employeeNumber, period_year, period_month, leave_code } = req.query;
  if (!employeeNumber || period_year == null || period_month == null) {
    return res.status(400).json({
      error: "employeeNumber, period_year, and period_month are required",
    });
  }
  const emp = String(employeeNumber).trim();
  const py = parseInt(period_year, 10);
  const pm = parseInt(period_month, 10);
  if (!emp || !Number.isFinite(py) || !Number.isFinite(pm)) {
    return res.status(400).json({ error: "Invalid employeeNumber or period" });
  }
  const lcRaw = leave_code != null ? String(leave_code).trim() : "";

  const tardinessWhere = `
    lcu.employee_number = ?
      AND lcu.voided_at IS NULL
      AND lcu.hours_delta < 0
      AND lcu.period_year = ?
      AND lcu.period_month = ?
      AND (
        lcu.source_type = 'TARDINESS_DEDUCTION'
        OR (lcu.source_type = 'LEAVE_EARNING' AND UPPER(IFNULL(le.entry_type, '')) = 'TARDINESS_DEDUCTION')
      )
  `;
  const paramsBase = [emp, py, pm];
  let sqlSum = `
    SELECT COALESCE(SUM(-lcu.hours_delta), 0) AS posted_hours
    FROM leave_credit_usage lcu
    LEFT JOIN leave_earnings le ON le.id = lcu.source_id AND lcu.source_type = 'LEAVE_EARNING'
    WHERE ${tardinessWhere}
  `;
  const paramsSum = [...paramsBase];
  if (lcRaw) {
    sqlSum += ` AND TRIM(lcu.leave_code) = TRIM(?)`;
    paramsSum.push(lcRaw);
  }
  db.query(sqlSum, paramsSum, (err, sRows) => {
    if (err) {
      console.error("[leave_credit_usage/tardiness_posted]", err.message);
      return res.status(500).json({ error: "Failed to sum tardiness deductions" });
    }
    const posted_hours =
      sRows && sRows[0] != null ? Number(sRows[0].posted_hours) || 0 : 0;

    let sqlLast = `
      SELECT lcu.leave_code
      FROM leave_credit_usage lcu
      LEFT JOIN leave_earnings le ON le.id = lcu.source_id AND lcu.source_type = 'LEAVE_EARNING'
      WHERE ${tardinessWhere}
    `;
    const paramsLast = [...paramsBase];
    if (lcRaw) {
      sqlLast += ` AND TRIM(lcu.leave_code) = TRIM(?)`;
      paramsLast.push(lcRaw);
    }
    sqlLast += ` ORDER BY lcu.id DESC LIMIT 1`;
    db.query(sqlLast, paramsLast, (e2, lRows) => {
      if (e2) {
        console.error("[leave_credit_usage/tardiness_posted:last]", e2.message);
        return res.json({ posted_hours, last_leave_code: null });
      }
      const last_leave_code =
        lRows && lRows[0] && lRows[0].leave_code != null
          ? String(lRows[0].leave_code).trim()
          : null;
      res.json({ posted_hours, last_leave_code });
    });
  });
});

router.post("/leave_credit_usage/reconcile", requireAdmin, async (req, res) => {
  const applyFix = req.body?.fix === true;
  const conn = await getPromiseConnection();
  try {
    const [assignments] = await conn.execute(
      `SELECT id, used_hours, total_hours, remaining_hours FROM leave_assignment`,
    );
    const mismatches = [];
    for (const r of assignments) {
      const { activeLines, usedFromLedger } = await fetchLedgerSumForAssignment(
        conn,
        r.id,
      );
      if (activeLines === 0) continue;
      const stored = parseDbHours(r.used_hours);
      if (Math.abs(stored - usedFromLedger) > 0.02) {
        mismatches.push({
          leave_assignment_id: r.id,
          stored_used_hours: stored,
          ledger_used_hours: usedFromLedger,
          diff: Number((stored - usedFromLedger).toFixed(4)),
        });
        if (applyFix) {
          await refreshLeaveAssignmentCacheFromLedger(conn, r.id);
        }
      }
    }
    res.json({
      checked: assignments.length,
      mismatchCount: mismatches.length,
      mismatches,
      fixed: applyFix,
    });
  } catch (e) {
    console.error("[leave_credit_usage/reconcile]", e.message);
    res.status(500).json({ error: e.message || "reconcile failed" });
  } finally {
    conn.release();
  }
});

// DELETE leave request
router.delete("/leave_request/:id", requireAdmin, (req, res) => {
  const actorEmpNum = getActorEmployeeNumber(req);
  // Fetch first so we have employee info for logging
  db.query(
    "SELECT lr.employeeNumber, lr.leave_code, lt.leave_description FROM leave_request lr LEFT JOIN leave_table lt ON lr.leave_code = lt.leave_code WHERE lr.id = ?",
    [req.params.id],
    (fetchErr, rows) => {
      const targetRecord = (!fetchErr && rows && rows[0]) ? rows[0] : null;
      db.query("DELETE FROM leave_request WHERE id = ?", [req.params.id], async (err) => {
        if (err) {
          if (targetRecord) logAudit({ employeeNumber: actorEmpNum }, 'Delete Leave Request Failed', 'leave_request', req.params.id, targetRecord.employeeNumber);
          return res.status(500).json({ error: "Failed to delete leave request" });
        }
        if (targetRecord) {
          logAudit({ employeeNumber: actorEmpNum }, 'Delete Leave Request', 'leave_request', req.params.id, targetRecord.employeeNumber);
          try {
            const [empName, actorName] = await Promise.all([
              getEmployeeFullName(String(targetRecord.employeeNumber)),
              getEmployeeFullName(actorEmpNum),
            ]);
            const leaveDesc = targetRecord.leave_description || targetRecord.leave_code;
            const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
            const empDisplay = formatUserDisplayName(String(targetRecord.employeeNumber), empName);
            await insertTransactionLog(String(targetRecord.employeeNumber), `${actorDisplay} deleted leave request for ${leaveDesc} of ${empDisplay}`, actorEmpNum);
          } catch (e) { console.error('[leave] Delete request log error:', e.message); }
        }
        emitLeaveChange("leaveRequestChanged");
        res.json({ message: "Leave request deleted successfully" });
      });
    },
  );
});


module.exports = router;



