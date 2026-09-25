/**

 * Grants / revokes supervisor module page_access when supervisor_assignment changes.

 * Login role (staff, etc.) is unchanged — only page_access is added/removed.

 */

const db = require("../db");

const {
  notifySupervisorAssignmentChanged,
  notifyMultipleUsers,
} = require("../socket/socketService");

const LEAVE_SUPERVISOR_IDENTIFIER = "leave-request-supervisor";

const DTR_SUPERVISOR_IDENTIFIER = "daily-time-record-supervisor";
const OFFICIAL_TIME_SUPERVISOR_IDENTIFIER = "official-time-supervisor";

const DEFAULT_PRIVILEGE = "1";

const MANILA_TIME_ZONE = "Asia/Manila";

function manilaNowKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  let hour = Number(parts.hour);
  if (parts.dayPeriod === "PM" && hour < 12) hour += 12;
  if (parts.dayPeriod === "AM" && hour === 12) hour = 0;
  return Number(`${parts.year}${parts.month}${parts.day}${String(hour).padStart(2, "0")}${parts.minute}${parts.second}`);
}

function wallClockKey(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (!match) return null;
  let hour = Number(match[4]);
  const period = match[7].toUpperCase();
  if (period === "PM" && hour < 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return Number(`${match[1]}${match[2]}${match[3]}${String(hour).padStart(2, "0")}${match[5]}${match[6]}`);
}

/** Pages whose page_access is owned by supervisor_assignment — not UsersList. */

const ASSIGNMENT_MANAGED_IDENTIFIERS = [
  LEAVE_SUPERVISOR_IDENTIFIER,

  DTR_SUPERVISOR_IDENTIFIER,
  OFFICIAL_TIME_SUPERVISOR_IDENTIFIER,
];

const SUPERVISOR_PAGE_SEEDS = [
  {
    identifier: LEAVE_SUPERVISOR_IDENTIFIER,

    page_name: "Leave Request Approval - Supervisor",

    page_description: "Supervisor leave approval for assigned departments",

    page_url: "/leave-request-supervisor",

    page_group: "staff,administrator,superadmin,technical",
  },

  {
    identifier: DTR_SUPERVISOR_IDENTIFIER,

    page_name: "Daily Time Record - Supervisor",

    page_description: "Attendance Management",

    page_url: "/daily-time-record-supervisor",

    page_group: "staff,administrator,superadmin,technical",
  },

  {
    identifier: OFFICIAL_TIME_SUPERVISOR_IDENTIFIER,

    page_name: "Official Time - Supervisor",

    page_description: "Official Time Management",

    page_url: "/official-time-supervisor",

    page_group: "staff,administrator,superadmin,technical",
  },
];

/** Match employee numbers including numeric IDs with/without leading zeros (e.g. 1234 vs 001234). */

const empMatchSql = (column) =>
  `(

    TRIM(CAST(${column} AS CHAR)) = TRIM(CAST(? AS CHAR))

    OR (

      TRIM(CAST(${column} AS CHAR)) REGEXP '^[0-9]+$'

      AND TRIM(CAST(? AS CHAR)) REGEXP '^[0-9]+$'

      AND CAST(TRIM(${column}) AS UNSIGNED) = CAST(TRIM(?) AS UNSIGNED)

    )

  )`;

const bindEmpMatchParams = (employeeNumber) => {
  const e = String(employeeNumber ?? "").trim();

  return [e, e, e];
};

const queryAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) return reject(err);

      resolve(rows);
    });
  });

async function resolveCanonicalEmployeeNumber(employeeNumber) {
  const emp = String(employeeNumber || "").trim();

  if (!emp) return null;

  // Fast path: an exact match can use the users.employeeNumber index. The
  // leading-zero-tolerant empMatchSql below scans every user row, so only
  // fall back to it when the stored number is formatted differently.
  const exact = await queryAsync(
    "SELECT employeeNumber FROM users WHERE employeeNumber = ? LIMIT 1",
    [emp],
  );
  if (exact[0]?.employeeNumber != null) {
    const found = String(exact[0].employeeNumber).trim();
    if (found === emp) return found;
  }

  const rows = await queryAsync(
    `SELECT employeeNumber FROM users WHERE ${empMatchSql("employeeNumber")} LIMIT 1`,

    bindEmpMatchParams(emp),
  );

  return rows[0]?.employeeNumber ? String(rows[0].employeeNumber).trim() : emp;
}

