const db = require("../db");
const { getCtoCreditRunningTotals } = require("./ctoCreditRunningTotals");
const { getScRemainingHoursTotal } = require("./serviceCreditRunningTotals");

const SALARY_VALUE = "SALARY_DEDUCTION";

const query = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const parseDbHours = (val) => {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const s = String(val).trim();
  if (!s) return 0;
  if (s.includes(":")) {
    const [hh, mm, ss] = s.split(":");
    const h = Number(hh) || 0;
    const m = Number(mm) || 0;
    const sec = Number(ss) || 0;
    return h + m / 60 + sec / 3600;
  }
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const fetchLeaveDeductionMeta = (employeeNumber, leave_code) =>
  new Promise((resolve) => {
    db.query(
      `SELECT lt.leave_hours AS leave_type_hours
       FROM users u
       LEFT JOIN employment_category ec
         ON ec.employeeNumber = ?
       LEFT JOIN employment_type_config etc
         ON etc.id = COALESCE(ec.employmentCategory, u.employmentCategory)
       LEFT JOIN leave_table lt ON TRIM(lt.leave_code) = TRIM(?)
       WHERE u.employeeNumber = ?
       LIMIT 1`,
      // Bound parameters instead of CAST(col AS CHAR) so indexes are used.
      [employeeNumber, leave_code, employeeNumber],
      (err, rows) => {
        if (!err && rows?.length) return resolve(rows[0]);
        db.query(
          `SELECT leave_hours AS leave_type_hours
           FROM leave_table WHERE TRIM(leave_code) = TRIM(?) LIMIT 1`,
          [leave_code],
          (e2, r2) => resolve(r2?.[0] || {}),
        );
      },
    );
  });

const resolveHoursPerDayFromMeta = (meta) => {
  const lt = parseFloat(meta?.leave_type_hours);
  if (Number.isFinite(lt) && lt > 0)
    return { hoursPerDay: lt, rateSource: "leave_table" };
  return { hoursPerDay: 8, rateSource: "default" };
};

/**
 * Match frontend EarningsManagement / half-day modal: leave_table.leave_hours is sometimes
 * a policy aggregate (>12) rather than clock hours per day. Normalize before half-day math.
 */
const normalizeClockHoursPerDay = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return n > 12 ? n / 4 : n;
};

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
        resolve(Array.isArray(rows) ? rows : []);
      },
    );
  });

const {
  getLeaveTypeStatsActive,
} = require("../utils/leaveAssignmentBalanceUtils");

const getTotalRemainingHours = async (employeeNumber, leave_code) => {
  const rows = await getLeaveAssignmentsForCode(employeeNumber, leave_code);
  return getLeaveTypeStatsActive(rows).remainingHours;
};

/** Matches earnings CTO balance: latest snapshot row, not SUM(remaining) across historical ledger rows. */
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

