const express = require("express");
  const router = express.Router();
  const db = require("../db");
  const { authenticateToken, logAudit, requireAdmin, requireSelfOrAdmin } = require("../middleware/auth");
  const jwt = require("jsonwebtoken");
  const {
    getPromiseConnection,
    insertCreditUsageLine,
    refreshLeaveAssignmentCacheFromLedger,
    voidCreditUsageBySource,
  } = require("../services/leaveCreditUsageService");
  const attendanceWriter = require("../services/attendanceResultWriter");
  const {
    getServiceCreditRunningTotals,
    loadScBalanceSummaryRows,
  } = require("../services/serviceCreditRunningTotals");
  const { getCtoCreditRunningTotals } = require("../services/ctoCreditRunningTotals");
  const {
    recomputeScLedgerFieldsAsync,
    findLatestScPeriodRow,
    queryAsync: scQueryAsync,
    execAsync: scExecAsync,
    reverseScPeriodAttendanceDeductionsAsync,
    refreshScPeriodLedgerOnRow,
    ensureScPeriodRowAsync,
    syncScPeriodCarryAsync,
    loadScChainContextAsync,
    getPriorPeriodScCarryForward,
    appendScLedgerSnapshotAsync,
    parseScUsedDeltaHours,
    periodOtScHours,
    alignScPeriodBaseForAppend,
    findExistingScDeductionSnapshotAsync,
    reverseScDeductionEarningAsync,
    isScPeriodKeyClosed,
  } = require("../utils/serviceCreditBalanceUtils");
  const {
    recomputeCtoLedgerFieldsAsync,
    findLatestCtoPeriodRow,
    queryAsync: ctoQueryAsync,
    execAsync: ctoExecAsync,
    loadCtoChainContextAsync,
    getPriorPeriodCtoCarryForward,
    appendCtoLedgerSnapshotAsync,
    alignCtoPeriodBaseForAppend,
    findExistingCtoDeductionSnapshotAsync,
    isCtoPeriodKeyClosed,
    refreshCtoPeriodLedgerOnRow,
    ensureCtoPeriodRowAsync,
    reverseCtoDeductionEarningAsync,
    reverseCtoPeriodAttendanceDeductionsAsync,
  } = require("../utils/ctoBalanceUtils");
  const {
    isCommutedLocked,
    latestPeriodsByKey,
    isAfterPeriod,
    recomputeAssignmentLedgerFields,
    resolveActiveAssignmentForDeduction,
    buildNewPeriodAssignmentFields,
    repairPeriodCarryForwardIfEmpty,
    getPriorPeriodCarryForwardHoursForEmployee,
    getLeaveTypeStatsActive,
    sortPeriodsDesc,
    getActivePeriods,
  } = require("../utils/leaveAssignmentBalanceUtils");

  const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const toDaysVal = (hrs) => Number((toNum(hrs) / 8).toFixed(3));

  const parseJsonSafe = (raw) => {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  };

  /** Merge half-day policy deductions (deduction_decision_log) into leave earnings list for the UI. */
  const mergeHalfDayPolicyLeaveRows = (employeeNumber, yNum, mNum, statusFilter, baseRows, callback) => {
    if (statusFilter === "pending" || statusFilter === "rejected") {
      return callback(Array.isArray(baseRows) ? baseRows : []);
    }
    const start = `${yNum}-${String(mNum).padStart(2, "0")}-01`;
    const lastDay = new Date(yNum, mNum, 0).getDate();
    const end = `${yNum}-${String(mNum).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    db.query(
      `SELECT id, employeeNumber, leave_code, leave_date, decision, created_at,
              final_applied_json, actor_employeeNumber, override_reason
       FROM deduction_decision_log
       WHERE employeeNumber = ?
         AND decision_source = 'half_day_policy_manual_apply'
         AND decision IN ('accepted','overridden')
         AND leave_date >= ?
         AND leave_date <= ?
       ORDER BY created_at DESC`,
      [String(employeeNumber || ""), start, end],
      (err, rows) => {
        const base = Array.isArray(baseRows) ? [...baseRows] : [];
        if (err || !Array.isArray(rows) || !rows.length) {
          return callback(base);
        }
        const synthetic = rows
          .map((r) => {
            const hid = parseInt(r.id, 10);
            if (!Number.isFinite(hid) || hid <= 0) return null;
            const fin = parseJsonSafe(r.final_applied_json);
            let hrs = Number(fin.applied_hours);
            if (!Number.isFinite(hrs) || hrs <= 0) {
              hrs = Number(fin.requested_deduction_hours);
            }
            if (!Number.isFinite(hrs) || hrs <= 0) hrs = 0;
            const negHrs = hrs > 0 ? -hrs : 0;
            const ld = r.leave_date;
            const ldOnly = ld ? String(ld).slice(0, 10) : "";
            let py = yNum;
            let pm = mNum;
            if (ld) {
              const s = String(ld).slice(0, 10);
              const parts = s.split("-");
              if (parts.length >= 2) {
                const y = parseInt(parts[0], 10);
                const mo = parseInt(parts[1], 10);
                if (Number.isFinite(y) && Number.isFinite(mo)) {
                  py = y;
                  pm = mo;
                }
              }
            }
            const charge = String(fin.charge_to || r.leave_code || "").trim() || "—";
            const salaryNote = fin.salary_deduction ? " (salary)" : "";
            return {
              id: -Math.abs(hid),
              _decisionLogId: r.id,
              _halfDayPolicyRecord: true,
              employee_number: r.employeeNumber,
              leave_code: r.leave_code,
              earned_hours: negHrs,
              period_year: py,
              period_month: pm,
              entry_type: "HALF_DAY_POLICY",
              earn_status: "approved",
              remarks: `Half-day policy deduction — ${Math.abs(hrs)} hrs charged to ${charge}${salaryNote}${ldOnly ? ` on ${ldOnly}` : ""}`,
              created_at: r.created_at,
              created_by: r.actor_employeeNumber,
              approved_by: r.actor_employeeNumber,
              leave_description: "Half-day attendance (policy)",
            };
          })
          .filter(Boolean);
        const combined = [...synthetic, ...base].sort((a, b) => {
          const tb = new Date(b.created_at || b.approved_at || 0).getTime();
          const ta = new Date(a.created_at || a.approved_at || 0).getTime();
          if (tb !== ta) return tb - ta;
          return Number(b.id) - Number(a.id);
        });
        callback(combined);
      },
    );
  };

  const { mirrorAttendanceSalaryShortfallToAuditTrail } = require("../services/leaveSalaryShortfallMirror");
  const { notifyEarningsChanged } = require("../socket/socketService");

  /**
   * Logs leave_salary_shortfall only when shortfall_hours > 0 (Option B).
   * Zero / fully-covered outcomes live in attendance_result only.
   */
  const recordLeaveSalaryShortfall = (req, row) =>
    new Promise((resolve, reject) => {
      const sh = Math.max(0, toNum(row.shortfall_hours));
      if (sh <= 0) return resolve();
      const pm = parseInt(row.period_month, 10);
      if (!Number.isFinite(pm) || pm < 1 || pm > 12) {
        return reject(new Error("leave_salary_shortfall: invalid period_month"));
      }
      const py = parseInt(row.period_year, 10);
      const sd = sh / 8;
      const neg = toNum(row.negative_balance_days);
      const leaveCode = String(row.leave_code || "");
      const entryType = row.entry_type ? String(row.entry_type) : null;
      const remarks = row.remarks || null;
      db.query(
        `INSERT INTO leave_salary_shortfall (
          employee_number, period_year, period_month,
          negative_balance_days, shortfall_days, shortfall_hours,
          leave_code, entry_type, leave_earning_id, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(row.employee_number),
          py,
          pm,
          neg,
          sd,
          sh,
          leaveCode,
          entryType,
          row.leave_earning_id != null ? parseInt(row.leave_earning_id, 10) : null,
          remarks,
        ],
        (err, result) => {
          if (err) return reject(err);
          const insertId = result?.insertId;
          if (req && insertId != null) {
            mirrorAttendanceSalaryShortfallToAuditTrail({
              req,
              targetEmployeeNumber: String(row.employee_number),
              insertId,
              y: py,
              m: pm,
              shortfallDays: sd,
              shortfallHours: sh,
              leaveCode,
              entryType: entryType || "LEAVE_DEDUCTION_SHORTFALL",
              remarks,
            }).finally(() => resolve());
          } else {
            resolve();
          }
        },
      );
    });

  const getIo = (req) => {
    // Primary wiring in backend/index.js: app.locals.io = io
    if (req?.app?.locals?.io) return req.app.locals.io;
    // Back-compat if some deployments still use app.set("io", io)
    try {
      return req.app.get("io");
    } catch {
      return null;
    }
  };

  const emitEarningsChanged = (action, payload = {}) => {
    try {
      notifyEarningsChanged(action, payload);
    } catch (e) {
      console.warn("notifyEarningsChanged (non-fatal):", e?.message || e);
    }
  };

  // leave_assignment is append-only (history snapshots). For transaction logs we need the
  // CURRENT running balance, which is represented by the latest snapshot row.
  const getLeaveRemainingHours = async (employeeNumber, leaveCode) => {
    const emp = String(employeeNumber || "").trim();
    const code = String(leaveCode || "").trim();
    if (!emp || !code) return 0;
    const rows = await new Promise((resolve) => {
      db.query(
        `SELECT * FROM leave_assignment
         WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)`,
        [emp, code],
        (err, r) => resolve(!err && Array.isArray(r) ? r : []),
      );
    });
    const stats = getLeaveTypeStatsActive(rows);
    return stats.remainingHours;
  };

  const getCtoRemainingHoursTotal = (employeeNumber) =>
    new Promise((resolve) => {
      const emp = String(employeeNumber || "").trim();
      if (!emp) return resolve(0);
      getCtoCreditRunningTotals(emp, (err, cur) => {
        if (err) return resolve(0);
        resolve(toNum(cur?.remaining));
      });
    });

  const getScRemainingHoursTotal = async (employeeNumber) => {
    const emp = String(employeeNumber || "").trim();
    if (!emp) return 0;
    const types = await new Promise((resolve) => {
      db.query(
        `SELECT DISTINCT sc_type FROM service_credit WHERE employeeNumber = ?`,
        [emp],
        (err, rows) => {
          if (err) return resolve([]);
          resolve((rows || []).map((r) => r.sc_type).filter(Boolean));
        },
      );
    });
    if (!types.length) return 0;
    const totals = await Promise.all(
      types.map(
        (t) =>
          new Promise((resolve) => {
            getServiceCreditRunningTotals(emp, t, (e2, cur) => {
              if (e2) return resolve(0);
              resolve(toNum(cur?.remaining));
            });
          }),
      ),
    );
    return totals.reduce((s, n) => s + toNum(n), 0);
  };

  const getActorEmployeeNumber = (req, fallback = null) => {
    if (req.user?.employeeNumber) return String(req.user.employeeNumber);
    const authHeader = req.headers?.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded?.employeeNumber) return String(decoded.employeeNumber);
        if (decoded?.username) return String(decoded.username);
      } catch (err) {}
    }
    return fallback ? String(fallback) : "unknown";
  };

  /** Insert leave_credit_usage + refresh assignment; used/remaining follow ledger. */
  const commitLeaveDeductionLedger = async ({
    req,
    rec,
    assignmentId,
    deductionHours,
    sourceType = "LEAVE_EARNING",
    sourceId = null,
  }) => {
    const conn = await getPromiseConnection();
    const createdBy = getActorEmployeeNumber(req);
    try {
      await conn.beginTransaction();
      const [fr] = await conn.execute(
        `SELECT id, remaining_hours FROM leave_assignment WHERE id = ? FOR UPDATE`,
        [assignmentId],
      );
      const row = fr?.[0];
      if (!row) throw new Error("leave_assignment row not found");
      const remBefore = toNum(row.remaining_hours);
      const dh = Math.abs(toNum(deductionHours));
      const shortfallHours = Math.max(0, dh - remBefore);
      const negativeBalanceDays = (remBefore - dh) / 8;
      const sid = sourceId != null ? parseInt(sourceId, 10) : null;
      const leave_credit_usage_id = await insertCreditUsageLine(conn, {
        leave_assignment_id: assignmentId,
        employee_number: rec.employee_number,
        leave_code: rec.leave_code,
        period_year: rec.period_year != null ? parseInt(rec.period_year, 10) : null,
        period_month: rec.period_month != null ? parseInt(rec.period_month, 10) : null,
        hours_delta: -dh,
        source_type: sourceType || "LEAVE_EARNING",
        source_id: Number.isFinite(sid) ? sid : null,
        remarks: rec.remarks || null,
        created_by: createdBy,
      });
      await refreshLeaveAssignmentCacheFromLedger(conn, assignmentId);
      await conn.commit();
      return { shortfallHours, negativeBalanceDays, leave_credit_usage_id };
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_r) {}
      throw e;
    } finally {
      conn.release();
    }
  };

  // NOTE:
  // `period_semester` is used as a month number ("1".."12") in leave_assignment.
  // Older code also accepted "1st/2nd semester" strings. When treated as a semester,
  // mapping "2" -> rank 3 breaks month comparisons (Feb is no longer < Mar).
  const semRank = (s) => {
    const raw = String(s ?? "").trim();
    const v = raw.toLowerCase();
    if (!v) return 0;
    // Prefer numeric month/semester values when available.
    if (/^\d+$/.test(v)) {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    }
    if (v.includes("2nd")) return 2;
    if (v.includes("1st")) return 1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const isBeforePeriod = (row, targetYear, targetMonth) => {
    const y = Number(row?.period_year);
    const m = semRank(row?.period_semester);
    if (!Number.isFinite(y)) return true;
    if (y < targetYear) return true;
    if (y > targetYear) return false;
    return m < targetMonth;
  };

  const normalizePeriodKey = (row) => {
    const y = row?.period_year != null ? String(parseInt(String(row.period_year), 10) || "").trim() : "";
    const semRaw = row?.period_semester != null ? String(row.period_semester).trim() : "";
    const semNum = semRaw !== "" && /^[0-9]+$/.test(semRaw) ? parseInt(semRaw, 10) : NaN;
    const sem = Number.isFinite(semNum) ? String(semNum) : semRaw;
    return `${y}|${sem}`;
  };

  // leave_assignment rows are append-only snapshots. For any "period" (year+month/semester),
  // keep only the latest snapshot row (max id) so we don't double-count.
  const latestSnapshotPerPeriod = (rows = []) => {
    const list = Array.isArray(rows) ? rows : [];
    const m = new Map();
    for (const r of list) {
      const key = normalizePeriodKey(r);
      const prev = m.get(key);
      const id = Number(r?.id);
      const prevId = Number(prev?.id);
      if (!prev || (Number.isFinite(id) && (!Number.isFinite(prevId) || id > prevId))) {
        m.set(key, r);
      }
    }
    return Array.from(m.values());
  };

  const findTargetRow = (rows, targetYear, targetMonth) => {
    const mStr = String(targetMonth);
    const mPad = String(targetMonth).padStart(2, "0");
    const filtered = (rows || []).filter(
      (r) =>
        Number(r?.period_year) === Number(targetYear) &&
        (String(r?.period_semester || "") === mStr ||
          String(r?.period_semester || "") === mPad),
    );
    // Prefer newest id if multiple
    return filtered.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  };

  /** Find assignment for a specific earning period (no insert). */
  const findPeriodAssignment = async ({
    employeeNumber,
    leaveCode,
    periodYear,
    periodMonth,
  }) => {
    const month = parseInt(periodMonth, 10);
    const year = parseInt(periodYear, 10);
    if (!employeeNumber || !leaveCode || !Number.isFinite(year)) return null;

    const rows = await new Promise((resolve) => {
      db.query(
        `SELECT * FROM leave_assignment
         WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)
         ORDER BY period_year DESC, id DESC`,
        [employeeNumber, leaveCode],
        (err, r) => resolve(!err && Array.isArray(r) ? r : []),
      );
    });

    const latestRows = latestSnapshotPerPeriod(rows);
    if (Number.isFinite(month) && month > 0) {
      return findTargetRow(latestRows, year, month);
    }
    return (
      latestRows
        .filter((r) => Number(r.period_year) === year)
        .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null
    );
  };

  /** Create period row with prior-period carry-forward when approving positive earnings. */
  const ensurePeriodAssignment = async ({
    employeeNumber,
    leaveCode,
    periodYear,
    periodMonth,
  }) => {
    const existing = await findPeriodAssignment({
      employeeNumber,
      leaveCode,
      periodYear,
      periodMonth,
    });
    if (existing) return existing;

    const month = parseInt(periodMonth, 10);
    const year = parseInt(periodYear, 10);
    if (!employeeNumber || !leaveCode || !Number.isFinite(month) || !Number.isFinite(year)) {
      return null;
    }

    const fields = await buildNewPeriodAssignmentFields(db, {
      employeeNumber,
      leave_code: leaveCode,
      period_year: year,
      period_semester: String(month),
      allocated_hours: 0,
      used_hours: 0,
    });

    const insertedId = await new Promise((resolve) => {
      db.query(
        `INSERT INTO leave_assignment
          (employeeNumber, leave_code, total_hours, remaining_hours, used_hours,
          carried_forward_hours, allocated_hours, period_year, period_semester, earning_status,
          total_days, remaining_days, used_days, allocated_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          employeeNumber,
          leaveCode,
          fields.total_hours,
          fields.remaining_hours,
          fields.used_hours,
          fields.carried_forward_hours,
          fields.allocated_hours,
          year,
          String(month),
          fields.earning_status,
          // [NEW] Days-equivalent shadow columns, derived from the same
          // values written to the hours columns above.
          toDaysVal(fields.total_hours),
          toDaysVal(fields.remaining_hours),
          toDaysVal(fields.used_hours),
          toDaysVal(fields.allocated_hours),
        ],
        (err, result) => resolve(!err ? result?.insertId : null),
      );
    });
    if (!insertedId) return null;

    return new Promise((resolve) => {
      db.query(
        "SELECT * FROM leave_assignment WHERE id = ? LIMIT 1",
        [insertedId],
        (err, r) => resolve(!err && r?.[0] ? r[0] : null),
      );
    });
  };

  /**
   * When earnings are approved out-of-order, bump opening balance (allocated_hours)
   * on all later period rows so the running ledger chain stays correct.
   */
  const propagateEarnedHoursToLaterPeriods = async ({
    employeeNumber,
    leaveCode,
    periodYear,
    periodMonth,
    earnedHours,
  }) => {
    const y = parseInt(periodYear, 10);
    const m = parseInt(periodMonth, 10);
    const hrs = toNum(earnedHours);
    if (!employeeNumber || !leaveCode || !Number.isFinite(y) || !Number.isFinite(m) || hrs <= 0) return;

    const rows = await new Promise((resolve) => {
      db.query(
        `SELECT * FROM leave_assignment
        WHERE employeeNumber = ? AND TRIM(leave_code) = TRIM(?)
        ORDER BY period_year ASC, id ASC`,
        [employeeNumber, leaveCode],
        (err, r) => resolve(!err && Array.isArray(r) ? r : []),
      );
    });

    const snapshots = latestPeriodsByKey(rows);
    const later = snapshots.filter((p) => isAfterPeriod(p, y, m) && !isCommutedLocked(p));

    for (const period of later) {
      const newAlloc = Math.max(0, toNum(period.allocated_hours) + hrs);
      const working = { ...period, allocated_hours: newAlloc };
      const recomputed = await recomputeAssignmentLedgerFields(db, working);
      await new Promise((resolve) => {
        db.query(
          `UPDATE leave_assignment SET
            allocated_hours = ?, total_hours = ?, remaining_hours = ?,
            carried_forward_hours = 0, earning_status = ?,
            allocated_days = ?, total_days = ?, remaining_days = ?, carried_forward_days = 0
          WHERE id = ?`,
          [
            recomputed.allocated_hours,
            recomputed.total_hours,
            recomputed.remaining_hours,
            recomputed.earning_status,
            // [NEW] Days-equivalent shadow columns.
            toDaysVal(recomputed.allocated_hours),
            toDaysVal(recomputed.total_hours),
            toDaysVal(recomputed.remaining_hours),
            period.id,
          ],
          () => resolve(),
        );
      });
    }
  };

  /**
   * Apply a negative leave balance change via leave_credit_usage (+ attendance_result / salary shortfall).
   * When leaveEarningId is set, ledger source is LEAVE_EARNING (pending row was approved).
   * When null (direct tardiness POST), source is TARDINESS_DEDUCTION — no leave_earnings row.
   */
  const runNegativeLeaveDeductionPipeline = async (req, rec, leaveEarningId) => {
    const earnedHrs = toNum(rec.earned_hours);
    if (earnedHrs >= 0) throw new Error("runNegativeLeaveDeductionPipeline expects negative earned_hours");
    const periodMonth = rec.period_month ? parseInt(rec.period_month, 10) : null;
    const deductionHours = Math.abs(earnedHrs);
    const ledgerSourceType = leaveEarningId != null ? "LEAVE_EARNING" : "TARDINESS_DEDUCTION";
    const ledgerSourceId = leaveEarningId != null ? parseInt(leaveEarningId, 10) : null;
    const lEid = leaveEarningId != null ? parseInt(leaveEarningId, 10) : null;

    // Deduct from the active Leave Assignment period — not the earnings calendar month.
    const matched = await resolveActiveAssignmentForDeduction(
      db,
      rec.employee_number,
      rec.leave_code,
    );

    const attachSideEffects = async (shortfallHours, negativeBalanceDays, leave_credit_usage_id) => {
      try {
        await attendanceWriter.upsertFromLeaveEarningDeduction({
          employee_number: rec.employee_number,
          leave_earning_id: Number.isFinite(lEid) ? lEid : null,
          leave_credit_usage_id,
          period_year: rec.period_year,
          period_month: periodMonth || parseInt(rec.period_month, 10),
          remarks: rec.remarks,
          leave_code: rec.leave_code,
          entry_type: rec.entry_type,
          deduction_hours: deductionHours,
          shortfall_hours: shortfallHours,
        });
      } catch (e) {
        console.error("[earnings] attendance_result (leave deduction pipeline):", e.message);
      }
      try {
        await recordLeaveSalaryShortfall(req, {
          employee_number: rec.employee_number,
          period_year: rec.period_year,
          period_month: periodMonth || parseInt(rec.period_month, 10),
          negative_balance_days: negativeBalanceDays,
          shortfall_hours: shortfallHours,
          leave_code: rec.leave_code,
          entry_type: rec.entry_type,
          leave_earning_id: Number.isFinite(lEid) ? lEid : null,
          remarks: rec.remarks,
        });
      } catch (e) {
        console.error("[earnings] leave_salary_shortfall insert (pipeline):", e.message);
      }
    };

    if (matched) {
      const { shortfallHours, negativeBalanceDays, leave_credit_usage_id } =
        await commitLeaveDeductionLedger({
          req,
          rec,
          assignmentId: matched.id,
          deductionHours,
          sourceType: ledgerSourceType,
          sourceId: Number.isFinite(ledgerSourceId) ? ledgerSourceId : null,
        });
      await attachSideEffects(shortfallHours, negativeBalanceDays, leave_credit_usage_id);
      return;
    }

    const shortfallHours = deductionHours;
    const negativeBalanceDays = -deductionHours / 8;
    await attachSideEffects(shortfallHours, negativeBalanceDays, null);
  };

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
          if (err) return resolve("");
          resolve((rows && rows[0] && rows[0].fullName) || "");
        },
      );
    });

  const formatUserDisplayName = (employeeNumber, fullName) => {
    const emp = employeeNumber ? String(employeeNumber) : "unknown";
    const name = (fullName || "").trim();
    return name ? `${name} (${emp})` : emp;
  };

  const insertTransactionLog = (employeeId, message, actorEmployeeNumber = null) =>
    new Promise((resolve) => {
      if (!employeeId || !message) return resolve();
      db.query(
        "INSERT INTO transaction_table (employee_id, message) VALUES (?, ?)",
        [employeeId, message],
        (err) => {
          if (err) return resolve();
          resolve();
        },
      );
    });

  const buildEarningsTransactionMessage = ({
    actionLabel,
    actorDisplay,
    targetDisplay,
    earningTypeLabel,
    hoursValue,
    leaveCode,
    periodYear,
    periodMonth,
  }) => {
    const hoursPart =
      typeof hoursValue === "number" && Number.isFinite(hoursValue)
        ? ` (${hoursValue} hrs)`
        : "";
    const leavePart = leaveCode ? ` [${leaveCode}]` : "";
    const periodPart =
      periodYear && periodMonth
        ? ` for ${periodYear}-${String(periodMonth).padStart(2, "0")}`
        : "";
    return `${actorDisplay} ${actionLabel} ${earningTypeLabel}${hoursPart}${leavePart}${periodPart} for ${targetDisplay}`;
  };

  // ─── AUDIT LOG ────────────────────────────────────────────────────────────────
  const insertEarningsAuditLog = (
    earningType,
    earningId,
    action,
    oldStatus,
    newStatus,
    actor,
    notes,
    payload,
  ) =>
    new Promise((resolve) => {
      if (!earningType || !action) return resolve();
      let storedEarningId = null;
      const actStr = String(action || "");
      const payloadEmp =
        payload && typeof payload === "object"
          ? String(
              payload.employee_number ||
                payload.employeeNumber ||
                payload.targetEmployeeNumber ||
                "",
            ).trim()
          : "";
      const earningTypeLower = String(earningType || "").toLowerCase();
      // Leave / SC / CTO: earning_id is the target employeeNumber for UI & reports (row pk stays in payload.id / *_earning_id).
      const preferEmployeeForEmpId =
        (earningTypeLower === "leave" ||
          earningTypeLower === "sc" ||
          earningTypeLower === "cto") &&
        payloadEmp;
      // New earnings rows: store employee number in earning_id (UI / reports); numeric id is in payload.*_earning_id.
      const preferEmployeeForCreated =
        payloadEmp &&
        /\bcreated\b/i.test(actStr) &&
        /\bearnings\b/i.test(actStr);
      if (preferEmployeeForEmpId) {
        storedEarningId = payloadEmp.slice(0, 64);
      } else if (!preferEmployeeForCreated) {
        if (earningId !== undefined && earningId !== null && earningId !== "") {
          const p =
            typeof earningId === "bigint"
              ? Number(earningId)
              : parseInt(earningId, 10);
          if (Number.isFinite(p) && p > 0) storedEarningId = String(p);
        }
      } else {
        storedEarningId = payloadEmp.slice(0, 64);
      }
      if (!storedEarningId && payloadEmp) {
        storedEarningId = payloadEmp.slice(0, 64);
      }
      const safePayload =
        payload == null
          ? null
          : typeof payload === "string"
            ? payload
            : (() => {
                try {
                  return JSON.stringify(payload);
                } catch (e) {
                  return null;
                }
              })();
      db.query(
        `INSERT INTO earnings_audit_log
          (earning_type, earning_id, action, old_status, new_status, actor, notes, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(earningType).toLowerCase(),
          storedEarningId,
          String(action),
          oldStatus != null ? String(oldStatus) : null,
          newStatus != null ? String(newStatus) : null,
          actor != null ? String(actor) : null,
          notes != null ? String(notes) : null,
          safePayload,
        ],
        (err) => {
          if (err) {
            // Non-fatal: keep app working even if audit table is missing.
            console.error("[earnings] Failed to insert earnings_audit_log:", err.message);
          }
          resolve();
        },
      );
    });

  /**
   * SC/CTO balance deductions belong in audit_log + transaction_table only.
   * earnings_audit_log records earning lifecycle (credits, leave-linked rows), not deduction ledger.
   */
  const isScCtoDeductionPayload = (type, payload) => {
    const t = String(type || "").toLowerCase();
    if (t !== "sc" && t !== "cto") return false;
    const p = payload && typeof payload === "object" ? payload : {};
    if (p.ledger_only === true) return true;
    const et = String(p.entry_type || p.entryType || "").toUpperCase();
    if (et === "DEDUCTION") return true;
    const eh = toNum(p.earned_hours != null ? p.earned_hours : p.earnedHrs);
    return eh < 0;
  };

  const isScCtoDeductionEarningsAuditRow = (row) => {
    if (!row) return false;
    const t = String(row.earning_type || "").toLowerCase();
    if (t !== "sc" && t !== "cto") return false;
    let p = {};
    try {
      p = row.payload ? JSON.parse(row.payload) : {};
    } catch {
      p = {};
    }
    return isScCtoDeductionPayload(t, p);
  };

  const getEarningsAuditMeta = (type, payload) => {
    const t = String(type || "").toLowerCase();
    const p = payload && typeof payload === "object" ? payload : {};

    if (t === "leave") {
      const leaveCode = (p.leave_code || p.leaveCode || p.leave_code_snapshot || "")
        .toString()
        .trim()
        .toUpperCase();
      const suffix = leaveCode ? ` (${leaveCode})` : "";
      return {
        actionSuffix: suffix,
        notes: leaveCode ? `Leave Code: ${leaveCode}` : null,
      };
    }

    if (t === "sc") {
      const scType = (p.sc_type || p.scType || "")
        .toString()
        .trim()
        .toLowerCase();
      if (scType === "non_commutative" || scType === "commutative") {
        return { actionSuffix: "", notes: null };
      }
      const pretty = scType ? scType.replace(/_/g, " ") : "";
      const suffix = pretty ? ` (${pretty})` : "";
      return { actionSuffix: suffix, notes: pretty ? `SC Type: ${pretty}` : null };
    }

    // cto + others
    return { actionSuffix: "", notes: null };
  };

  const auditEarning = (
    req,
    action,
    type,
    id,
    oldStatus,
    newStatus,
    payload = {},
    auditExtras = null,
  ) => {
    const actor = getActorEmployeeNumber(req);
    const targetEmployeeNumber = (() => {
      const raw =
        payload?.employeeNumber ||
        payload?.employee_number ||
        payload?.targetEmployeeNumber ||
        null;
      if (raw == null || raw === "") return null;
      return String(raw).trim() || null;
    })();
    /**
     * earnings_audit_log is reserved for leave / SC / CTO ledger rows,
     * but employee-facing “tardiness audit” should live in audit_log + transaction_table only.
     * (UI pulls tardiness audit rows from earnings_audit_log; skipping here removes those rows.)
     */
    const payloadEntryType = String(payload?.entry_type || payload?.entryType || "").toUpperCase();
    const isTardinessLeaveAction =
      String(type || "").toLowerCase() === "leave" &&
      (payloadEntryType === "TARDINESS_DEDUCTION" || /\btardiness\b/i.test(String(action || "")));
    const extras =
      auditExtras && typeof auditExtras === "object" ? auditExtras : {};

    if (!isTardinessLeaveAction && !isScCtoDeductionPayload(type, payload)) {
      // Store also in earnings_audit_log (dedicated earnings audit trail)
      const { actionSuffix, notes } = getEarningsAuditMeta(type, payload);
      const txNote =
        typeof extras.transaction_message === "string"
          ? extras.transaction_message.trim()
          : "";
      insertEarningsAuditLog(
        type,
        id,
        `${action}${actionSuffix}`,
        oldStatus,
        newStatus,
        actor,
        txNote || notes,
        { ...payload, targetEmployeeNumber },
      );
    }
    let details;
    try {
      details = JSON.stringify({
        type,
        actor_employeeNumber: actor,
        target_employeeNumber: targetEmployeeNumber,
        old_status: oldStatus,
        new_status: newStatus,
        payload,
        ...extras,
      });
    } catch (e) {
      details = JSON.stringify({
        type,
        actor_employeeNumber: actor,
        target_employeeNumber: targetEmployeeNumber,
        old_status: oldStatus,
        new_status: newStatus,
        payload_omitted: true,
        serialization_error: String(e && e.message),
      });
    }
    logAudit(
      { employeeNumber: actor },
      action,
      `earnings_${type}`,
      id,
      targetEmployeeNumber,
      details,
    );
  };

  /**
   * Half-day policy applies are stored in audit_log (leave_transaction), not earnings_audit_log.
   * Re-shape to match earnings_audit_log so the Earnings Records column mapper still works.
   */
  const pseudoHalfDayFromLeaveTransactionRow = (alRow) => {
    if (!alRow || String(alRow.table_name || "").toLowerCase() !== "leave_transaction") return null;
    const d = parseJsonSafe(alRow.details_json);
    const did = parseInt(d.deduction_decision_log_id, 10);
    if (!Number.isFinite(did) || did <= 0) return null;
    const target = String(alRow.targetEmployeeNumber || "").trim();
    const payloadObj = {
      employeeNumber: target,
      employee_number: target,
      charge_to: d.charge_to,
      deducted_hours: d.deducted_hours,
      leave_date: d.leave_date,
      salary_deduction: d.salary_deduction,
      available_hours_after: d.available_hours_after,
    };
    let payloadStr;
    try {
      payloadStr = JSON.stringify(payloadObj);
    } catch {
      return null;
    }
    return {
      id: alRow.id,
      earning_type: "half_day_policy",
      earning_id: String(did),
      action: "half_day_deduction_apply",
      old_status: null,
      new_status: "accepted",
      actor: alRow.employeeNumber,
      notes: (typeof d.message === "string" && d.message) || alRow.action || "",
      payload: payloadStr,
      created_at: alRow.created_at,
    };
  };

  // ─── Earnings audit trail API ────────────────────────────────────────────────
  // GET /api/earnings/audit/:type/:earningId
  router.get("/audit/:type/:earningId", authenticateToken, requireAdmin, (req, res) => {
    const { type, earningId } = req.params;
    if (!type || earningId === undefined || earningId === null || String(earningId).trim() === "") {
      return res.status(400).json({ error: "type and earningId are required" });
    }
    const tLower = String(type).toLowerCase();
    const eidStr = String(earningId).trim();

    // Leave / SC / CTO: earning_id in DB is the target employeeNumber; row PK is only in payload (id / *_earning_id).
    if (tLower === "leave" || tLower === "sc" || tLower === "cto") {
      const idNum = parseInt(eidStr, 10);
      const fkField =
        { sc: "sc_earning_id", cto: "cto_earning_id", leave: "leave_earning_id" }[tLower] ||
        "leave_earning_id";
      const parts = [`TRIM(CAST(earning_id AS CHAR)) = TRIM(?)`];
      const params = [tLower, eidStr];
      if (Number.isFinite(idNum) && idNum > 0) {
        const idNeedles = [
          `"id":${idNum},`,
          `"id":${idNum}}`,
          `"id": ${idNum},`,
          `"id": ${idNum}}`,
          `"${fkField}":${idNum},`,
          `"${fkField}":${idNum}}`,
          `"${fkField}": ${idNum},`,
          `"${fkField}": ${idNum}}`,
        ];
        const ph = idNeedles.map(() => "INSTR(payload, ?) > 0").join(" OR ");
        parts.push(`(payload IS NOT NULL AND (${ph}))`);
        params.push(...idNeedles);
      }
      const sql = `SELECT * FROM earnings_audit_log WHERE earning_type = ? AND (${parts.join(" OR ")}) ORDER BY id ASC`;
      db.query(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch earnings audit log" });
        const raw = Array.isArray(rows) ? rows : [];
        res.json(raw.filter((r) => !isScCtoDeductionEarningsAuditRow(r)));
      });
      return;
    }

    const eidNum = parseInt(earningId, 10);
    if (!Number.isFinite(eidNum)) {
      return res.status(400).json({ error: "earningId must be numeric for this lookup" });
    }
    db.query(
      `SELECT *
       FROM earnings_audit_log
       WHERE earning_type = ? AND earning_id = ?
       ORDER BY id ASC`,
      [tLower, String(eidNum)],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch earnings audit log" });
        const list = (Array.isArray(rows) ? rows : []).filter((r) => !isScCtoDeductionEarningsAuditRow(r));
        if (list.length > 0 || tLower !== "half_day_policy") {
          return res.json(list);
        }
        const needle = `"deduction_decision_log_id":${eidNum}`;
        const needleSp = `"deduction_decision_log_id": ${eidNum}`;
        db.query(
          `SELECT id, employeeNumber, action, table_name, record_id, targetEmployeeNumber,
                  details_json, timestamp AS created_at
             FROM audit_log
            WHERE table_name = 'leave_transaction'
              AND details_json IS NOT NULL
              AND (INSTR(details_json, ?) > 0 OR INSTR(details_json, ?) > 0)
            ORDER BY timestamp DESC
            LIMIT 1`,
          [needle, needleSp],
          (e2, alRows) => {
            if (e2 || !alRows || !alRows[0]) return res.json([]);
            const pseudo = pseudoHalfDayFromLeaveTransactionRow(alRows[0]);
            if (!pseudo) return res.json([]);
            res.json([
              {
                id: pseudo.id,
                earning_type: pseudo.earning_type,
                earning_id: pseudo.earning_id,
                action: pseudo.action,
                old_status: pseudo.old_status,
                new_status: pseudo.new_status,
                actor: pseudo.actor,
                notes: pseudo.notes,
                payload: pseudo.payload,
                created_at: pseudo.created_at,
              },
            ]);
          },
        );
      },
    );
  });

  const rowMatchesEarningsAuditPeriod = (row, y, m) => {
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return true;
    if (!row || !row.payload) return false;
    let p;
    try {
      p = JSON.parse(row.payload);
    } catch {
      return false;
    }
    if (Number(p.period_year) === y && Number(p.period_month) === m) return true;
    const ld = p.leave_date;
    if (ld) {
      const s = String(ld).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const yy = parseInt(s.slice(0, 4), 10);
        const mm = parseInt(s.slice(5, 7), 10);
        if (yy === y && mm === m) return true;
      }
    }
    return false;
  };

  /**
   * GET /api/earnings/deduction-ui-audit/:employeeNumber?year=&month=
   * @deprecated Prefer period-audit-for-records — kept for older clients.
   */
  router.get("/deduction-ui-audit/:employeeNumber", authenticateToken, requireAdmin, (req, res) => {
    const emp = String(req.params.employeeNumber || "").trim();
    const y = parseInt(req.query.year, 10);
    const m = parseInt(req.query.month, 10);
    if (!emp) return res.status(400).json({ error: "employeeNumber is required" });
    const needleEmp = emp.slice(0, 64);
    const pat1 = `"employee_number":"${needleEmp}"`;
    const pat2 = `"employeeNumber":"${needleEmp}"`;
    db.query(
      `SELECT id, earning_type, earning_id, action, old_status, new_status, actor, notes, payload, created_at
       FROM earnings_audit_log
       WHERE TRIM(CAST(earning_id AS CHAR)) = TRIM(?)
          OR (payload IS NOT NULL AND (INSTR(payload, ?) > 0 OR INSTR(payload, ?) > 0))
       ORDER BY id DESC
       LIMIT 400`,
      [needleEmp, pat1, pat2],
      (err, rows) => {
        if (err) {
          return res.status(500).json({ error: "Failed to load deduction UI audit rows" });
        }
        const list = Array.isArray(rows) ? rows : [];
        const filtered = list.filter((r) => {
          const et = String(r.earning_type || "");
          const act = String(r.action || "");
          const isReceipt =
            act.startsWith("deduction_receipt_confirm") ||
            et === "attendance_deduction_ui" ||
            et === "attendance";
          if (!isReceipt) return false;
          return rowMatchesEarningsAuditPeriod(r, y, m);
        });
        res.json(filtered);
      },
    );
  });

  /**
   * GET /api/earnings/period-audit-for-records/:employeeNumber?year=&month=
   * earnings_audit_log: leave + SC/CTO earning lifecycle only (not SC/CTO balance deductions).
   * Half-day policy: audit_log leave_transaction rows, reshaped here for the same UI mapper.
   */
  router.get("/period-audit-for-records/:employeeNumber", authenticateToken, requireAdmin, (req, res) => {
    const emp = String(req.params.employeeNumber || "").trim();
    const y = parseInt(req.query.year, 10);
    const m = parseInt(req.query.month, 10);
    if (!emp) return res.status(400).json({ error: "employeeNumber is required" });
    const needleEmp = emp.slice(0, 64);
    const pat1 = `"employee_number":"${needleEmp}"`;
    const pat2 = `"employeeNumber":"${needleEmp}"`;
    db.query(
      `SELECT id, earning_type, earning_id, action, old_status, new_status, actor, notes, payload, created_at
       FROM earnings_audit_log
       WHERE LOWER(TRIM(earning_type)) IN ('leave', 'sc', 'cto')
         AND (
           TRIM(CAST(earning_id AS CHAR)) = TRIM(?)
           OR (payload IS NOT NULL AND (INSTR(payload, ?) > 0 OR INSTR(payload, ?) > 0))
         )
       ORDER BY id DESC
       LIMIT 400`,
      [needleEmp, pat1, pat2],
      (err, rows) => {
        if (err) {
          return res.status(500).json({ error: "Failed to load period earnings audit rows" });
        }
        const list = Array.isArray(rows) ? rows : [];
        const filteredEal = list.filter(
          (r) => rowMatchesEarningsAuditPeriod(r, y, m) && !isScCtoDeductionEarningsAuditRow(r),
        );

        db.query(
          `SELECT id, employeeNumber, action, table_name, record_id, targetEmployeeNumber,
                  details_json, timestamp AS created_at
             FROM audit_log
            WHERE table_name = 'leave_transaction'
              AND TRIM(CAST(targetEmployeeNumber AS CHAR)) = TRIM(?)
            ORDER BY timestamp DESC
            LIMIT 400`,
          [needleEmp],
          (err2, alRows) => {
            if (err2) {
              console.error("[earnings] period-audit audit_log:", err2.message);
              return res.json(filteredEal);
            }
            const byDecisionId = new Map();
            for (const alRow of alRows || []) {
              const pseudo = pseudoHalfDayFromLeaveTransactionRow(alRow);
              if (!pseudo || !rowMatchesEarningsAuditPeriod(pseudo, y, m)) continue;
              const prev = byDecisionId.get(pseudo.earning_id);
              if (
                !prev ||
                new Date(pseudo.created_at || 0).getTime() > new Date(prev.created_at || 0).getTime()
              ) {
                byDecisionId.set(pseudo.earning_id, pseudo);
              }
            }
            const merged = [...filteredEal, ...byDecisionId.values()].sort(
              (a, b) =>
                new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
            );
            res.json(merged);
          },
        );
      },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  ATTENDANCE CONTEXT — GET
  //  GET /api/earnings/attendance/:employeeNumber?year=2026&month=4
  //  Uses overlap logic so payroll periods don't need to align to calendar month
  // ══════════════════════════════════════════════════════════════════════════════
  router.get("/attendance/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(), 10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);

    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay   = new Date(year, month, 0).getDate();
    const endDate   = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Overlap query: find the payroll period whose window overlaps this calendar month
    const summaryQuery = `
      SELECT *
      FROM overall_attendance_record
      WHERE personID = ?
        AND startDate <= ?
        AND endDate   >= ?
      ORDER BY
        ABS(DATEDIFF(startDate, ?)) ASC,
        startDate DESC
      LIMIT 1
    `;

    db.query(summaryQuery, [employeeNumber, endDate, startDate, startDate], (err, summaryRows) => {
      const summary = (!err && summaryRows && summaryRows[0]) ? summaryRows[0] : null;

      const dailyQuery = `
        SELECT
          ar.date,
          ar.personID,
          ar.timeIN,
          ar.breaktimeIN,
          ar.breaktimeOUT,
          ar.timeOUT,
          ar.specialType,
          ar.specialTimeIN,
          ar.specialTimeOUT,
          ot.officialTimeIN,
          ot.officialTimeOUT,
          ot.officialBreaktimeIN,
          ot.officialBreaktimeOUT,
          ot.officialOverTimeIN,
          ot.officialOverTimeOUT,
          CASE WHEN ar.timeIN IS NULL AND ar.timeOUT IS NULL THEN 1 ELSE 0 END AS is_absent,
          CASE
            WHEN ar.timeIN IS NOT NULL AND ot.officialTimeIN IS NOT NULL
              AND ar.timeIN > ot.officialTimeIN THEN 1
            ELSE 0
          END AS is_late,
          CASE
            WHEN ar.timeOUT IS NOT NULL AND ot.officialTimeOUT IS NOT NULL
              AND ar.timeOUT < ot.officialTimeOUT THEN 1
            ELSE 0
          END AS is_undertime,
          CASE WHEN ar.specialType IN ('OVERTIME','SERVICE') THEN 1 ELSE 0 END AS has_ot
        FROM attendancerecord ar
        LEFT JOIN officialtime ot
          ON ar.personID = ot.employeeID
          AND TRIM(DAYNAME(ar.date)) = TRIM(ot.day)
          AND ar.date BETWEEN ot.startDate AND ot.endDate
        WHERE ar.personID = ?
          AND ar.date >= ?
          AND ar.date <= ?
        ORDER BY ar.date ASC
      `;

      db.query(dailyQuery, [employeeNumber, startDate, endDate], (err2, dailyRows) => {
        const dailyRecords = (!err2 && dailyRows) ? dailyRows : [];

        const parseHHMM = (val) => {
          if (!val) return 0;
          const s = String(val).trim();
          if (s.includes(":")) {
            const parts = s.split(":");
            return Number(parts[0]) + Number(parts[1] || 0) / 60 + Number(parts[2] || 0) / 3600;
          }
          return parseFloat(s) || 0;
        };
const presentCount  = dailyRecords.filter(r => !r.is_absent).length;
const absentCount   = dailyRecords.filter(r => r.is_absent).length;

// Also count working days that have NO record at all (truly absent - not even a null row)
// We use the overall_attendance summary to derive this:
// absent_days = (calendar days in period - weekends) - present days
// But simpler: use calendarDays from the summary period if available
const summaryStartDate = summary?.startDate;
const summaryEndDate   = summary?.endDate;

let unrecordedAbsences = 0;
if (summaryStartDate && summaryEndDate) {
  const start = new Date(summaryStartDate);
  const end   = new Date(summaryEndDate);
  let workingDays = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) workingDays++; // exclude Sun=0, Sat=6
  }
  // Days with a record (present or absent row)
  const recordedDays = dailyRecords.length;
  unrecordedAbsences = Math.max(0, workingDays - recordedDays);
}

const stats = {
  total_days:     dailyRecords.length,
  present_days:   presentCount,
  absent_days:    absentCount + unrecordedAbsences,
  late_days:      dailyRecords.filter(r => r.is_late).length,
  undertime_days: dailyRecords.filter(r => r.is_undertime).length,
  ot_days:        dailyRecords.filter(r => r.has_ot).length,
};

        const summaryParsed = summary ? {
          ot_hours:          parseHHMM(summary.totalRenderedOvertime),
          sc_hours:          parseHHMM(summary.totalRenderedServiceCredit),
          morning_hours:     parseHHMM(summary.totalRenderedTimeMorning),
          afternoon_hours:   parseHHMM(summary.totalRenderedTimeAfternoon),
          overall_hours:     parseHHMM(summary.overallRenderedOfficialTime),
          overall_tardiness: parseHHMM(summary.overallRenderedOfficialTimeTardiness),
        } : null;

        const absentDates = dailyRecords
          .filter(r => r.is_absent)
          .map(r => ({ date: r.date }));

        const lateDates = dailyRecords
          .filter(r => r.is_late)
          .map(r => ({
            date: r.date,
            timeIn: r.timeIN,
            officialTimeIn: r.officialTimeIN
          }));

        const otEntries = dailyRecords
          .filter(r => r.has_ot)
          .map(r => ({
            date: r.date,
            specialType: r.specialType,
            specialTimeIn: r.specialTimeIN,
            specialTimeOut: r.specialTimeOUT
          }));

        res.json({
          employeeNumber,
          year,
          month,
          period: { start: startDate, end: endDate },
          summary,
          summaryParsed,
          dailyRecords,
          absentDates,
          lateDates,
          otEntries,
          stats,
          context: "read-only — attendance context for earnings validation.",
          _matched_period: summary ? { startDate: summary.startDate, endDate: summary.endDate } : null,
        });
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  ATTENDANCE CONTEXT — PUT (EDIT & SYNC)
  //  PUT /api/earnings/attendance/:employeeNumber
  //  Body: { year, month, fields: { totalRenderedTimeMorning, ... } }
  //
  //  Finds the overlapping overall_attendance_record row and updates it in place.
  //  Emits a socket event so the Attendance Summary module auto-refreshes.
  // ══════════════════════════════════════════════════════════════════════════════
  router.put("/attendance/:employeeNumber", authenticateToken, requireAdmin, (req, res) => {
    const { employeeNumber } = req.params;
    const { year, month, fields } = req.body;

    if (!year || !month) {
      return res.status(400).json({ error: "year and month are required" });
    }

    if (!fields || typeof fields !== "object") {
      return res.status(400).json({ error: "fields object is required" });
    }

    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay   = new Date(year, month, 0).getDate();
    const endDate   = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Use same overlap logic as the GET endpoint
    const findQuery = `
      SELECT id, personID, startDate, endDate
      FROM overall_attendance_record
      WHERE personID = ?
        AND startDate <= ?
        AND endDate   >= ?
      ORDER BY
        ABS(DATEDIFF(startDate, ?)) ASC,
        startDate DESC
      LIMIT 1
    `;

    db.query(findQuery, [employeeNumber, endDate, startDate, startDate], (findErr, findRows) => {
      if (findErr) {
        console.error("Attendance find error:", findErr);
        return res.status(500).json({ error: "Database error while finding attendance record" });
      }

      if (!findRows || findRows.length === 0) {
        return res.status(404).json({
          error: `No attendance record found for employee ${employeeNumber} in ${year}-${String(month).padStart(2, "0")}. ` +
                `Make sure the overall_attendance_record exists for this period first.`
        });
      }

      const record = findRows[0];
      const recordId = record.id;

      // Fetch current state for audit diff
      db.query("SELECT * FROM overall_attendance_record WHERE id = ?", [recordId], (fetchErr, fetchRows) => {
        const oldRecord = (!fetchErr && fetchRows && fetchRows[0]) ? fetchRows[0] : {};

        // Build the update — only update fields that were provided (non-empty string)
        // This preserves fields not included in the edit form (e.g. honorarium)
        const updateFields = {};

        const timeFields = [
          "totalRenderedTimeMorning",
          "totalRenderedTimeMorningTardiness",
          "totalRenderedTimeAfternoon",
          "totalRenderedTimeAfternoonTardiness",
          "totalRenderedHonorarium",
          "totalRenderedHonorariumTardiness",
          "totalRenderedServiceCredit",
          "totalRenderedServiceCreditTardiness",
          "totalRenderedOvertime",
          "totalRenderedOvertimeTardiness",
          "overallRenderedOfficialTime",
          "overallRenderedOfficialTimeTardiness",
          "overallTotalOfficialSchedule",
        ];

        timeFields.forEach(field => {
          if (fields[field] !== undefined && fields[field] !== null) {
            // Accept both empty string (to clear) and HH:MM:SS values
            updateFields[field] = fields[field] === "" ? null : fields[field];
          }
        });

        if (Object.keys(updateFields).length === 0) {
          return res.status(400).json({ error: "No valid fields provided for update" });
        }

        // Build dynamic SET clause
        const setClauses = Object.keys(updateFields).map(f => `${f} = ?`).join(", ");
        const setValues  = Object.values(updateFields);

        const updateQuery = `
          UPDATE overall_attendance_record
          SET ${setClauses}
          WHERE id = ?
        `;

        db.query(updateQuery, [...setValues, recordId], (updateErr, updateResult) => {
          if (updateErr) {
            console.error("Attendance update error:", updateErr);
            return res.status(500).json({ error: "Failed to update attendance record" });
          }

          if (updateResult.affectedRows === 0) {
            return res.status(404).json({ error: "Record not found or no changes made" });
          }

          // Log audit trail with old vs new values
          const actor = getActorEmployeeNumber(req);
          const auditPayload = {
            record_id:   recordId,
            employee:    employeeNumber,
            period:      `${year}-${String(month).padStart(2, "0")}`,
            matched_period: { startDate: record.startDate, endDate: record.endDate },
            changed_fields: Object.keys(updateFields).reduce((acc, key) => {
              acc[key] = { from: oldRecord[key] || null, to: updateFields[key] };
              return acc;
            }, {}),
            updated_by: actor,
          };
          logAudit(
            { employeeNumber: actor },
            "updated",
            "overall_attendance_record",
            recordId,
            employeeNumber,
            JSON.stringify(auditPayload)
          );

          // Emit socket event so Attendance Summary module auto-refreshes in real time
          // Works if your express app has io attached via app.set("io", io)
          try {
            const io = getIo(req);
            if (io) {
              io.emit("attendanceChanged", {
                scope:       "overall_attendance_record",
                action:      "updated",
                personID:    employeeNumber,
                recordId,
                startDate:   record.startDate,
                endDate:     record.endDate,
                updatedBy:   actor,
                year,
                month,
              });
            }
          } catch (socketErr) {
            console.warn("Socket emit failed (non-fatal):", socketErr.message);
          }

          // Return the updated record
          db.query(
            "SELECT * FROM overall_attendance_record WHERE id = ?",
            [recordId],
            (refetchErr, refetchRows) => {
              const updated = (!refetchErr && refetchRows && refetchRows[0]) ? refetchRows[0] : { id: recordId };
              res.json({
                updated: true,
                recordId,
                employeeNumber,
                year,
                month,
                matched_period: { startDate: record.startDate, endDate: record.endDate },
                record: updated,
              });
            }
          );

          const workingDaysQuery = `
  WITH RECURSIVE dates AS (
    SELECT ? AS d
    UNION ALL SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM dates WHERE d < ?
  )
  SELECT COUNT(*) AS working_days
  FROM dates
  WHERE DAYOFWEEK(d) NOT IN (1, 7)
`;
        });
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  LEAVE EARNINGS
  // ══════════════════════════════════════════════════════════════════════════════

  /** Admin: all approved leave earnings for assignment balance summaries. */
  router.get("/leave/approved-summary", authenticateToken, requireAdmin, (req, res) => {
    db.query(
      `SELECT employee_number, leave_code, period_year, period_month, earned_hours, earn_status
       FROM leave_earnings
       WHERE earn_status = 'approved'
       AND (voided_at IS NULL AND COALESCE(voided,0) = 0)
       ORDER BY employee_number, leave_code, period_year DESC, period_month DESC`,
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch approved leave earnings" });
        res.json(Array.isArray(rows) ? rows : []);
      },
    );
  });

  router.get("/leave/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const now = new Date();
    const year  = req.query.year  || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const { status, all } = req.query;

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    const respond = (earnings) => {
      const balQuery = `
        SELECT * FROM leave_balance_summary
        WHERE employee_number = ?
          AND (? IS NULL OR period_year = ?)
          AND (? IS NULL OR period_month = ?)
      `;
      db.query(balQuery, [employeeNumber, year || null, year || null, month || null, month || null], (err2, balances) => {
        res.json({
          earnings,
          balances: err2 ? [] : (balances || []),
          period: { year: parseInt(year, 10), month: parseInt(month, 10) },
        });
      });
    };

    let query = `
      SELECT le.*, lt.leave_description
      FROM leave_earnings le
      LEFT JOIN leave_table lt ON lt.leave_code = le.leave_code
      WHERE le.employee_number = ?
    `;
    const params = [employeeNumber];

    if (all !== "true") {
      params.push(year);  query += ` AND le.period_year = ?`;
      params.push(month); query += ` AND le.period_month = ?`;
    }
    if (status) { params.push(status); query += ` AND le.earn_status = ?`; }
    query += ` ORDER BY le.period_year DESC, le.period_month DESC, le.created_at DESC`;

    db.query(query, params, (err, earnings) => {
      if (err) return res.status(500).json({ error: "Failed to fetch leave earnings" });

      // When viewing a calendar month, also surface ADJUSTMENT rows posted in a *different* month
      // that explicitly cover this month (remarks from LeaveEarnings: "ADJUSTMENT (missed {Month}) …").
      const yNum = parseInt(year, 10);
      const mNum = parseInt(month, 10);
      const shouldMerge =
        all !== "true" &&
        Number.isFinite(yNum) &&
        Number.isFinite(mNum) &&
        mNum >= 1 &&
        mNum <= 12;
      if (!shouldMerge) {
        const baseEarly = Array.isArray(earnings) ? earnings : [];
        if (all === "true") {
          return respond(baseEarly);
        }
        const yE = parseInt(year, 10);
        const mE = parseInt(month, 10);
        if (!Number.isFinite(yE) || !Number.isFinite(mE) || mE < 1 || mE > 12) {
          return respond(baseEarly);
        }
        return mergeHalfDayPolicyLeaveRows(
          employeeNumber,
          yE,
          mE,
          status,
          baseEarly,
          respond,
        );
      }

      const missedToken = `ADJUSTMENT (missed ${monthNames[mNum - 1]})`;
      let q2 = `
        SELECT le.*, lt.leave_description
        FROM leave_earnings le
        LEFT JOIN leave_table lt ON lt.leave_code = le.leave_code
        WHERE le.employee_number = ?
          AND le.period_year = ?
          AND UPPER(IFNULL(le.entry_type, '')) = 'ADJUSTMENT'
          AND le.earn_status IN ('pending','approved')
          AND le.period_month IS NOT NULL
          AND le.period_month <> ?
          AND le.remarks LIKE ?
      `;
      const p2 = [employeeNumber, yNum, mNum, `%${missedToken}%`];
      if (status) {
        q2 += ` AND le.earn_status = ?`;
        p2.push(status);
      }
      q2 += ` ORDER BY le.period_year DESC, le.period_month DESC, le.created_at DESC`;

      db.query(q2, p2, (e2, extra) => {
        const base = Array.isArray(earnings) ? earnings : [];
        const add = Array.isArray(extra) ? extra : [];
        const finishAdjustments = (mergedRows) => {
          mergeHalfDayPolicyLeaveRows(
            employeeNumber,
            yNum,
            mNum,
            status,
            mergedRows,
            respond,
          );
        };
        if (e2 || !add.length) {
          return finishAdjustments(base);
        }

        const byId = new Map();
        base.forEach((r) => {
          if (r && r.id != null) byId.set(Number(r.id), r);
        });
        add.forEach((r) => {
          if (!r || r.id == null) return;
          const id = Number(r.id);
          if (byId.has(id)) return;
          byId.set(id, {
            ...r,
            _covers_month: mNum,
            _posted_period_month: r.period_month,
          });
        });
        const merged = Array.from(byId.values()).sort((a, b) => {
          const tb = new Date(b.created_at || b.approved_at || 0).getTime();
          const ta = new Date(a.created_at || a.approved_at || 0).getTime();
          if (tb !== ta) return tb - ta;
          return Number(b.id) - Number(a.id);
        });
        finishAdjustments(merged);
      });
    });
  });

router.post("/leave", authenticateToken, requireAdmin, (req, res) => {
  const {
    employeeNumber,
    leave_code,
    earned_hours,
    period_year,
    period_month,
    entry_type = "EARNED",
    remarks,
  } = req.body;

  if (!employeeNumber || !leave_code || !period_year || !period_month) {
    return res.status(400).json({
      error: "employeeNumber, leave_code, period_year, period_month are required",
    });
  }

  const hrs = toNum(earned_hours);
  const py = parseInt(period_year, 10);
  const pm = parseInt(period_month, 10);
  const normalizedEntry = String(entry_type || "EARNED").toUpperCase();
  const isAdjustment = normalizedEntry === "ADJUSTMENT";

  const isDeduction =
    normalizedEntry === "TARDINESS_DEDUCTION" ||
    normalizedEntry === "DEDUCTION" ||
    normalizedEntry === "USED";

  if (!isDeduction && hrs <= 0) {
    return res.status(400).json({ error: "earned_hours must be > 0" });
  }

  if (isDeduction && hrs >= 0) {
    return res.status(400).json({
      error: "Deduction earned_hours must be negative",
    });
  }

  // Tardiness offsets: consume leave via leave_credit_usage only (no leave_earnings row).
  if (normalizedEntry === "TARDINESS_DEDUCTION") {
    const rec = {
      employee_number: employeeNumber,
      leave_code,
      earned_hours: hrs,
      period_year: py,
      period_month: pm,
      entry_type: normalizedEntry,
      remarks: remarks || null,
    };
    (async () => {
      try {
        const beforeHrs = await getLeaveRemainingHours(employeeNumber, leave_code);
        await runNegativeLeaveDeductionPipeline(req, rec, null);
        const afterHrs = await getLeaveRemainingHours(employeeNumber, leave_code);
        const deductedHrs = Math.abs(toNum(hrs));
        try {
          const io = getIo(req);
          if (io) {
            io.emit("leaveAssignmentChanged", {
              scope: "leave_assignment",
              action: "updated-from-tardiness-deduction",
              employeeNumber,
              leave_code,
              period_year: py,
              period_month: pm,
            });
          }
        } catch (_emitErr) {}
        emitEarningsChanged("tardiness_deduction_applied", {
          module: "leave",
          employeeNumber: String(employeeNumber),
          period_year: py,
          period_month: pm,
        });
        const actorEmpNum = getActorEmployeeNumber(req);
        const [actorName, targetName] = await Promise.all([
          getEmployeeFullName(actorEmpNum),
          getEmployeeFullName(employeeNumber),
        ]);
        const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
        const targetDisplay = formatUserDisplayName(employeeNumber, targetName);
        const txMessageBase = buildEarningsTransactionMessage({
          actionLabel: "applied",
          actorDisplay,
          targetDisplay,
          earningTypeLabel: "tardiness leave deduction",
          hoursValue: hrs,
          leaveCode: leave_code,
          periodYear: py,
          periodMonth: pm,
        });
        const txMessage =
          `${txMessageBase}. ` +
          `Balance updated: ${beforeHrs.toFixed(3)} hrs → ${afterHrs.toFixed(3)} hrs (−${deductedHrs.toFixed(3)} hrs).`;
        await insertTransactionLog(employeeNumber, txMessage, actorEmpNum);
        auditEarning(
          req,
          "applied tardiness leave deduction",
          "leave",
          null,
          null,
          "approved",
          {
            employee_number: employeeNumber,
            leave_code,
            earned_hours: hrs,
            period_year: py,
            period_month: pm,
            entry_type: normalizedEntry,
            remarks: remarks || null,
            ledger_only: true,
          },
          { transaction_message: txMessage },
        );
        res.status(201).json({
          id: null,
          employee_number: employeeNumber,
          leave_code,
          earned_hours: hrs,
          period_year: py,
          period_month: pm,
          entry_type: normalizedEntry,
          earn_status: "approved",
          applied_via: "leave_credit_usage",
          remarks: remarks || null,
        });
      } catch (e) {
        console.error("[earnings] tardiness deduction direct:", e.message);
        res.status(500).json({ error: e.message || "Failed to apply tardiness deduction" });
      }
    })();
    return;
  }

  const doInsert = () => {
    const query = `
      INSERT INTO leave_earnings
        (employee_number, leave_code, earned_hours, period_year, period_month, entry_type, earn_status, remarks, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `;

    db.query(
      query,
      [
        employeeNumber,
        leave_code,
        hrs,
        period_year,
        parseInt(period_month),
        normalizedEntry,
        remarks || null,
        req.user?.username || null,
      ],
      (err, result) => {
        if (err) {
          console.error("Leave earning insert error:", err);
          return res.status(500).json({ error: "Failed to create leave earning" });
        }

        const earningPayload = {
          employeeNumber,
          leave_code,
          earned_hours: hrs,
          entry_type: normalizedEntry,
          period_year,
          period_month: parseInt(period_month),
          remarks: remarks || null,
          leave_earning_id: result.insertId,
        };

        (async () => {
          const actorEmpNum = getActorEmployeeNumber(req);
          const [actorName, targetName] = await Promise.all([
            getEmployeeFullName(actorEmpNum),
            getEmployeeFullName(employeeNumber),
          ]);
          const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
          const targetDisplay = formatUserDisplayName(employeeNumber, targetName);
          const txMessage = buildEarningsTransactionMessage({
            actionLabel: "created",
            actorDisplay,
            targetDisplay,
            earningTypeLabel: "leave earnings",
            hoursValue: hrs,
            leaveCode: leave_code,
            periodYear: period_year,
            periodMonth: parseInt(period_month),
          });
          auditEarning(
            req,
            "created leave earnings",
            "leave",
            result.insertId,
            null,
            "pending",
            earningPayload,
            { transaction_message: txMessage },
          );
          await insertTransactionLog(employeeNumber, txMessage, actorEmpNum);
        })();

        emitEarningsChanged("created", {
          module: "leave",
          employeeNumber: String(employeeNumber),
          period_year: py,
          period_month: pm,
        });

        res.status(201).json({
          id: result.insertId,
          employee_number: employeeNumber,
          leave_code,
          earned_hours: hrs,
          period_year,
          period_month: parseInt(period_month),
          entry_type: normalizedEntry,
          earn_status: "pending",
          remarks: remarks || null,
        });
      },
    );
  };

  // Rule 1 (Production): No backdated insert if later period exists.
  // If an admin needs to record a missed earning for a closed month, use ADJUSTMENT in the current period.
  if (!isDeduction && !isAdjustment && Number.isFinite(py) && Number.isFinite(pm)) {
    db.query(
      `SELECT
         MAX(CAST(period_semester AS UNSIGNED)) AS max_month
       FROM leave_assignment
       WHERE employeeNumber = ?
         AND TRIM(leave_code) = TRIM(?)
         AND period_year = ?
         AND period_semester IS NOT NULL`,
      [employeeNumber, leave_code, py],
      (mxErr, mxRows) => {
        const maxMonth = !mxErr && mxRows && mxRows[0] ? parseInt(mxRows[0].max_month, 10) : null;
        if (Number.isFinite(maxMonth) && maxMonth > pm) {
          // Suggest the month where earnings "stopped" (latest existing earning month),
          // falling back to the latest assignment month when no earnings exist.
          db.query(
            `SELECT MAX(period_month) AS last_earn_month
             FROM leave_earnings
             WHERE employee_number = ?
               AND TRIM(leave_code) = TRIM(?)
               AND period_year = ?
               AND period_month IS NOT NULL
               AND earn_status IN ('pending','approved')
               AND entry_type IN ('EARNED','ADJUSTMENT')`,
            [employeeNumber, leave_code, py],
            (e2, r2) => {
              const lastEarnMonth =
                !e2 && r2 && r2[0] && r2[0].last_earn_month != null
                  ? parseInt(r2[0].last_earn_month, 10)
                  : null;
              const suggested =
                Number.isFinite(lastEarnMonth) && lastEarnMonth >= pm
                  ? lastEarnMonth
                  : maxMonth;
              return res.status(409).json({
                code: "PERIOD_CLOSED",
                error:
                  "This period is already closed. Please add the missed earning as an adjustment in the month where earnings stopped.",
                period_year: py,
                requested_month: pm,
                suggested_month: suggested,
              });
            },
          );
          return;
        }

        return doInsert();
      }
    );
    return;
  }

  // Non-backdated case: insert immediately
  return doInsert();
});

router.patch("/leave/:id/approve", authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  db.query("SELECT * FROM leave_earnings WHERE id = ?", [id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ error: "Record not found" });
    const rec = rows[0];
    if (rec.earn_status === "approved") return res.status(400).json({ error: "Already approved" });
    if (Number(rec.is_applied) === 1) return res.status(400).json({ error: "Earning already applied to assignment" });

    db.query(
      `UPDATE leave_earnings SET earn_status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
      [req.user?.username || null, id],
      (err2) => {
        if (err2) return res.status(500).json({ error: "Failed to approve" });

        const earnedHrs   = toNum(rec.earned_hours);
        const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;

        (async () => {
          const beforeBalHrs = await getLeaveRemainingHours(rec.employee_number, rec.leave_code);

          let matched = await findPeriodAssignment({
            employeeNumber: rec.employee_number,
            leaveCode: rec.leave_code,
            periodYear: rec.period_year,
            periodMonth,
          });

          if (!matched && periodMonth) {
            matched = await ensurePeriodAssignment({
              employeeNumber: rec.employee_number,
              leaveCode: rec.leave_code,
              periodYear: rec.period_year,
              periodMonth,
            });
          }

          const afterUpdate = async () => {
            await new Promise((resolve, reject) => {
              db.query(
                "UPDATE leave_earnings SET is_applied = 1 WHERE id = ?",
                [id],
                (e) => (e ? reject(e) : resolve()),
              );
            });

            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
            const targetDisplay = formatUserDisplayName(rec.employee_number, targetName);
            const txMessageBase = buildEarningsTransactionMessage({
              actionLabel: "approved",
              actorDisplay,
              targetDisplay,
              earningTypeLabel: "leave earnings",
              hoursValue: toNum(rec.earned_hours),
              leaveCode: rec.leave_code,
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            const afterBalHrs = await getLeaveRemainingHours(rec.employee_number, rec.leave_code);
            const delta = toNum(rec.earned_hours);
            const txMessage =
              `${txMessageBase}. ` +
              `Balance updated: ${beforeBalHrs.toFixed(3)} hrs → ${afterBalHrs.toFixed(3)} hrs (${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(3)} hrs).`;

            auditEarning(
              req,
              "approved leave earnings",
              "leave",
              parseInt(id),
              rec.earn_status,
              "approved",
              rec,
              { transaction_message: txMessage },
            );
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);

            try {
              const io = getIo(req);
              if (io) {
                io.emit("leaveAssignmentChanged", {
                  scope: "leave_assignment",
                  action: "updated-from-earnings-approval",
                  employeeNumber: rec.employee_number,
                  leave_code: rec.leave_code,
                  period_year: rec.period_year,
                  period_month: rec.period_month,
                  earning_id: parseInt(id, 10),
                });
              }
            } catch (emitErr) {
              // non-fatal
            }

            emitEarningsChanged("approved", {
              module: "leave",
              employeeNumber: String(rec.employee_number),
              period_year: rec.period_year,
              period_month: rec.period_month,
              earning_id: parseInt(id, 10),
            });

            db.query("SELECT * FROM leave_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
          };

          if (earnedHrs >= 0) {
            if (!matched) {
              matched = await ensurePeriodAssignment({
                employeeNumber: rec.employee_number,
                leaveCode: rec.leave_code,
                periodYear: rec.period_year,
                periodMonth: periodMonth || 0,
              });
            }
            if (!matched) throw new Error("Could not find or create assignment for earning period");

            const repaired = await repairPeriodCarryForwardIfEmpty(db, matched);
            // BUGFIX: recomputeAssignmentLedgerFields only derives total/remaining from the
            // assignment's EXISTING allocated_hours — it never added the earning being
            // approved right now. That made every positive-earning approval a no-op (or, if
            // repairPeriodCarryForwardIfEmpty rewrote carried_forward_hours in the same call,
            // an actual regression) on the employee's real, spendable balance — confirmed
            // against production transaction_table history (e.g. "Balance updated: 48.000
            // hrs -> 48.000 hrs (+10.000 hrs)"). Fold the approved amount into allocated_hours
            // BEFORE recomputing so it actually lands in the stored/spendable balance.
            const withEarning = {
              ...repaired,
              allocated_hours: toNum(repaired.allocated_hours) + earnedHrs,
            };
            const recomputed = await recomputeAssignmentLedgerFields(db, withEarning);
            await new Promise((resolve, reject) => {
              db.query(
                `UPDATE leave_assignment SET
                   allocated_hours = ?, total_hours = ?, remaining_hours = ?,
                   carried_forward_hours = ?, earning_status = ?,
                   allocated_days = ?, total_days = ?, remaining_days = ?, carried_forward_days = ?
                 WHERE id = ?`,
                [
                  recomputed.allocated_hours,
                  recomputed.total_hours,
                  recomputed.remaining_hours,
                  recomputed.carried_forward_hours,
                  recomputed.earning_status,
                  // [NEW] Days-equivalent shadow columns — this is the fix for the
                  // "earning_status turns to 1 but total/remaining/allocated_days reset to 0" bug.
                  toDaysVal(recomputed.allocated_hours),
                  toDaysVal(recomputed.total_hours),
                  toDaysVal(recomputed.remaining_hours),
                  toDaysVal(recomputed.carried_forward_hours),
                  matched.id,
                ],
                (e) => (e ? reject(e) : resolve()),
              );
            });
            // If later periods already exist (out-of-order approval — e.g. a missed month
            // approved after next month's assignment row was already created), their opening
            // balance was carried forward from THIS period's pre-earning total. Bump them too
            // so the running ledger chain stays correct instead of silently under-crediting
            // forward. (This function already existed but was never called anywhere.)
            await propagateEarnedHoursToLaterPeriods({
              employeeNumber: rec.employee_number,
              leaveCode: rec.leave_code,
              periodYear: rec.period_year,
              periodMonth,
              earnedHours: earnedHrs,
            });
            await afterUpdate();
          } else {
            try {
              await runNegativeLeaveDeductionPipeline(req, rec, parseInt(id, 10));
              await afterUpdate();
            } catch (e) {
              console.error("[earnings] leave deduction pipeline:", e.message);
              throw e;
            }
          }
        })().catch((e) => {
          console.error("[earnings] approve error:", e.message);
          res.status(500).json({ error: "Failed to approve earning", detail: e.message });
        });
      }
    );
  });
});

  router.patch("/leave/:id/reject", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    db.query("SELECT * FROM leave_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const oldStatus = rows[0].earn_status;

      db.query(
        `UPDATE leave_earnings SET earn_status = 'rejected', rejected_reason = ?, approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [reason || null, req.user?.username || null, id],
        (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to reject" });
          auditEarning(req, "rejected leave earnings", "leave", parseInt(id), oldStatus, "rejected", { ...rows[0], reason });
          emitEarningsChanged("rejected", {
            module: "leave",
            employeeNumber: String(rows[0].employee_number),
            period_year: rows[0].period_year,
            period_month: rows[0].period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rows[0].employee_number),
            ]);
            const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
            const targetDisplay = formatUserDisplayName(rows[0].employee_number, targetName);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "rejected",
              actorDisplay,
              targetDisplay,
              earningTypeLabel: "leave earnings",
              hoursValue: toNum(rows[0].earned_hours),
              leaveCode: rows[0].leave_code,
              periodYear: rows[0].period_year,
              periodMonth: rows[0].period_month,
            });
            await insertTransactionLog(rows[0].employee_number, txMessage, actorEmpNum);
          })();
          db.query("SELECT * FROM leave_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
        }
      );
    });
  });

  router.delete("/leave/:id", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query("SELECT * FROM leave_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const rec = rows[0];

      const doDelete = () => {
        db.query("DELETE FROM leave_earnings WHERE id = ?", [id], (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to delete" });
          auditEarning(req, "deleted leave earnings", "leave", parseInt(id), rec.earn_status, null, rec);
          emitEarningsChanged("deleted", {
            module: "leave",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
            const targetDisplay = formatUserDisplayName(rec.employee_number, targetName);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "deleted",
              actorDisplay,
              targetDisplay,
              earningTypeLabel: "leave earnings",
              hoursValue: toNum(rec.earned_hours),
              leaveCode: rec.leave_code,
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);
          })();
          res.json({ deleted: true, id: parseInt(id) });
        });
      };

      if (rec.earn_status === "approved") {
        const earnedHrs   = toNum(rec.earned_hours);
        const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;
        const findQuery   = periodMonth
          ? `SELECT * FROM leave_assignment WHERE employeeNumber = ? AND leave_code = ? AND period_year = ? AND (period_semester = ? OR period_semester = ?) ORDER BY id DESC LIMIT 1`
          : `SELECT * FROM leave_assignment WHERE employeeNumber = ? AND leave_code = ? AND period_year = ? ORDER BY id DESC LIMIT 1`;
        const findParams  = periodMonth
          ? [rec.employee_number, rec.leave_code, rec.period_year, String(periodMonth), String(periodMonth).padStart(2, "0")]
          : [rec.employee_number, rec.leave_code, rec.period_year];

        db.query(findQuery, findParams, (err2, laRows) => {
          const matched = (!err2 && laRows && laRows[0]) ? laRows[0] : null;
          if (matched) {
            if (earnedHrs >= 0) {
              const prev = matched;
              const th = Math.max(0, toNum(prev.total_hours) - earnedHrs);
              const rh = Math.max(0, toNum(prev.remaining_hours) - earnedHrs);
              const ah = Math.max(0, toNum(prev.allocated_hours) - earnedHrs);
              const uh = Math.max(0, toNum(prev.used_hours));
              const cf = Math.max(0, toNum(prev.carried_forward_hours));
              const sem =
                prev.period_semester != null && prev.period_semester !== ""
                  ? String(prev.period_semester)
                  : periodMonth
                    ? String(periodMonth)
                    : null;
              db.query(
                `INSERT INTO leave_assignment
                  (employeeNumber, leave_code, total_hours, remaining_hours, used_hours, carried_forward_hours, allocated_hours, period_year, period_semester)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  rec.employee_number,
                  rec.leave_code,
                  th,
                  rh,
                  uh,
                  cf,
                  ah,
                  rec.period_year,
                  sem,
                ],
                doDelete,
              );
            } else {
              (async () => {
                const conn = await getPromiseConnection();
                let assignmentIds = [];
                try {
                  await conn.beginTransaction();
                  assignmentIds = await voidCreditUsageBySource(
                    conn,
                    "LEAVE_EARNING",
                    parseInt(id, 10),
                  );
                  for (const aid of assignmentIds) {
                    await refreshLeaveAssignmentCacheFromLedger(conn, aid);
                  }
                  await conn.commit();
                } catch (e) {
                  try {
                    await conn.rollback();
                  } catch (_r) {}
                  conn.release();
                  console.error("[earnings] void leave credit usage:", e.message);
                  return res.status(500).json({
                    error: "Failed to reverse deduction",
                    detail: e.message,
                  });
                }
                conn.release();

                if (assignmentIds.length > 0) {
                  return doDelete();
                }

                const deductionHours = Math.abs(earnedHrs);
                db.query(
                  `UPDATE leave_assignment SET
                    remaining_hours  = GREATEST(0, remaining_hours + ?),
                    used_hours       = GREATEST(0, used_hours - ?)
                  WHERE id = ?`,
                  [deductionHours, deductionHours, matched.id],
                  doDelete,
                );
              })();
            }
          } else {
            if (earnedHrs < 0) {
              (async () => {
                const conn = await getPromiseConnection();
                let assignmentIds = [];
                try {
                  await conn.beginTransaction();
                  assignmentIds = await voidCreditUsageBySource(
                    conn,
                    "LEAVE_EARNING",
                    parseInt(id, 10),
                  );
                  for (const aid of assignmentIds) {
                    await refreshLeaveAssignmentCacheFromLedger(conn, aid);
                  }
                  await conn.commit();
                } catch (e) {
                  try {
                    await conn.rollback();
                  } catch (_r) {}
                  conn.release();
                  console.error("[earnings] void leave credit usage:", e.message);
                  return res.status(500).json({
                    error: "Failed to reverse deduction",
                    detail: e.message,
                  });
                }
                conn.release();

                if (assignmentIds.length > 0) {
                  return doDelete();
                }

                const deductionHours = Math.abs(earnedHrs);
                db.query(
                  `SELECT id
                   FROM leave_assignment
                   WHERE employeeNumber = ?
                     AND TRIM(leave_code) = TRIM(?)
                     AND CAST(used_hours AS DECIMAL(12,4)) >= ?
                   ORDER BY period_year DESC, id DESC
                   LIMIT 1`,
                  [rec.employee_number, rec.leave_code, deductionHours],
                  (err3, donorRows) => {
                    const donor = !err3 && donorRows && donorRows[0] ? donorRows[0] : null;
                    if (!donor) return doDelete();
                    db.query(
                      `UPDATE leave_assignment SET
                        remaining_hours = GREATEST(0, remaining_hours + ?),
                        used_hours       = GREATEST(0, used_hours - ?)
                      WHERE id = ?`,
                      [deductionHours, deductionHours, donor.id],
                      doDelete,
                    );
                  },
                );
              })();
            } else {
              doDelete();
            }
          }
        });
      } else {
        doDelete();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  SC EARNINGS
  // ══════════════════════════════════════════════════════════════════════════════

  const ensureScPeriodRow = (rec) => ensureScPeriodRowAsync(db, rec);

 
  const refreshScPeriodLedger = async (periodRow) => {
    const ledger = await recomputeScLedgerFieldsAsync(db, periodRow);
    await scQueryAsync(
      db,
      `UPDATE service_credit SET
         total_hours = ?, remaining_hours = ?, earning_status = ?,
         earned_hours = ?, used_hours = ?, carried_forward_hours = ?
       WHERE id = ?`,
      [
        ledger.total_hours,
        ledger.remaining_hours,
        ledger.earning_status,
        ledger.earned_hours,
        ledger.used_hours,
        ledger.carried_forward_hours,
        periodRow.id,
      ],
    );
    return ledger;
  };

  /**
   * Negative SC balance adjustments: period snapshot row in service_credit + service_credit_usage.
   * scEarningRowId links usage remarks to sc_earning:{id} (legacy pending→approve). When null, remarks use
   * sc_direct_deduction:{ledgerRowId} — no sc_earnings row.
   */
  const applyScDeductionLedger = (req, res, rec, scEarningRowId, onDone) => {
    const earnedHrs = toNum(rec.earned_hours);
    const needScHrs = Math.abs(earnedHrs);
    const scType = rec.sc_type || "non_commutative";
    const periodMonth = rec.period_month != null ? parseInt(rec.period_month, 10) : null;
    const attendanceScEarningId =
      scEarningRowId != null && String(scEarningRowId).trim() !== ""
        ? parseInt(scEarningRowId, 10)
        : null;

    getServiceCreditRunningTotals(rec.employee_number, scType, (errSum, cur) => {
      if (errSum) {
        console.error("[earnings] SC deduction running totals:", errSum);
        return res.status(500).json({ error: "Failed to read service credit balance" });
      }
      const totalRemBefore = cur.remaining;

      const usageRemarkEarning =
        scEarningRowId != null ? `sc_earning:${scEarningRowId}` : null;
      const ledgerRemarksInitial =
        usageRemarkEarning != null
          ? [usageRemarkEarning, rec.remarks].filter(Boolean).join(" · ")
          : rec.remarks || null;

      (async () => {
        try {
          const emp = String(rec.employee_number || "").trim();
          let periodBase = await findLatestScPeriodRow(
            db,
            emp,
            scType,
            rec.period_year,
            periodMonth,
          );
          const { periods, earnings } = await loadScChainContextAsync(db, emp, scType);

          if (periodBase) {
            periodBase = alignScPeriodBaseForAppend(periodBase, periods, earnings);
            const fresh = await scQueryAsync(db, "SELECT * FROM service_credit WHERE id = ?", [periodBase.id]);
            if (fresh[0]) periodBase = { ...periodBase, ...fresh[0] };
          } else {
            const carry = getPriorPeriodScCarryForward(
              periods,
              earnings,
              rec.period_year,
              periodMonth,
            );
            periodBase = {
              employeeNumber: emp,
              sc_type: scType,
              period_year: rec.period_year,
              period_month: periodMonth,
              earned_hours: carry,
              carried_forward_hours: carry,
              used_hours: 0,
              total_ot_hours: 0,
              ot_hours_regular: 0,
              ot_hours_holiday: 0,
              ot_hours_night_diff: 0,
              emp_category_snapshot: rec.emp_category_snapshot || null,
            };
          }

          const usedBefore = toNum(periodBase.used_hours);
          const applyHrs = Math.min(needScHrs, Math.max(0, totalRemBefore));
          const scShortfallHrs = Math.max(0, needScHrs - totalRemBefore);
          const scNegBalDays = (totalRemBefore - needScHrs) / 8;
          const snapUsed = usedBefore + applyHrs;
          const snapRem = Math.max(0, totalRemBefore - applyHrs);

          const baseMeta = {
            needScHrs,
            scShortfallHrs,
            scNegBalDays,
            totalRemBefore,
            snapRem,
            applyHrs,
            attendanceScEarningId: Number.isFinite(attendanceScEarningId) ? attendanceScEarningId : null,
            attendanceServiceCreditLedgerId: null,
          };

          if (applyHrs <= 0) {
            return onDone(baseMeta);
          }

          const existingDeduction = await findExistingScDeductionSnapshotAsync(
            db,
            emp,
            scType,
            rec.period_year,
            periodMonth,
            applyHrs,
            ledgerRemarksInitial,
          );
          if (existingDeduction?.id) {
            baseMeta.attendanceServiceCreditLedgerId = existingDeduction.id;
            return onDone(baseMeta);
          }

          const working = { ...periodBase, used_hours: snapUsed };
          const ledger = await recomputeScLedgerFieldsAsync(db, working);

          const newRow = await appendScLedgerSnapshotAsync(db, periodBase, ledger, {
            remarks: ledgerRemarksInitial,
            stampUsedDelta: applyHrs,
          });
          baseMeta.attendanceServiceCreditLedgerId = newRow.id;

          const usageRemark =
            usageRemarkEarning != null ? usageRemarkEarning : `sc_direct_deduction:${newRow.id}`;

          await scQueryAsync(
            db,
            `INSERT INTO service_credit_usage
             (service_credit_id, employeeNumber, action, hours_applied, target_leave_code, processed_by, remarks)
             VALUES (?,?,?,?,?,?,?)`,
            [
              newRow.id,
              emp,
              "offset",
              applyHrs,
              null,
              req.user?.username || null,
              usageRemark,
            ],
          );

          onDone(baseMeta);
        } catch (errIns) {
          console.error("[earnings] SC deduction ledger update:", errIns);
          res.status(500).json({ error: "Failed to record SC deduction ledger" });
        }
      })();
    });
  };

  router.get("/sc/all", authenticateToken, requireAdmin, (req, res) => {
    db.query(
      `SELECT * FROM sc_earnings ORDER BY period_year DESC, period_month DESC, created_at DESC`,
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch SC earnings" });
        res.json({ earnings: rows || [] });
      },
    );
  });

  router.get("/sc/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const now = new Date();
    const year  = req.query.year  || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const { status, all } = req.query;

    let query = `SELECT * FROM sc_earnings WHERE employee_number = ?`;
    const params = [employeeNumber];

    if (all !== "true") {
      params.push(year);  query += ` AND period_year = ?`;
      params.push(month); query += ` AND period_month = ?`;
    }
    if (status) { params.push(status); query += ` AND earn_status = ?`; }
    query += ` ORDER BY period_year DESC, period_month DESC, created_at DESC`;

    db.query(query, params, (err, earnings) => {
      if (err) return res.status(500).json({ error: "Failed to fetch SC earnings" });

      const ledgerParams = [employeeNumber];
      let ledgerSql = `
        SELECT u.id AS usage_id, u.hours_applied, u.remarks AS usage_remarks, u.processed_at,
               sc.period_year, sc.period_month, sc.remarks AS ledger_remarks, sc.sc_type
        FROM service_credit_usage u
        INNER JOIN service_credit sc ON sc.id = u.service_credit_id
        WHERE u.employeeNumber = ?
          AND u.action = 'offset'
          AND u.remarks LIKE 'sc_direct_deduction:%'
          AND sc.voided_at IS NULL
      `;
      if (all !== "true") {
        ledgerSql += ` AND sc.period_year = ? AND sc.period_month = ?`;
        ledgerParams.push(year, month);
      }
      ledgerSql += ` ORDER BY u.id DESC`;

      db.query(ledgerSql, ledgerParams, (errL, ledgerRows) => {
        const ledger_sc_deductions = (!errL && Array.isArray(ledgerRows) ? ledgerRows : []).map((row) => ({
          id: `sc-usage-${row.usage_id}`,
          employee_number: employeeNumber,
          sc_type: row.sc_type || "non_commutative",
          earned_hours: -toNum(row.hours_applied),
          period_year: row.period_year,
          period_month: row.period_month,
          entry_type: "DEDUCTION",
          earn_status: "approved",
          remarks: row.ledger_remarks || row.usage_remarks || "",
          created_at: row.processed_at,
          _from_service_credit_ledger: true,
          _usage_id: row.usage_id,
        }));

        loadScBalanceSummaryRows(employeeNumber, year, month, (err2, balances) => {
          res.json({
            earnings,
            ledger_sc_deductions,
            balances: err2 ? [] : (balances || []),
            period: { year: parseInt(year), month: parseInt(month) },
          });
        });
      });
    });
  });

  router.post("/sc", authenticateToken, requireAdmin, async (req, res) => {
    const { employeeNumber, sc_type = "non_commutative", ot_hours_regular = 0, ot_hours_holiday = 0, ot_hours_night_diff = 0, total_ot_hours, earned_hours, period_year, period_month, remarks, emp_category_snapshot } = req.body;

    if (!employeeNumber || !period_year || !period_month)
      return res.status(400).json({ error: "employeeNumber, period_year, and period_month are required" });

  const earnedHrs = toNum(earned_hours);
    const entry_type_val = req.body.entry_type || "EARNED";
    const isDeduction = entry_type_val === "DEDUCTION";
    if (!isDeduction && earnedHrs <= 0) return res.status(400).json({ error: "earned_hours must be > 0" });
    if (isDeduction && earnedHrs >= 0) return res.status(400).json({ error: "Deduction earned_hours must be negative" });

    if (!isDeduction) {
      try {
        const pm = parseInt(period_month, 10);
        const allRows = await scQueryAsync(
          db,
          "SELECT * FROM service_credit WHERE employeeNumber = ? AND sc_type = ?",
          [String(employeeNumber), sc_type],
        );
        if (isScPeriodKeyClosed(allRows, period_year, pm, sc_type)) {
          return res.status(400).json({
            error: "This period is voided or commuted and cannot receive new credits.",
          });
        }
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (isDeduction) {
      const rec = {
        employee_number: employeeNumber,
        sc_type,
        earned_hours: earnedHrs,
        period_year,
        period_month: parseInt(period_month, 10),
        remarks: remarks || null,
        emp_category_snapshot: emp_category_snapshot ? JSON.stringify(emp_category_snapshot) : null,
      };
      const pm = parseInt(period_month, 10);
      return applyScDeductionLedger(req, res, rec, null, (meta) => {
        (async () => {
          try {
            if (Number.isFinite(pm) && pm >= 1 && pm <= 12) {
              await attendanceWriter.upsertFromScEarningDeduction({
                employee_number: rec.employee_number,
                sc_earning_id: meta.attendanceScEarningId,
                service_credit_ledger_id: meta.attendanceServiceCreditLedgerId,
                period_year: rec.period_year,
                period_month: pm,
                remarks: rec.remarks,
                need_hours: meta.needScHrs,
                shortfall_hours: meta.scShortfallHrs,
              });
              if (meta.scShortfallHrs > 0) {
                await recordLeaveSalaryShortfall(req, {
                  employee_number: rec.employee_number,
                  period_year: rec.period_year,
                  period_month: pm,
                  negative_balance_days: meta.scNegBalDays,
                  shortfall_hours: meta.scShortfallHrs,
                  leave_code: "SC",
                  entry_type: "ATTENDANCE_SC_SALARY_SHORTFALL",
                  leave_earning_id: null,
                  remarks: rec.remarks,
                });
              }
            }
          } catch (e) {
            console.error("[earnings] SC direct deduction finalize:", e.message);
          }
          const actorEmpNum = getActorEmployeeNumber(req);
          const [actorName, targetName] = await Promise.all([
            getEmployeeFullName(actorEmpNum),
            getEmployeeFullName(employeeNumber),
          ]);
          const txMessageBase = buildEarningsTransactionMessage({
            actionLabel: "applied",
            actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
            targetDisplay: formatUserDisplayName(employeeNumber, targetName),
            earningTypeLabel: "service credit balance deduction",
            hoursValue: earnedHrs,
            periodYear: period_year,
            periodMonth: pm,
          });
          const b0 = meta.totalRemBefore;
          const b1 = meta.snapRem;
          const dd = -meta.applyHrs;
          const withBal = `${txMessageBase}. Balance updated: ${b0.toFixed(3)} hrs → ${b1.toFixed(3)} hrs (${dd >= 0 ? "+" : "−"}${Math.abs(dd).toFixed(3)} hrs).`;
          await insertTransactionLog(employeeNumber, withBal, actorEmpNum);
          auditEarning(req, "applied service credit balance deduction", "sc", null, null, "approved", {
            employee_number: employeeNumber,
            employeeNumber,
            sc_type,
            earned_hours: earnedHrs,
            period_year,
            period_month: pm,
            entry_type: entry_type_val,
            remarks: remarks || null,
            ledger_only: true,
          }, { transaction_message: withBal });
          emitEarningsChanged("approved", {
            module: "sc",
            employeeNumber: String(employeeNumber),
            period_year,
            period_month: pm,
            earning_id: null,
          });
          res.status(201).json({
            id: null,
            employee_number: employeeNumber,
            sc_type,
            earned_hours: earnedHrs,
            period_year,
            period_month: pm,
            earn_status: "approved",
            applied_via: "service_credit_ledger",
            entry_type: entry_type_val,
            remarks: remarks || null,
          });
        })().catch((e) => {
          console.error("[earnings] SC POST deduction:", e.message);
          res.status(500).json({ error: e.message || "Failed to apply SC deduction" });
        });
      });
    }

    const query = `
      INSERT INTO sc_earnings
        (employee_number, sc_type, ot_hours_regular, ot_hours_holiday, ot_hours_night_diff, total_ot_hours, earned_hours, used_hours, period_year, period_month, earn_status, entry_type, remarks, emp_category_snapshot, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, ?)
    `;
    db.query(query, [
      employeeNumber, sc_type, toNum(ot_hours_regular), toNum(ot_hours_holiday), toNum(ot_hours_night_diff),
      toNum(total_ot_hours) || earnedHrs, earnedHrs, period_year, parseInt(period_month),
      entry_type_val, remarks || null, emp_category_snapshot ? JSON.stringify(emp_category_snapshot) : null, req.user?.username || null
    ], (err, result) => {
      if (err) return res.status(500).json({ error: "Failed to create SC earning" });
      const scCreatePayload = {
        employeeNumber,
        sc_type,
        earnedHrs,
        period_year,
        period_month: parseInt(period_month),
        sc_earning_id: result.insertId,
      };
      (async () => {
        const actorEmpNum = getActorEmployeeNumber(req);
        const [actorName, targetName] = await Promise.all([
          getEmployeeFullName(actorEmpNum),
          getEmployeeFullName(employeeNumber),
        ]);
        const txMessage = buildEarningsTransactionMessage({
          actionLabel: "created",
          actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
          targetDisplay: formatUserDisplayName(employeeNumber, targetName),
          earningTypeLabel: "service credit earnings",
          hoursValue: earnedHrs,
          periodYear: period_year,
          periodMonth: parseInt(period_month),
        });
        auditEarning(
          req,
          "created service credit earnings",
          "sc",
          result.insertId,
          null,
          "pending",
          scCreatePayload,
          { transaction_message: txMessage },
        );
        await insertTransactionLog(employeeNumber, txMessage, actorEmpNum);
      })();
      emitEarningsChanged("created", {
        module: "sc",
        employeeNumber: String(employeeNumber),
        period_year,
        period_month: parseInt(period_month, 10),
      });
      res.status(201).json({ id: result.insertId, employee_number: employeeNumber, sc_type, earned_hours: earnedHrs, period_year, period_month: parseInt(period_month), earn_status: "pending" });
    });
  });

  router.patch("/sc/:id/approve", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query("SELECT * FROM sc_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const rec = rows[0];
      if (rec.earn_status === "approved") return res.status(400).json({ error: "Already approved" });

      const earnedHrs   = toNum(rec.earned_hours);
      const scType      = rec.sc_type || "non_commutative";
      const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;
      const entryTypeUpper = String(rec.entry_type || "").toUpperCase();
      const isScDeductionApprove = entryTypeUpper === "DEDUCTION" && earnedHrs < 0;
      const scShortfallPm =
        periodMonth != null ? periodMonth : parseInt(rec.period_month, 10);

      const runScApproveFinalize = ({
            isScDeduction,
            needScHrs,
            scShortfallHrs,
            scNegBalDays,
            balBeforeHrs = null,
            balAfterHrs = null,
            balDeltaHrs = null,
            attendanceScEarningId,
            attendanceServiceCreditLedgerId,
          }) => {
            (async () => {
              try {
                if (
                  isScDeduction &&
                  Number.isFinite(scShortfallPm) &&
                  scShortfallPm >= 1 &&
                  scShortfallPm <= 12
                ) {
                  await attendanceWriter.upsertFromScEarningDeduction({
                    employee_number: rec.employee_number,
                    sc_earning_id: attendanceScEarningId,
                    service_credit_ledger_id: attendanceServiceCreditLedgerId,
                    period_year: rec.period_year,
                    period_month: scShortfallPm,
                    remarks: rec.remarks,
                    need_hours: needScHrs,
                    shortfall_hours: scShortfallHrs,
                  });
                  if (scShortfallHrs > 0) {
                    await recordLeaveSalaryShortfall(req, {
                      employee_number: rec.employee_number,
                      period_year: rec.period_year,
                      period_month: scShortfallPm,
                      negative_balance_days: scNegBalDays,
                      shortfall_hours: scShortfallHrs,
                      leave_code: "SC",
                      entry_type: "ATTENDANCE_SC_SALARY_SHORTFALL",
                      leave_earning_id: null,
                      remarks: rec.remarks,
                    });
                  }
                }
              } catch (e) {
                console.error("[earnings] leave_salary_shortfall (SC approve):", e.message);
              }
              const actorEmpNum = getActorEmployeeNumber(req);
              const [actorName, targetName] = await Promise.all([
                getEmployeeFullName(actorEmpNum),
                getEmployeeFullName(rec.employee_number),
              ]);
              const txMessageBase = buildEarningsTransactionMessage({
                actionLabel: "approved",
                actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
                targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
                earningTypeLabel: "service credit earnings",
                hoursValue: toNum(rec.earned_hours),
                periodYear: rec.period_year,
                periodMonth: rec.period_month,
              });
              const b0 = balBeforeHrs != null ? toNum(balBeforeHrs) : null;
              const b1 = balAfterHrs != null ? toNum(balAfterHrs) : null;
              const dd = balDeltaHrs != null ? toNum(balDeltaHrs) : null;
              const withBal =
                b0 != null && b1 != null && dd != null
                  ? `${txMessageBase}. Balance updated: ${b0.toFixed(3)} hrs → ${b1.toFixed(3)} hrs (${dd >= 0 ? "+" : "−"}${Math.abs(dd).toFixed(3)} hrs).`
                  : txMessageBase;
              auditEarning(
                req,
                "approved service credit earnings",
                "sc",
                parseInt(id),
                rec.earn_status,
                "approved",
                rec,
                { transaction_message: withBal },
              );
              await insertTransactionLog(rec.employee_number, withBal, actorEmpNum);
              emitEarningsChanged("approved", {
                module: "sc",
                employeeNumber: String(rec.employee_number),
                period_year: rec.period_year,
                period_month: rec.period_month,
                earning_id: parseInt(id, 10),
              });
              db.query("SELECT * FROM sc_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
            })().catch((e) => {
              console.error("[earnings] SC approve finalize:", e.message);
              res.status(500).json({ error: e.message || "Failed to finalize SC approval" });
            });
          };

      /** Ledger first, then mark approved + audit + transaction log (avoids approved rows with no audit_log). */
      const markScEarningApprovedThenFinalize = (finalizeArgs) => {
        db.query(
          `UPDATE sc_earnings SET earn_status = 'approved', approved_by = ?, approved_at = NOW(), is_applied = 1 WHERE id = ? AND earn_status = 'pending'`,
          [req.user?.username || null, id],
          (errUp, resultUp) => {
            if (errUp) return res.status(500).json({ error: "Failed to approve SC" });
            if (!resultUp || resultUp.affectedRows === 0) {
              return res.status(409).json({ error: "SC earning was already processed" });
            }
            (async () => {
              try {
                if (!finalizeArgs.skipLedgerRefresh) {
                  const periodRow = await findLatestScPeriodRow(
                    db,
                    rec.employee_number,
                    scType,
                    rec.period_year,
                    rec.period_month,
                  );
                  if (periodRow) await refreshScPeriodLedger(periodRow);
                }
              } catch (e) {
                console.error("[earnings] SC approve earning_status refresh:", e.message);
              }

              // BUGFIX: for the positive-earn path, balAfterHrs must be read AFTER
              // earn_status flips to 'approved' above — computeScBalances only sums
              // APPROVED sc_earnings rows, so reading it any earlier always produced the
              // same value as balBeforeHrs even though the credit itself is (and always
              // was) correctly counted from this point on. Confirmed against production
              // transaction_table history: every positive SC-earning approval logged an
              // unchanged "before -> after" balance despite a nonzero delta. The deduction
              // path already supplies its own accurate balAfterHrs from its own ledger
              // snapshot (applyScDeductionLedger) and is left untouched here.
              if (finalizeArgs.balAfterHrs == null) {
                try {
                  const freshTotals = await new Promise((resolve, reject) => {
                    getServiceCreditRunningTotals(rec.employee_number, scType, (e2, t) =>
                      e2 ? reject(e2) : resolve(t),
                    );
                  });
                  finalizeArgs = { ...finalizeArgs, balAfterHrs: toNum(freshTotals?.remaining) };
                } catch (e) {
                  console.error("[earnings] SC approve post-approval balance read:", e.message);
                }
              }

              runScApproveFinalize(finalizeArgs);
            })();
          },
        );
      };

      // DEDUCTION: append-only ledger row with full snapshot (earned, cumulative used, remaining after)
      if (isScDeductionApprove) {
        applyScDeductionLedger(req, res, rec, id, (meta) => {
          markScEarningApprovedThenFinalize({
            isScDeduction: true,
            skipLedgerRefresh: true,
            needScHrs: meta.needScHrs,
            scShortfallHrs: meta.scShortfallHrs,
            scNegBalDays: meta.scNegBalDays,
            balBeforeHrs: meta.totalRemBefore,
            balAfterHrs: meta.snapRem,
            balDeltaHrs: -meta.applyHrs,
            attendanceScEarningId: meta.attendanceScEarningId,
            attendanceServiceCreditLedgerId: meta.attendanceServiceCreditLedgerId,
          });
        });
        return;
      }

      // Positive earn: update period ledger flags only — do NOT insert earnings into service_credit.
      getServiceCreditRunningTotals(rec.employee_number, scType, (err3, cur) => {
        if (err3) {
          console.error("[earnings] SC approve running totals:", err3);
          return res.status(500).json({ error: "Failed to read service credit balance" });
        }
        const balBefore = toNum(cur.remaining);

        (async () => {
          try {
            await ensureScPeriodRow(rec);

            // balAfterHrs is intentionally omitted here — markScEarningApprovedThenFinalize
            // reads it fresh right after earn_status actually flips to 'approved', since
            // computeScBalances only counts approved sc_earnings (see BUGFIX comment there).
            markScEarningApprovedThenFinalize({
              isScDeduction: false,
              needScHrs: 0,
              scShortfallHrs: 0,
              scNegBalDays: 0,
              balBeforeHrs: balBefore,
              balDeltaHrs: earnedHrs,
            });
          } catch (e) {
            console.error("[earnings] SC approve period refresh:", e);
            res.status(500).json({ error: "Failed to update service credit period" });
          }
        })();
      });
    });
  });

  router.patch("/sc/:id/reject", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    db.query("SELECT * FROM sc_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const oldStatus = rows[0].earn_status;

      db.query(
        `UPDATE sc_earnings SET earn_status = 'rejected', rejected_reason = ?, approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [reason || null, req.user?.username || null, id],
        (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to reject SC" });
          auditEarning(req, "rejected service credit earnings", "sc", parseInt(id), oldStatus, "rejected", { ...rows[0], reason });
          emitEarningsChanged("rejected", {
            module: "sc",
            employeeNumber: String(rows[0].employee_number),
            period_year: rows[0].period_year,
            period_month: rows[0].period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rows[0].employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "rejected",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rows[0].employee_number, targetName),
              earningTypeLabel: "service credit earnings",
              hoursValue: toNum(rows[0].earned_hours),
              periodYear: rows[0].period_year,
              periodMonth: rows[0].period_month,
            });
            await insertTransactionLog(rows[0].employee_number, txMessage, actorEmpNum);
          })();
          db.query("SELECT * FROM sc_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
        }
      );
    });
  });

  router.delete("/sc/:id", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query("SELECT * FROM sc_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const rec = rows[0];

      const doVoid = () => {
        db.query("UPDATE sc_earnings SET voided_at = NOW(), voided = 1, is_applied = 0 WHERE id = ?", [id], (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to void SC earning" });
          auditEarning(req, "voided service credit earnings", "sc", parseInt(id), rec.earn_status, null, rec);
          emitEarningsChanged("deleted", {
            module: "sc",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "voided",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
              earningTypeLabel: "service credit earnings",
              hoursValue: toNum(rec.earned_hours),
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);
          })();
          res.json({ voided: true, id: parseInt(id) });
        });
      };

      if (rec.earn_status === "approved") {
        const earnedHrs   = toNum(rec.earned_hours);
        const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;
        const delEntryUpper = String(rec.entry_type || "").toUpperCase();
        const isScDeductionDel = delEntryUpper === "DEDUCTION" && earnedHrs < 0;

        if (isScDeductionDel) {
          (async () => {
            try {
              await reverseScDeductionEarningAsync(db, rec);
              await attendanceWriter.voidAttendanceResultsForScDeduction({ sc_earning_id: parseInt(id, 10) });
            } catch (e) {
              console.error("[earnings] SC deduction void reversal:", e);
            }
            auditEarning(req, "voided service credit earnings", "sc", parseInt(id), rec.earn_status, null, rec);
            emitEarningsChanged("deleted", {
              module: "sc",
              employeeNumber: String(rec.employee_number),
              period_year: rec.period_year,
              period_month: rec.period_month,
              earning_id: parseInt(id, 10),
            });
            res.json({ voided: true, id: parseInt(id) });
          })();
          return;
        }

        const scTypeDel = rec.sc_type || "non_commutative";
        (async () => {
          try {
            const reversal = await reverseScPeriodAttendanceDeductionsAsync(
              db,
              rec.employee_number,
              scTypeDel,
              rec.period_year,
              rec.period_month,
            );
            for (const eid of reversal.voidedEarningIds) {
              await attendanceWriter.voidAttendanceResultsForScDeduction({ sc_earning_id: eid });
            }
            for (const lid of reversal.voidedLedgerIds) {
              await attendanceWriter.voidAttendanceResultsForScDeduction({ service_credit_ledger_id: lid });
            }
            await scExecAsync(
              db,
              "UPDATE sc_earnings SET voided_at = NOW(), voided = 1, is_applied = 0 WHERE id = ?",
              [id],
            );
            const periodRow = await findLatestScPeriodRow(
              db,
              rec.employee_number,
              scTypeDel,
              rec.period_year,
              rec.period_month,
            );
            if (periodRow) await refreshScPeriodLedgerOnRow(db, periodRow);
          } catch (e) {
            console.error("[earnings] SC void earn cascade reversal:", e);
          }
          auditEarning(req, "voided service credit earnings", "sc", parseInt(id), rec.earn_status, null, rec);
          emitEarningsChanged("deleted", {
            module: "sc",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "voided",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
              earningTypeLabel: "service credit earnings",
              hoursValue: toNum(rec.earned_hours),
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);
          })();
          res.json({ voided: true, id: parseInt(id) });
        })();
      } else {
        doVoid();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  CTO EARNINGS
  // ══════════════════════════════════════════════════════════════════════════════

  const ensureCtoPeriodRow = (rec) => ensureCtoPeriodRowAsync(db, rec);

  const refreshCtoPeriodLedger = async (periodRow) => refreshCtoPeriodLedgerOnRow(db, periodRow);

  /**
   * CTO deductions: new cto_credit snapshot row (earned/used/remaining) + cto_usage, mirroring service_credit.
   * ctoEarningRowId links usage remarks to cto_earning:{id} (pending→approve). When null, remarks use
   * cto_direct_deduction:{ledgerRowId} — no cto_earnings row for direct POST.
   */
  const applyCtoDeductionLedger = (req, res, rec, ctoEarningRowId, onDone) => {
    const earnedHrs = toNum(rec.earned_hours);
    const needHrs = Math.abs(earnedHrs);
    const periodMonth = rec.period_month != null ? parseInt(rec.period_month, 10) : null;
    const attendanceCtoEarningId =
      ctoEarningRowId != null && String(ctoEarningRowId).trim() !== ""
        ? parseInt(ctoEarningRowId, 10)
        : null;

    getCtoCreditRunningTotals(rec.employee_number, (errSum, cur) => {
      if (errSum) {
        console.error("[earnings] CTO deduction running totals:", errSum);
        return res.status(500).json({ error: "Failed to read CTO balance" });
      }
      const totalRemBefore = cur.remaining;

      const usageRemarkEarning =
        ctoEarningRowId != null ? `cto_earning:${ctoEarningRowId}` : null;
      const ledgerRemarksInitial =
        usageRemarkEarning != null
          ? [usageRemarkEarning, rec.remarks].filter(Boolean).join(" · ")
          : rec.remarks || null;

      (async () => {
        try {
          const emp = String(rec.employee_number || "").trim();
          let periodBase = await findLatestCtoPeriodRow(
            db,
            emp,
            rec.period_year,
            periodMonth,
          );
          const { periods, earnings } = await loadCtoChainContextAsync(db, emp);

          if (periodBase) {
            periodBase = alignCtoPeriodBaseForAppend(periodBase, periods, earnings);
            const fresh = await ctoQueryAsync(db, "SELECT * FROM cto_credit WHERE id = ?", [periodBase.id]);
            if (fresh[0]) periodBase = { ...periodBase, ...fresh[0] };
          } else {
            const carry = getPriorPeriodCtoCarryForward(
              periods,
              earnings,
              rec.period_year,
              periodMonth,
            );
            periodBase = {
              employeeNumber: emp,
              period_year: rec.period_year,
              period_month: periodMonth,
              earned_hours: carry,
              carried_forward_hours: carry,
              used_hours: 0,
              ot_hours: 0,
              emp_category_snapshot: rec.emp_category_snapshot || null,
            };
          }

          const usedBefore = toNum(periodBase.used_hours);
          const applyHrs = Math.min(needHrs, Math.max(0, totalRemBefore));
          const ctoShortfallHrs = Math.max(0, needHrs - totalRemBefore);
          const ctoNegBalDays = (totalRemBefore - needHrs) / 8;
          const snapUsed = usedBefore + applyHrs;
          const snapRem = Math.max(0, totalRemBefore - applyHrs);

          const batchKey = `b:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;

          const baseMeta = {
            needCtoHrs: needHrs,
            ctoShortfallHrs,
            ctoNegBalDays,
            totalRemBefore,
            snapRem,
            applyHrs,
            attendanceCtoEarningId: Number.isFinite(attendanceCtoEarningId) ? attendanceCtoEarningId : null,
            attendanceCtoCreditLedgerId: null,
            attendanceCtoDeductionSourceKey: null,
          };

          if (applyHrs <= 0) {
            baseMeta.attendanceCtoDeductionSourceKey = batchKey;
            return onDone(baseMeta);
          }

          const existingDeduction = await findExistingCtoDeductionSnapshotAsync(
            db,
            emp,
            rec.period_year,
            periodMonth,
            applyHrs,
            ledgerRemarksInitial,
          );
          if (existingDeduction?.id) {
            baseMeta.attendanceCtoCreditLedgerId = existingDeduction.id;
            return onDone(baseMeta);
          }

          const working = { ...periodBase, used_hours: snapUsed };
          const ledger = await recomputeCtoLedgerFieldsAsync(db, working);

          const newRow = await appendCtoLedgerSnapshotAsync(db, periodBase, ledger, {
            remarks: ledgerRemarksInitial,
            stampUsedDelta: applyHrs,
          });
          baseMeta.attendanceCtoCreditLedgerId = newRow.id;

          const usageRemark =
            usageRemarkEarning != null ? usageRemarkEarning : `cto_direct_deduction:${newRow.id}`;

          await ctoQueryAsync(
            db,
            `INSERT INTO cto_usage (cto_credit_id, employeeNumber, action, hours_applied, date_used, remarks)
             VALUES (?,?,?,?,?,?)`,
            [
              newRow.id,
              emp,
              "offset",
              applyHrs,
              null,
              [usageRemark, rec.remarks].filter(Boolean).join(" · ") || usageRemark,
            ],
          );

          onDone(baseMeta);
        } catch (errIns) {
          console.error("[earnings] CTO deduction ledger update:", errIns);
          res.status(500).json({ error: "Failed to record CTO deduction ledger" });
        }
      })();
    });
  };

  router.get("/cto/all", authenticateToken, requireAdmin, (req, res) => {
    db.query(
      `SELECT * FROM cto_earnings ORDER BY period_year DESC, period_month DESC, created_at DESC`,
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch CTO earnings" });
        res.json({ earnings: rows || [] });
      },
    );
  });

  router.get("/cto/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const now = new Date();
    const year  = req.query.year  || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const { status, all } = req.query;

    let query = `SELECT * FROM cto_earnings WHERE employee_number = ?`;
    const params = [employeeNumber];

    if (all !== "true") {
      params.push(year);  query += ` AND period_year = ?`;
      params.push(month); query += ` AND period_month = ?`;
    }
    if (status) { params.push(status); query += ` AND earn_status = ?`; }
    query += ` ORDER BY period_year DESC, period_month DESC, created_at DESC`;

    db.query(query, params, (err, earnings) => {
      if (err) return res.status(500).json({ error: "Failed to fetch CTO earnings" });

      const ledgerParams = [employeeNumber];
      let ledgerSql = `
        SELECT u.id AS usage_id, u.hours_applied, u.remarks AS usage_remarks, u.processed_at,
               sc.period_year, sc.period_month
        FROM cto_usage u
        INNER JOIN cto_credit sc ON sc.id = u.cto_credit_id
        WHERE u.employeeNumber = ?
          AND u.action = 'offset'
          AND u.remarks LIKE 'cto_direct_deduction:%'
      `;
      if (all !== "true") {
        ledgerSql += ` AND sc.period_year = ? AND sc.period_month = ?`;
        ledgerParams.push(year, month);
      }
      ledgerSql += ` ORDER BY u.id DESC`;

      db.query(ledgerSql, ledgerParams, (errL, ledgerRows) => {
        const ledger_cto_deductions = (!errL && Array.isArray(ledgerRows) ? ledgerRows : []).map((row) => ({
          id: `cto-usage-${row.usage_id}`,
          employee_number: employeeNumber,
          earned_hours: -toNum(row.hours_applied),
          period_year: row.period_year,
          period_month: row.period_month,
          entry_type: "DEDUCTION",
          earn_status: "approved",
          remarks: row.usage_remarks || "",
          ot_hours: 0,
          created_at: row.processed_at,
          _from_cto_usage_ledger: true,
          _usage_id: row.usage_id,
        }));

        db.query(
          `SELECT * FROM cto_balance_summary WHERE employee_number = ? AND (? IS NULL OR period_year = ?) AND (? IS NULL OR period_month = ?)`,
          [employeeNumber, year || null, year || null, month || null, month || null],
          (err2, balances) => {
            res.json({
              earnings,
              ledger_cto_deductions,
              balances: err2 ? [] : (balances || []),
              period: { year: parseInt(year), month: parseInt(month) },
            });
          },
        );
      });
    });
  });

  router.post("/cto", authenticateToken, requireAdmin, async (req, res) => {
    const { employeeNumber, ot_hours, earned_hours, period_year, period_month, expiry_date, remarks, emp_category_snapshot } = req.body;

    if (!employeeNumber || !period_year || !period_month)
      return res.status(400).json({ error: "employeeNumber, period_year, and period_month are required" });

const earnedHrs = toNum(earned_hours || ot_hours);
    const entry_type_val = req.body.entry_type || "EARNED";
    const isDeduction = entry_type_val === "DEDUCTION";
    if (!isDeduction && earnedHrs <= 0) return res.status(400).json({ error: "earned_hours must be > 0" });
    if (isDeduction && earnedHrs >= 0) return res.status(400).json({ error: "Deduction earned_hours must be negative" });

    if (!isDeduction) {
      try {
        const pm = parseInt(period_month, 10);
        const allRows = await ctoQueryAsync(
          db,
          "SELECT * FROM cto_credit WHERE employeeNumber = ?",
          [String(employeeNumber)],
        );
        if (isCtoPeriodKeyClosed(allRows, period_year, pm)) {
          return res.status(400).json({
            error: "This period is voided or commuted and cannot receive new credits.",
          });
        }
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (isDeduction) {
      const rec = {
        employee_number: employeeNumber,
        earned_hours: earnedHrs,
        period_year,
        period_month: parseInt(period_month, 10),
        remarks: remarks || null,
        emp_category_snapshot: emp_category_snapshot ? JSON.stringify(emp_category_snapshot) : null,
      };
      const pm = parseInt(period_month, 10);
      return applyCtoDeductionLedger(req, res, rec, null, (meta) => {
        (async () => {
          try {
            if (Number.isFinite(pm) && pm >= 1 && pm <= 12) {
              await attendanceWriter.upsertFromCtoEarningDeduction({
                employee_number: rec.employee_number,
                cto_earning_id: meta.attendanceCtoEarningId,
                cto_credit_ledger_id: meta.attendanceCtoCreditLedgerId,
                cto_deduction_source_key: meta.attendanceCtoDeductionSourceKey,
                period_year: rec.period_year,
                period_month: pm,
                remarks: rec.remarks,
                need_hours: meta.needCtoHrs,
                shortfall_hours: meta.ctoShortfallHrs,
              });
              if (meta.ctoShortfallHrs > 0) {
                await recordLeaveSalaryShortfall(req, {
                  employee_number: rec.employee_number,
                  period_year: rec.period_year,
                  period_month: pm,
                  negative_balance_days: meta.ctoNegBalDays,
                  shortfall_hours: meta.ctoShortfallHrs,
                  leave_code: "CTO",
                  entry_type: "ATTENDANCE_CTO_SALARY_SHORTFALL",
                  leave_earning_id: null,
                  remarks: rec.remarks,
                });
              }
            }
          } catch (e) {
            console.error("[earnings] CTO direct deduction finalize:", e.message);
          }
          const actorEmpNum = getActorEmployeeNumber(req);
          const [actorName, targetName] = await Promise.all([
            getEmployeeFullName(actorEmpNum),
            getEmployeeFullName(employeeNumber),
          ]);
          const txMessageBase = buildEarningsTransactionMessage({
            actionLabel: "applied",
            actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
            targetDisplay: formatUserDisplayName(employeeNumber, targetName),
            earningTypeLabel: "CTO balance deduction",
            hoursValue: earnedHrs,
            periodYear: period_year,
            periodMonth: pm,
          });
          const afterBal = await getCtoRemainingHoursTotal(employeeNumber);
          const withBal = `${txMessageBase}. Balance updated: ${meta.totalRemBefore.toFixed(3)} hrs → ${toNum(afterBal).toFixed(3)} hrs (−${meta.applyHrs.toFixed(3)} hrs, CTO ledger).`;
          await insertTransactionLog(employeeNumber, withBal, actorEmpNum);
          auditEarning(req, "applied CTO balance deduction", "cto", null, null, "approved", {
            employee_number: employeeNumber,
            employeeNumber,
            earned_hours: earnedHrs,
            period_year,
            period_month: pm,
            entry_type: entry_type_val,
            remarks: remarks || null,
            ledger_only: true,
          }, { transaction_message: withBal });
          emitEarningsChanged("approved", {
            module: "cto",
            employeeNumber: String(employeeNumber),
            period_year,
            period_month: pm,
            earning_id: null,
          });
          res.status(201).json({
            id: null,
            employee_number: employeeNumber,
            ot_hours: 0,
            earned_hours: earnedHrs,
            period_year,
            period_month: pm,
            earn_status: "approved",
            applied_via: "cto_credit_ledger",
            entry_type: entry_type_val,
            remarks: remarks || null,
          });
        })().catch((e) => {
          console.error("[earnings] CTO POST deduction:", e.message);
          res.status(500).json({ error: e.message || "Failed to apply CTO deduction" });
        });
      });
    }

    const query = `
      INSERT INTO cto_earnings
        (employee_number, ot_hours, earned_hours, used_hours, period_year, period_month, expiry_date, earn_status, entry_type, remarks, emp_category_snapshot, created_by)
      VALUES (?, ?, ?, 0, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `;
    db.query(query, [
      employeeNumber, toNum(ot_hours) || earnedHrs, earnedHrs,
      period_year, parseInt(period_month), expiry_date || null,
      entry_type_val, remarks || null, emp_category_snapshot ? JSON.stringify(emp_category_snapshot) : null, req.user?.username || null
    ], (err, result) => {
      if (err) return res.status(500).json({ error: "Failed to create CTO earning" });
      const ctoCreatePayload = {
        employeeNumber,
        earnedHrs,
        period_year,
        period_month: parseInt(period_month),
        cto_earning_id: result.insertId,
      };
      (async () => {
        const actorEmpNum = getActorEmployeeNumber(req);
        const [actorName, targetName] = await Promise.all([
          getEmployeeFullName(actorEmpNum),
          getEmployeeFullName(employeeNumber),
        ]);
        const txMessage = buildEarningsTransactionMessage({
          actionLabel: "created",
          actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
          targetDisplay: formatUserDisplayName(employeeNumber, targetName),
          earningTypeLabel: "CTO earnings",
          hoursValue: earnedHrs,
          periodYear: period_year,
          periodMonth: parseInt(period_month),
        });
        auditEarning(
          req,
          "created cto earnings",
          "cto",
          result.insertId,
          null,
          "pending",
          ctoCreatePayload,
          { transaction_message: txMessage },
        );
        await insertTransactionLog(employeeNumber, txMessage, actorEmpNum);
      })();
      emitEarningsChanged("created", {
        module: "cto",
        employeeNumber: String(employeeNumber),
        period_year,
        period_month: parseInt(period_month, 10),
      });
      res.status(201).json({ id: result.insertId, employee_number: employeeNumber, ot_hours: toNum(ot_hours) || earnedHrs, earned_hours: earnedHrs, period_year, period_month: parseInt(period_month), earn_status: "pending" });
    });
  });

  router.patch("/cto/:id/approve", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query("SELECT * FROM cto_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const rec = rows[0];
      if (rec.earn_status === "approved") return res.status(400).json({ error: "Already approved" });

      const earnedHrs = toNum(rec.earned_hours);
      const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;
      const entryTypeUpperCto = String(rec.entry_type || "").toUpperCase();
      const isCtoDeduction = entryTypeUpperCto === "DEDUCTION" && earnedHrs < 0;
      const ctoShortfallPm = periodMonth != null ? periodMonth : parseInt(rec.period_month, 10);

      const runCtoApproveFinalize = ({
        isCtoDeduction: isDeductionFinalize,
        needCtoHrs = 0,
        ctoShortfallHrs = 0,
        ctoNegBalDays = 0,
        balBeforeHrs = null,
        balAfterHrs = null,
        balDeltaHrs = null,
        attendanceCtoEarningId = null,
        attendanceCtoCreditLedgerId = null,
        attendanceCtoDeductionSourceKey = null,
      }) => {
        (async () => {
          try {
            if (
              isDeductionFinalize &&
              Number.isFinite(ctoShortfallPm) &&
              ctoShortfallPm >= 1 &&
              ctoShortfallPm <= 12
            ) {
              await attendanceWriter.upsertFromCtoEarningDeduction({
                employee_number: rec.employee_number,
                cto_earning_id: attendanceCtoEarningId,
                cto_credit_ledger_id: attendanceCtoCreditLedgerId,
                cto_deduction_source_key: attendanceCtoDeductionSourceKey,
                period_year: rec.period_year,
                period_month: ctoShortfallPm,
                remarks: rec.remarks,
                need_hours: needCtoHrs,
                shortfall_hours: ctoShortfallHrs,
              });
              if (ctoShortfallHrs > 0) {
                await recordLeaveSalaryShortfall(req, {
                  employee_number: rec.employee_number,
                  period_year: rec.period_year,
                  period_month: ctoShortfallPm,
                  negative_balance_days: ctoNegBalDays,
                  shortfall_hours: ctoShortfallHrs,
                  leave_code: "CTO",
                  entry_type: "ATTENDANCE_CTO_SALARY_SHORTFALL",
                  leave_earning_id: null,
                  remarks: rec.remarks,
                });
              }
            }
          } catch (e) {
            console.error("[earnings] leave_salary_shortfall (CTO approve):", e.message);
          }
          const actorEmpNum = getActorEmployeeNumber(req);
          const [actorName, targetName] = await Promise.all([
            getEmployeeFullName(actorEmpNum),
            getEmployeeFullName(rec.employee_number),
          ]);
          const txMessageBase = buildEarningsTransactionMessage({
            actionLabel: "approved",
            actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
            targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
            earningTypeLabel: "CTO earnings",
            hoursValue: toNum(rec.earned_hours),
            periodYear: rec.period_year,
            periodMonth: rec.period_month,
          });
          const b0 = balBeforeHrs != null ? toNum(balBeforeHrs) : null;
          const b1 = balAfterHrs != null ? toNum(balAfterHrs) : null;
          const dd = balDeltaHrs != null ? toNum(balDeltaHrs) : null;
          const withBal =
            b0 != null && b1 != null && dd != null
              ? `${txMessageBase}. Balance updated: ${b0.toFixed(3)} hrs → ${b1.toFixed(3)} hrs (${dd >= 0 ? "+" : "−"}${Math.abs(dd).toFixed(3)} hrs).`
              : txMessageBase;
          auditEarning(
            req,
            "approved cto earnings",
            "cto",
            parseInt(id),
            rec.earn_status,
            "approved",
            rec,
            { transaction_message: withBal },
          );
          await insertTransactionLog(rec.employee_number, withBal, actorEmpNum);
          emitEarningsChanged("approved", {
            module: "cto",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          db.query("SELECT * FROM cto_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
        })().catch((e) => {
          console.error("[earnings] CTO approve finalize:", e.message);
          res.status(500).json({ error: e.message || "Failed to finalize CTO approval" });
        });
      };

      const markCtoEarningApprovedThenFinalize = (finalizeArgs) => {
        db.query(
          `UPDATE cto_earnings SET earn_status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ? AND earn_status = 'pending'`,
          [req.user?.username || null, id],
          (errUp, resultUp) => {
            if (errUp) return res.status(500).json({ error: "Failed to approve CTO" });
            if (!resultUp || resultUp.affectedRows === 0) {
              return res.status(409).json({ error: "CTO earning was already processed" });
            }
            (async () => {
              try {
                if (!finalizeArgs.skipLedgerRefresh) {
                  const periodRow = await findLatestCtoPeriodRow(
                    db,
                    rec.employee_number,
                    rec.period_year,
                    rec.period_month,
                  );
                  if (periodRow) await refreshCtoPeriodLedger(periodRow);
                }
              } catch (e) {
                console.error("[earnings] CTO approve earning_status refresh:", e.message);
              }
              runCtoApproveFinalize(finalizeArgs);
            })();
          },
        );
      };

      if (isCtoDeduction) {
        applyCtoDeductionLedger(req, res, rec, id, (meta) => {
          markCtoEarningApprovedThenFinalize({
            isCtoDeduction: true,
            skipLedgerRefresh: true,
            needCtoHrs: meta.needCtoHrs,
            ctoShortfallHrs: meta.ctoShortfallHrs,
            ctoNegBalDays: meta.ctoNegBalDays,
            balBeforeHrs: meta.totalRemBefore,
            balAfterHrs: meta.snapRem,
            balDeltaHrs: -meta.applyHrs,
            attendanceCtoEarningId: meta.attendanceCtoEarningId,
            attendanceCtoCreditLedgerId: meta.attendanceCtoCreditLedgerId,
            attendanceCtoDeductionSourceKey: meta.attendanceCtoDeductionSourceKey,
          });
        });
        return;
      }

      // Positive earn: update period ledger flags only — do NOT insert earnings into cto_credit.
      getCtoCreditRunningTotals(rec.employee_number, (err3, cur) => {
        if (err3) {
          console.error("[earnings] CTO approve running totals:", err3);
          return res.status(500).json({ error: "Failed to read CTO balance" });
        }
        const balBefore = toNum(cur.remaining);

        (async () => {
          try {
            await ensureCtoPeriodRow(rec);

            getCtoCreditRunningTotals(rec.employee_number, (err4, curAfter) => {
              if (err4) {
                return res.status(500).json({ error: "Failed to read balance after approval" });
              }
              const balAfter = toNum(curAfter.remaining);
              markCtoEarningApprovedThenFinalize({
                isCtoDeduction: false,
                needCtoHrs: 0,
                ctoShortfallHrs: 0,
                ctoNegBalDays: 0,
                balBeforeHrs: balBefore,
                balAfterHrs: balAfter,
                balDeltaHrs: earnedHrs,
              });
            });
          } catch (e) {
            console.error("[earnings] CTO approve period refresh:", e);
            res.status(500).json({ error: "Failed to update CTO period" });
          }
        })();
      });
    });
  });

  router.patch("/cto/:id/reject", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    db.query("SELECT * FROM cto_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const oldStatus = rows[0].earn_status;

      db.query(
        `UPDATE cto_earnings SET earn_status = 'rejected', rejected_reason = ?, approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [reason || null, req.user?.username || null, id],
        (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to reject CTO" });
          auditEarning(req, "rejected cto earnings", "cto", parseInt(id), oldStatus, "rejected", { ...rows[0], reason });
          emitEarningsChanged("rejected", {
            module: "cto",
            employeeNumber: String(rows[0].employee_number),
            period_year: rows[0].period_year,
            period_month: rows[0].period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rows[0].employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "rejected",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rows[0].employee_number, targetName),
              earningTypeLabel: "CTO earnings",
              hoursValue: toNum(rows[0].earned_hours),
              periodYear: rows[0].period_year,
              periodMonth: rows[0].period_month,
            });
            await insertTransactionLog(rows[0].employee_number, txMessage, actorEmpNum);
          })();
          db.query("SELECT * FROM cto_earnings WHERE id = ?", [id], (e, r) => res.json(r ? r[0] : { id }));
        }
      );
    });
  });

  router.delete("/cto/:id", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query("SELECT * FROM cto_earnings WHERE id = ?", [id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: "Not found" });
      const rec = rows[0];

      const doDelete = () => {
        db.query("DELETE FROM cto_earnings WHERE id = ?", [id], (err2) => {
          if (err2) return res.status(500).json({ error: "Failed to delete CTO" });
          auditEarning(req, "deleted cto earnings", "cto", parseInt(id), rec.earn_status, null, rec);
          emitEarningsChanged("deleted", {
            module: "cto",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "deleted",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
              earningTypeLabel: "CTO earnings",
              hoursValue: toNum(rec.earned_hours),
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);
          })();
          res.json({ deleted: true, id: parseInt(id) });
        });
      };

      if (rec.earn_status === "approved") {
        const earnedHrs = toNum(rec.earned_hours);
        const otHrs = toNum(rec.ot_hours) || earnedHrs;
        const periodMonth = rec.period_month ? parseInt(rec.period_month) : null;
        const delEntryUpper = String(rec.entry_type || "").toUpperCase();
        const isCtoDeductionDel = delEntryUpper === "DEDUCTION" && earnedHrs < 0;
        const earningMark = `cto_earning:${id}`;

        const reverseCtoDeductionUsageThenDelete = () => {
          db.query(
            `SELECT * FROM cto_credit
             WHERE employeeNumber = ?
               AND (remarks = ? OR remarks LIKE ?)`,
            [rec.employee_number, earningMark, `${earningMark} ·%`],
            (errL, ledgerRows) => {
              const lr = !errL && Array.isArray(ledgerRows) ? ledgerRows : [];
              const isLedgerSnap = (row) => {
                const r = String(row.remarks || "");
                return r === earningMark || r.startsWith(`${earningMark} ·`);
              };
              const toDrop = lr.filter(isLedgerSnap);
              if (toDrop.length) {
                let k = 0;
                const nextDrop = () => {
                  if (k >= toDrop.length) return doDelete();
                  const row = toDrop[k++];
                  db.query(`DELETE FROM cto_usage WHERE cto_credit_id = ?`, [row.id], (eU) => {
                    if (eU) console.error("[earnings] CTO deduction delete usage:", eU);
                    db.query(`DELETE FROM cto_credit WHERE id = ?`, [row.id], (eC) => {
                      if (eC) console.error("[earnings] CTO deduction delete ledger row:", eC);
                      nextDrop();
                    });
                  });
                };
                return nextDrop();
              }
              db.query(
                `SELECT id, cto_credit_id, hours_applied FROM cto_usage
                 WHERE employeeNumber = ? AND remarks LIKE ?`,
                [rec.employee_number, `${earningMark}%`],
                (errU, uRows) => {
                  const list = !errU && Array.isArray(uRows) ? uRows : [];
                  if (!list.length) return doDelete();
                  let i = 0;
                  const next = () => {
                    if (i >= list.length) return doDelete();
                    const u = list[i++];
                    const hrs = toNum(u.hours_applied);
                    db.query(
                      `UPDATE cto_credit SET
                        remaining_hours = remaining_hours + ?,
                        used_hours = GREATEST(0, used_hours - ?)
                      WHERE id = ?`,
                      [hrs, hrs, u.cto_credit_id],
                      (errR) => {
                        if (errR) console.error("[earnings] CTO deduction delete reversal:", errR);
                        db.query(`DELETE FROM cto_usage WHERE id = ?`, [u.id], next);
                      },
                    );
                  };
                  next();
                },
              );
            },
          );
        };

        if (isCtoDeductionDel) {
          (async () => {
            try {
              await reverseCtoDeductionEarningAsync(db, rec);
              await attendanceWriter.voidAttendanceResultsForCtoDeduction({ cto_earning_id: parseInt(id, 10) });
            } catch (e) {
              console.error("[earnings] CTO deduction void reversal:", e);
            }
            auditEarning(req, "deleted cto earnings", "cto", parseInt(id), rec.earn_status, null, rec);
            emitEarningsChanged("deleted", {
              module: "cto",
              employeeNumber: String(rec.employee_number),
              period_year: rec.period_year,
              period_month: rec.period_month,
              earning_id: parseInt(id, 10),
            });
            res.json({ deleted: true, id: parseInt(id) });
          })();
          return;
        }

        (async () => {
          try {
            const reversal = await reverseCtoPeriodAttendanceDeductionsAsync(
              db,
              rec.employee_number,
              rec.period_year,
              rec.period_month,
            );
            for (const eid of reversal.voidedEarningIds) {
              await attendanceWriter.voidAttendanceResultsForCtoDeduction({ cto_earning_id: eid });
            }
            for (const lid of reversal.voidedLedgerIds) {
              await attendanceWriter.voidAttendanceResultsForCtoDeduction({ cto_credit_ledger_id: lid });
            }
            await ctoExecAsync(
              db,
              "UPDATE cto_earnings SET voided_at = NOW(), voided = 1 WHERE id = ?",
              [id],
            );
            const periodRow = await findLatestCtoPeriodRow(
              db,
              rec.employee_number,
              rec.period_year,
              rec.period_month,
            );
            if (periodRow) await refreshCtoPeriodLedgerOnRow(db, periodRow);
          } catch (e) {
            console.error("[earnings] CTO void earn cascade reversal:", e);
          }
          auditEarning(req, "deleted cto earnings", "cto", parseInt(id), rec.earn_status, null, rec);
          emitEarningsChanged("deleted", {
            module: "cto",
            employeeNumber: String(rec.employee_number),
            period_year: rec.period_year,
            period_month: rec.period_month,
            earning_id: parseInt(id, 10),
          });
          (async () => {
            const actorEmpNum = getActorEmployeeNumber(req);
            const [actorName, targetName] = await Promise.all([
              getEmployeeFullName(actorEmpNum),
              getEmployeeFullName(rec.employee_number),
            ]);
            const txMessage = buildEarningsTransactionMessage({
              actionLabel: "deleted",
              actorDisplay: formatUserDisplayName(actorEmpNum, actorName),
              targetDisplay: formatUserDisplayName(rec.employee_number, targetName),
              earningTypeLabel: "CTO earnings",
              hoursValue: toNum(rec.earned_hours),
              periodYear: rec.period_year,
              periodMonth: rec.period_month,
            });
            await insertTransactionLog(rec.employee_number, txMessage, actorEmpNum);
          })();
          res.json({ deleted: true, id: parseInt(id) });
        })();
      } else {
        doDelete();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  MONTHLY SUMMARY
  //  GET /api/earnings/monthly/:employeeNumber?year=2026
  // ══════════════════════════════════════════════════════════════════════════════
  router.get("/monthly/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const year = req.query.year || new Date().getFullYear();

    const leaveQ = `
      SELECT period_month, earn_status,
        SUM(earned_hours) as total_earned_hours,
        COUNT(*) as record_count
      FROM leave_earnings
      WHERE employee_number = ? AND period_year = ?
      GROUP BY period_month, earn_status
      ORDER BY period_month ASC
    `;
    const scQ = `
      SELECT period_month, earn_status,
        SUM(earned_hours) as total_earned_hours,
        SUM(total_ot_hours) as total_ot_hours,
        COUNT(*) as record_count
      FROM sc_earnings
      WHERE employee_number = ? AND period_year = ?
      GROUP BY period_month, earn_status
      ORDER BY period_month ASC
    `;
    const ctoQ = `
      SELECT period_month, earn_status,
        SUM(earned_hours) as total_earned_hours,
        SUM(ot_hours) as total_ot_hours,
        COUNT(*) as record_count
      FROM cto_earnings
      WHERE employee_number = ? AND period_year = ?
      GROUP BY period_month, earn_status
      ORDER BY period_month ASC
    `;

    db.query(leaveQ, [employeeNumber, year], (err1, leaveRows) => {
      db.query(scQ, [employeeNumber, year], (err2, scRows) => {
        db.query(ctoQ, [employeeNumber, year], (err3, ctoRows) => {
          res.json({
            employeeNumber,
            year: parseInt(year),
            leave: err1 ? [] : (leaveRows || []),
            sc:    err2 ? [] : (scRows || []),
            cto:   err3 ? [] : (ctoRows || []),
          });
        });
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  COMBINED BALANCE
  //  GET /api/earnings/balance/:employeeNumber?year=2026&month=4
  // ══════════════════════════════════════════════════════════════════════════════
  router.get("/balance/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;
    const now = new Date();
    const year  = req.query.year  || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);

    db.query(
      `SELECT * FROM leave_balance_summary WHERE employee_number = ? AND (? IS NULL OR period_year = ?) AND (? IS NULL OR period_month = ?)`,
      [employeeNumber, year || null, year || null, month || null, month || null],
      (err1, leaveRows) => {
        loadScBalanceSummaryRows(employeeNumber, year, month, (err2, scRows) => {
          db.query(
            `SELECT * FROM cto_balance_summary WHERE employee_number = ? AND (? IS NULL OR period_year = ?) AND (? IS NULL OR period_month = ?)`,
            [employeeNumber, year || null, year || null, month || null, month || null],
            (err3, ctoRows) => {
              res.json({
                employeeNumber,
                year: parseInt(year),
                month: parseInt(month),
                leave: err1 ? [] : (leaveRows || []),
                sc: err2 ? [] : (scRows || []),
                cto: err3 ? [] : (ctoRows || []),
              });
            },
          );
        });
      }
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  ASSIGNMENT BALANCES
  //  GET /api/earnings/assignment-balances/:employeeNumber
  // ══════════════════════════════════════════════════════════════════════════════
  router.get("/assignment-balances/:employeeNumber", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
    const { employeeNumber } = req.params;

    const query = `
      SELECT
        leave_code,
        SUM(remaining_hours) as remaining_hours,
        SUM(total_hours)     as total_hours,
        SUM(used_hours)      as used_hours,
        MAX(period_year)     as period_year
      FROM leave_assignment
      WHERE employeeNumber = ?
      GROUP BY leave_code
    `;

    db.query(query, [employeeNumber], (err, rows) => {
      if (err) return res.status(500).json({ error: "Failed to fetch assignment balances" });
      const map = {};
      (rows || []).forEach(r => { map[r.leave_code] = r; });
      res.json(map);
    });
  });


  // ══════════════════════════════════════════════════════════════════════════════
//  SC BALANCE — direct from service_credit table
//  GET /api/earnings/sc/:employeeNumber/balance
// ══════════════════════════════════════════════════════════════════════════════
router.get("/sc/:employeeNumber/balance", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const { employeeNumber } = req.params;
  db.query(
    `SELECT DISTINCT sc_type FROM service_credit WHERE employeeNumber = ?`,
    [employeeNumber],
    (err, types) => {
      if (err) return res.status(500).json({ error: "Failed to fetch SC balance" });
      const list = (types || []).map((t) => t.sc_type);
      const balances = [];
      let i = 0;
      const next = () => {
        if (i >= list.length) {
          const totalRemaining = balances.reduce((s, r) => s + toNum(r.remaining_hours), 0);
          return res.json({ balances, totalRemaining });
        }
        const st = list[i++];
        getServiceCreditRunningTotals(employeeNumber, st, (e2, cur) => {
          if (e2) return res.status(500).json({ error: "Failed to fetch SC balance" });
          balances.push({
            sc_type: st,
            earned_hours: cur.earned,
            remaining_hours: cur.remaining,
            used_hours: cur.used,
          });
          next();
        });
      };
      next();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  CTO BALANCE — direct from cto_credit table
//  GET /api/earnings/cto/:employeeNumber/balance
// ══════════════════════════════════════════════════════════════════════════════
router.get("/cto/:employeeNumber/balance", authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const { employeeNumber } = req.params;
  getCtoCreditRunningTotals(employeeNumber, (err, cur) => {
    if (err) {
      console.error("CTO balance error:", err);
      return res.status(500).json({ error: "Failed to fetch CTO balance", detail: err.message });
    }
    const periodRow = cur.periodRow || null;
    const balances = [
      {
        period_year: periodRow?.period_year ?? null,
        period_month: periodRow?.period_month ?? null,
        expiry_date: periodRow?.expiry_date ?? null,
        earned_hours: cur.earned,
        remaining_hours: cur.remaining,
        used_hours: cur.used,
      },
    ];
    res.json({ balances, totalRemaining: cur.remaining, periodRow });
  });
});

// ── OT TYPES ──────────────────────────────────────────────────────────────────
router.get("/ot-types", authenticateToken, requireAdmin, (req, res) => {
  res.json([
    { id: "regular",    name: "Regular OT",           multiplier: 1 },
    { id: "holiday",    name: "Holiday OT",            multiplier: 1 },
    { id: "night_diff", name: "Night Differential OT", multiplier: 1 },
  ]);
});


  module.exports = router;