/**

 * Load supervisor_assignment rows for an employee (tries canonical + raw id).
 *
 * [CHANGE] Accepts an options object with `includeExpired`. By default
 * (includeExpired = false) this behaves EXACTLY as before — only rows with
 * status = 0 (active) are returned, so every existing caller (leave
 * approval routing, page-access granting, transaction logs, etc.) keeps
 * requiring a live assignment with no behavior change.
 *
 * When a caller explicitly opts in with { includeExpired: true } — used
 * only by the read-only "department employee list" endpoint for Official
 * Time / DTR supervisor views — expired (status = 1) assignment rows are
 * also returned, so a supervisor whose window has lapsed can still see
 * (but, per separate route-level guards, not edit) their former
 * department's employees. Each returned department also now carries an
 * `active` flag (derived from `status`) so the frontend can distinguish
 * "was assigned, now expired" from "currently active" if needed.
 *
 * NOTE ON SQL SAFETY: `statusClause`/`baseSql`/`activeOnlySql` below are
 * built ONLY from a fixed boolean flag and hardcoded string literals never
 * derived from request input. The employee number itself is never
 * concatenated into the SQL string — it is always passed as a bound `?`
 * parameter via bindEmpMatchParams()/queryAsync(sql, params). This function
 * is not susceptible to SQL injection through any of its inputs.
 */

async function fetchSupervisorDepartments(employeeNumber, { includeExpired = false } = {}) {
  const emp = String(employeeNumber || "").trim();

  if (!emp) return { supervisorEmployeeNumber: null, departments: [] };

  const canonical = await resolveCanonicalEmployeeNumber(emp);

  const candidates = [...new Set([canonical, emp].filter(Boolean))];

  // Two fully-formed, hardcoded SQL strings — no interpolation of
  // request-derived values into the query text itself.
  const baseSql = `SELECT sa.departmentCode, sa.role, sa.status, dt.description AS departmentDescription

     FROM supervisor_assignment sa

     LEFT JOIN department_table dt ON dt.code = sa.departmentCode

     WHERE ${empMatchSql("sa.supervisorEmployeeNumber")}`;

  const activeOnlySql = `${baseSql} AND sa.status = 0`;

  for (const candidate of candidates) {
    const rows = await queryAsync(
      includeExpired ? baseSql : activeOnlySql,

      bindEmpMatchParams(candidate),
    );

    if (rows.length) {
      return {
        supervisorEmployeeNumber: candidate,

        departments: rows.map((r) => ({
          code: r.departmentCode,

          description: r.departmentDescription || r.departmentCode,

          role: r.role,

          // [CHANGE] Lets callers (e.g. frontend) tell active vs. expired
          // assignments apart when includeExpired was used.
          active: Number(r.status) === 0,
        })),
      };
    }
  }

  return { supervisorEmployeeNumber: null, departments: [] };
}

async function ensureSupervisorPage(componentIdentifier) {
  const seed = SUPERVISOR_PAGE_SEEDS.find(
    (p) => p.identifier === componentIdentifier,
  );

  if (!seed) return null;

  let rows = await queryAsync(
    "SELECT id, page_name, page_description, page_url, component_identifier FROM pages WHERE component_identifier = ? LIMIT 1",

    [componentIdentifier],
  );

  if (rows[0]) return rows[0];

  await queryAsync(
    `INSERT INTO pages (page_name, page_description, page_url, page_group, component_identifier)

     SELECT ?, ?, ?, ?, ?

     WHERE NOT EXISTS (SELECT 1 FROM pages WHERE component_identifier = ?)`,

    [
      seed.page_name,

      seed.page_description,

      seed.page_url,

      seed.page_group,

      seed.identifier,

      seed.identifier,
    ],
  );

  rows = await queryAsync(
    "SELECT id, page_name, page_description, page_url, component_identifier FROM pages WHERE component_identifier = ? LIMIT 1",

    [componentIdentifier],
  );

  return rows[0] || null;
}