/** Matches GET /api/earnings/sc/:emp/balance totalRemaining (service_credit ledger, all sc_type). */
const getScRemainingHoursAsync = (employeeNumber) =>
  new Promise((resolve, reject) => {
    const emp = String(employeeNumber || "").trim();
    if (!emp) return resolve(0);
    getScRemainingHoursTotal(emp, (err, total) => {
      if (err) return reject(err);
      const n = Number(total);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });

async function getRemainingHoursForCode(employeeNumber, leaveCodeRaw) {
  const code = String(leaveCodeRaw || "").trim().toUpperCase();
  if (!code) return 0;
  if (code === "CTO") return getCtoRemainingHours(employeeNumber);
  if (code === "SC") return getScRemainingHoursAsync(employeeNumber);
  return getTotalRemainingHours(employeeNumber, code);
}

async function getEmploymentTypeIdForEmployee(employeeNumber) {
  const rows = await query(
    `SELECT COALESCE(ec.employmentCategory, u.employmentCategory) AS type_id
     FROM users u
     LEFT JOIN employment_category ec
       ON ec.employeeNumber = ?
     WHERE u.employeeNumber = ?
     LIMIT 1`,
    // Bound parameters instead of CAST(col AS CHAR) so indexes are used.
    [String(employeeNumber || "").trim(), String(employeeNumber || "").trim()],
  );
  const id = rows?.[0]?.type_id;
  if (id === null || id === undefined || id === "") return null;
  const n = parseInt(id, 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchPolicyLeaveRows(employmentTypeId, deductionContext) {
  if (employmentTypeId == null) return [];
  return query(
    `SELECT lt.id AS leave_type_id,
            TRIM(lt.leave_code) AS leave_code,
            lt.leave_description
     FROM employment_category_deduction_types ecdt
     INNER JOIN leave_table lt ON lt.id = ecdt.leave_type_id
     WHERE ecdt.employment_category_id = ?
       AND ecdt.deduction_context = ?
     ORDER BY lt.leave_code ASC`,
    [employmentTypeId, deductionContext],
  );
}

function formatOptionLabel(leave_description, leave_code) {
  const desc = String(leave_description || "").trim();
  const code = String(leave_code || "").trim().toUpperCase();
  if (desc && code) return `${desc} (${code})`;
  if (code) return code;
  return desc || "Leave";
}

/**
 * Credits allotted outside the leave-type policy table (SC via assignments, CTO via cto_credit).
 * Always offered as deduction sources; not configured under employment category "leave types".
 */
const DIRECT_ALLOTMENT_DEDUCTION_OPTIONS = [
  { value: "SC", label: "Service Credit (SC)", leave_type_id: null },
  { value: "CTO", label: "Compensatory Time Off (CTO)", leave_type_id: null },
];

/**
 * @param {{ employeeNumber: string, context: 'ABSENCE'|'HALF_DAY'|'TARDINESS', hasLeaveForm: boolean }} params
 * @returns {Promise<{ options: Array<{ value: string, label: string, leave_type_id: number|null }> }>}
 */
async function getDeductionOptions({ employeeNumber, context, hasLeaveForm }) {
  const emp = String(employeeNumber || "").trim();
  const ctx = String(context || "").toUpperCase();
  if (!emp) {
    return { options: [{ value: SALARY_VALUE, label: "Salary Deduction" }] };
  }
  if (!["ABSENCE", "HALF_DAY", "TARDINESS"].includes(ctx)) {
    return { options: [{ value: SALARY_VALUE, label: "Salary Deduction" }] };
  }

  const typeId = await getEmploymentTypeIdForEmployee(emp);
  const salaryOpt = { value: SALARY_VALUE, label: "Salary Deduction", leave_type_id: null };

  let leaveRows = [];

  if (ctx === "HALF_DAY" && !hasLeaveForm) {
    // Use employment_category_deduction_types (VL, CTO, SL, …) like other contexts.
    // Legacy: if no policy rows, keep VL-only default for half-day-without-form.
    leaveRows = await fetchPolicyLeaveRows(typeId, ctx);
    if (!leaveRows.length) {
      const vlRows = await query(
        `SELECT id AS leave_type_id, TRIM(leave_code) AS leave_code, leave_description
         FROM leave_table WHERE UPPER(TRIM(leave_code)) = 'VL' LIMIT 1`,
      );
      leaveRows = vlRows || [];
    }
  } else {
    leaveRows = await fetchPolicyLeaveRows(typeId, ctx);
  }

  const out = [];
  const codesFromPolicy = new Set();
  for (const row of leaveRows || []) {
    const code = String(row.leave_code || "").trim().toUpperCase();
    if (!code) continue;
    codesFromPolicy.add(code);
    out.push({
      value: code,
      label: formatOptionLabel(row.leave_description, code),
      leave_type_id: row.leave_type_id != null ? Number(row.leave_type_id) : null,
    });
  }

  for (const extra of DIRECT_ALLOTMENT_DEDUCTION_OPTIONS) {
    const v = String(extra.value || "").trim().toUpperCase();
    if (codesFromPolicy.has(v)) continue;
    out.push({ value: v, label: extra.label, leave_type_id: null });
  }

  out.push(salaryOpt);

  if (out.length === 1 && out[0].value === SALARY_VALUE) {
    return { options: [salaryOpt] };
  }

  const seen = new Set();
  const deduped = [];
  for (const o of out) {
    if (seen.has(o.value)) continue;
    seen.add(o.value);
    deduped.push(o);
  }
  return { options: deduped };
}

/**
 * Half-day suggestion shape consumed by leave routes and UI.
 */
async function buildHalfDayPolicySuggestionCore({
  employeeNumber,
  leave_date,
  preferred_charge_to = null,
  getFiledLeaveRequestForDate,
}) {
  const filedLeave = await getFiledLeaveRequestForDate({ employeeNumber, leave_date });
  const hasLeaveForm = Boolean(filedLeave);

  const { options } = await getDeductionOptions({
    employeeNumber,
    context: "HALF_DAY",
    hasLeaveForm,
  });

  const allowed = options.map((o) => o.value);
  const findOptionValue = (code) => {
    const u = String(code || "")
      .trim()
      .toUpperCase();
    const hit = options.find(
      (o) => String(o.value || "")
        .trim()
        .toUpperCase() === u,
    );
    return hit?.value ?? null;
  };

  const preferredRaw = String(preferred_charge_to || "").trim();
  let chosen;
  if (preferredRaw && findOptionValue(preferredRaw)) {
    chosen = findOptionValue(preferredRaw);
  } else if (findOptionValue("VL")) {
    chosen = findOptionValue("VL");
  } else {
    chosen = options[0]?.value || SALARY_VALUE;
  }

  if (!options.some((o) => o.value === chosen)) {
    chosen = options[0]?.value || SALARY_VALUE;
  }

  let hoursPerDay = 8;
  let availableHours = 0;
  if (chosen !== SALARY_VALUE) {
    const meta = await fetchLeaveDeductionMeta(employeeNumber, chosen);
    const resolved = resolveHoursPerDayFromMeta(meta);
    hoursPerDay = resolved.hoursPerDay;
    availableHours = await getRemainingHoursForCode(employeeNumber, chosen);
  }

  const clockHoursPerDay = normalizeClockHoursPerDay(hoursPerDay);
  const recommendedHours = Number((clockHoursPerDay / 2).toFixed(4));
  const hasSufficientBalance =
    chosen === SALARY_VALUE ? true : availableHours >= recommendedHours - 1e-6;

  return {
    employeeNumber: String(employeeNumber || ""),
    leave_date,
    is_half_day_absence: true,
    has_leave_form: hasLeaveForm,
    filed_leave_request: filedLeave
      ? {
          id: filedLeave.id,
          leave_code: filedLeave.leave_code,
          leave_description: filedLeave.leave_description || null,
          status: Number(filedLeave.status),
        }
      : null,
    allowed_charge_to: allowed,
    deduction_options: options,
    recommended_charge_to: chosen,
    recommended_rate_decimal: 0.5,
    recommended_hours: recommendedHours,
    hours_per_day: Number(clockHoursPerDay.toFixed(4)),
    available_hours: Number((availableHours || 0).toFixed(4)),
    has_sufficient_balance: hasSufficientBalance,
    recommendation_reason: hasLeaveForm
      ? "Half-day with leave form: options from employment deduction policy."
      : "Half-day without leave form: VL when balance allows; otherwise salary deduction.",
  };
}

module.exports = {
  SALARY_VALUE,
  DIRECT_ALLOTMENT_DEDUCTION_OPTIONS,
  getDeductionOptions,
  buildHalfDayPolicySuggestionCore,
  getRemainingHoursForCode,
  fetchLeaveDeductionMeta,
  resolveHoursPerDayFromMeta,
  normalizeClockHoursPerDay,
};