async function countSupervisorAssignments(employeeNumber) {
  const rows = await queryAsync(
    `SELECT COUNT(*) AS cnt FROM supervisor_assignment WHERE ${empMatchSql("supervisorEmployeeNumber")} AND status = 0`,

    bindEmpMatchParams(employeeNumber),
  );

  return Number(rows[0]?.cnt || 0);
}

function notifyGranted(employeeNumber, page) {
  socketService.notifyPageAccessGranted(employeeNumber, {
    page_id: page.id,

    page_name: page.page_name,

    component_identifier: page.component_identifier,
  });
}

function notifyRevoked(employeeNumber, page) {
  socketService.notifyPageAccessRevoked(employeeNumber, {
    page_id: page.id,

    page_name: page.page_name,

    component_identifier: page.component_identifier,
  });
}

async function grantSupervisorPageAccess(employeeNumber, componentIdentifier) {
  const canonical = await resolveCanonicalEmployeeNumber(employeeNumber);

  if (!canonical) return;

  const page = await ensureSupervisorPage(componentIdentifier);

  if (!page) {
    console.warn(
      `[supervisorPageAccess] Could not register page: ${componentIdentifier}`,
    );

    return;
  }

  const existing = await queryAsync(
    `SELECT page_id, page_privilege, expires_at FROM page_access

     WHERE ${empMatchSql("employeeNumber")} AND page_id = ? LIMIT 1`,

    [...bindEmpMatchParams(canonical), page.id],
  );

  if (existing.length > 0) {
    const privilege = String(existing[0].page_privilege || "0");

    if (privilege === "0" || privilege === "") {
      await queryAsync(
        `UPDATE page_access SET page_privilege = ?, expires_at = NULL

         WHERE ${empMatchSql("employeeNumber")} AND page_id = ?`,

        [DEFAULT_PRIVILEGE, ...bindEmpMatchParams(canonical), page.id],
      );

      notifyGranted(canonical, page);
    }

    return;
  }

  await queryAsync(
    "INSERT INTO page_access (employeeNumber, page_id, page_privilege, expires_at) VALUES (?, ?, ?, NULL)",

    [canonical, page.id, DEFAULT_PRIVILEGE],
  );

  notifyGranted(canonical, page);
}

async function revokeSupervisorPageAccess(employeeNumber, componentIdentifier) {
  const canonical = await resolveCanonicalEmployeeNumber(employeeNumber);

  if (!canonical) return false;

  const page = await ensureSupervisorPage(componentIdentifier);

  if (!page) return false;

  const result = await queryAsync(
    `DELETE FROM page_access WHERE ${empMatchSql("employeeNumber")} AND page_id = ?`,

    [...bindEmpMatchParams(canonical), page.id],
  );

  if (result.affectedRows > 0) {
    notifyRevoked(canonical, page);

    return true;
  }

  return false;
}

/** Grant all supervisor-module pages (leave + DTR). */

async function grantSupervisorLeavePageAccess(employeeNumber) {
  for (const identifier of ASSIGNMENT_MANAGED_IDENTIFIERS) {
    await grantSupervisorPageAccess(employeeNumber, identifier);
  }
}

/** Remove all supervisor-module page_access when no assignments remain. */

async function revokeSupervisorLeavePageAccessIfUnassigned(employeeNumber) {
  const canonical = await resolveCanonicalEmployeeNumber(employeeNumber);

  if (!canonical) return false;

  const remaining = await countSupervisorAssignments(canonical);

  if (remaining > 0) return false;

  let revoked = false;

  for (const identifier of ASSIGNMENT_MANAGED_IDENTIFIERS) {
    const didRevoke = await revokeSupervisorPageAccess(canonical, identifier);

    revoked = revoked || didRevoke;
  }

  return revoked;
}

function isAssignmentManagedIdentifier(componentIdentifier) {
  return ASSIGNMENT_MANAGED_IDENTIFIERS.includes(
    String(componentIdentifier || "").trim(),
  );
}

/**

 * Reject manual page_access changes for supervisor-assignment-managed pages.

 */

async function assertNotAssignmentManagedPage(pageId) {
  const rows = await queryAsync(
    "SELECT component_identifier, page_name FROM pages WHERE id = ? LIMIT 1",

    [pageId],
  );

  const page = rows[0];

  if (!page) {
    return { ok: false, status: 404, error: "Page not found" };
  }

  if (isAssignmentManagedIdentifier(page.component_identifier)) {
    return {
      ok: false,

      status: 403,

      error:
        `Access to "${page.page_name}" is managed via Supervisor Assignment. ` +
        "Add or remove department assignments there — manual page access changes are not allowed.",
    };
  }

  return { ok: true };
}

async function sendSupervisorAssignmentNotice({
  employeeNumber,
  description,
  actionLink,
}) {
  const emp = String(employeeNumber || "").trim();
  if (!emp || !description) return false;

  try {
    // Runs for every soon-to-expire assignment on each 60s tick: compare the
    // bare column so the notifications employeeNumber index is used.
    const existing = await queryAsync(
      `SELECT id FROM notifications
       WHERE employeeNumber = ?
         AND notification_type = 'supervisor_assignment'
         AND action_link = ?
       LIMIT 1`,
      [emp, actionLink],
    );
    if (existing.length) return false;

    await queryAsync(
      `INSERT INTO notifications
         (employeeNumber, description, read_status, notification_type, action_link)
       VALUES (?, ?, 0, 'supervisor_assignment', ?)`,
      [emp, description, actionLink || null],
    );
  } catch (err) {
    try {
      await queryAsync(
        `INSERT INTO notifications (employeeNumber, description, read_status)
         VALUES (?, ?, 0)`,
        [emp, description],
      );
    } catch (fallbackErr) {
      console.error(
        "[supervisor-notice] insert error:",
        fallbackErr.message || err.message,
      );
      return false;
    }
  }

  try {
    notifyMultipleUsers([emp], "notificationCreated", {
      notification_type: "supervisor_assignment",
      action_link: actionLink || null,
      description,
    });
  } catch (e) {
    console.error("[supervisor-notice] socket error:", e.message);
  }
  return true;
}

async function sendApproachingSupervisorNotices() {
  const rows = await queryAsync(
    `SELECT id, supervisorEmployeeNumber, departmentCode, end
     FROM supervisor_assignment
     WHERE status = 0 AND end IS NOT NULL`,
  );
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const row of rows || []) {
    const end = new Date(row.end);
    if (Number.isNaN(end.getTime())) continue;
    const remaining = end.getTime() - now;
    if (remaining <= 0) continue;

    const dept = row.departmentCode || "your department";
    const endIso = end.toISOString();
    if (remaining <= dayMs) {
      await sendSupervisorAssignmentNotice({
        employeeNumber: row.supervisorEmployeeNumber,
        description: `Your supervisor assignment for department "${dept}" ends in less than 24 hours. After it expires you can still view Official Time records, but you will no longer be able to create or edit schedules.`,
        actionLink: `/official_time_supervisor?notice=1d&assignment=${row.id}&end=${encodeURIComponent(endIso)}`,
      });
    } else if (remaining <= 7 * dayMs) {
      await sendSupervisorAssignmentNotice({
        employeeNumber: row.supervisorEmployeeNumber,
        description: `Your supervisor assignment for department "${dept}" ends in ${Math.ceil(remaining / dayMs)} days. Finish remaining Official Time schedules before write access closes.`,
        actionLink: `/official_time_supervisor?notice=7d&assignment=${row.id}&end=${encodeURIComponent(endIso)}`,
      });
    }
  }
}

async function expireSupervisorAssignments() {
  try {
    try {
      await sendApproachingSupervisorNotices();
    } catch (noticeErr) {
      console.error("[expire-supervisor] approaching notice error:", noticeErr.message);
    }

    // Compare both values as Manila wall-clock datetimes. This avoids using
    // MySQL NOW(), whose configured timezone may differ from the UI timezone.
    const rows = await queryAsync(
      `SELECT id, supervisorEmployeeNumber, departmentCode, role,
              DATE_FORMAT(end, '%Y-%m-%d %h:%i:%s %p') AS end_local
       FROM supervisor_assignment
       WHERE status = 0 AND end IS NOT NULL`,
    );

    const currentKey = manilaNowKey();
    const dueRows = (rows || []).filter((row) => {
      const endKey = wallClockKey(row.end_local);
      // Expire at the end boundary, or immediately after it if the
      // once-per-minute check runs slightly late. Never expire early.
      return endKey !== null && endKey <= currentKey;
    });

    if (!dueRows.length) return; // nothing expired this tick

    const ids = dueRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    await queryAsync(
      `UPDATE supervisor_assignment
       SET status = 1, updatedAt = NOW()
       WHERE id IN (${placeholders})`,
      ids,
    );

    console.log(
      `[expire-supervisor] expired ${dueRows.length} assignment(s): ${ids.join(", ")}`,
    );

    // Notify the UI for every expired row.
    for (const r of dueRows) {
      try {
        notifySupervisorAssignmentChanged("expired", {
          id: r.id,
          supervisorEmployeeNumber: r.supervisorEmployeeNumber,
          departmentCode: r.departmentCode,
          role: r.role,
        });
      } catch (e) {
        console.error("[expire-supervisor] socket notify error:", e.message);
      }
      try {
        const dept = r.departmentCode || "your department";
        await sendSupervisorAssignmentNotice({
          employeeNumber: r.supervisorEmployeeNumber,
          description: `Your supervisor assignment for department "${dept}" has ended. You can still view Official Time records for staff in that department, but you can no longer create or edit schedules until it is renewed.`,
          actionLink: `/official_time_supervisor?notice=expired&assignment=${r.id}`,
        });
      } catch (e) {
        console.error("[expire-supervisor] expired notice error:", e.message);
      }
    }
  } catch (err) {
    console.error("[expire-supervisor] error:", err.message);
  }
}

async function hasSupervisorAssignment(employeeNumber) {
  const emp = String(employeeNumber || "").trim();

  if (!emp) return false;

  const canonical = await resolveCanonicalEmployeeNumber(emp);
  const candidates = [...new Set([canonical, emp].filter(Boolean))];

  for (const candidate of candidates) {
    const rows = await queryAsync(
      `SELECT id
       FROM supervisor_assignment
       WHERE ${empMatchSql("supervisorEmployeeNumber")}
       LIMIT 1`,
      bindEmpMatchParams(candidate),
    );

    if (rows.length) {
      return true;
    }
  }

  return false;
}

module.exports = {
  LEAVE_SUPERVISOR_IDENTIFIER,

  DTR_SUPERVISOR_IDENTIFIER,
  OFFICIAL_TIME_SUPERVISOR_IDENTIFIER,
  ASSIGNMENT_MANAGED_IDENTIFIERS,
  empMatchSql,
  bindEmpMatchParams,

  resolveCanonicalEmployeeNumber,

  fetchSupervisorDepartments,
  grantSupervisorPageAccess,

  grantSupervisorLeavePageAccess,

  revokeSupervisorLeavePageAccessIfUnassigned,

  isAssignmentManagedIdentifier,

  assertNotAssignmentManagedPage,
  expireSupervisorAssignments,
  hasSupervisorAssignment,
  sendSupervisorAssignmentNotice,
};