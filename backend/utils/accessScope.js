const db = require('../db');
const {
  isAdminRole,
  employeeNumbersMatch,
  enrichUserFromDb,
} = require('../middleware/auth');
const { fetchSupervisorDepartments } = require('./supervisorPageAccess');

/**
 * Record-ownership helpers shared by the attendance and PDS routes.
 *
 * Rule of thumb: HR/admin roles keep full access; everyone else is limited to
 * their own records (and, for read-only attendance views, the employees in
 * the departments they supervise). Identity always comes from the verified
 * token — never from an ID the client sends.
 */

const isAdminRequest = (req) => isAdminRole(req.user?.role);

async function callerEmployeeNumber(req) {
  let emp = String(req.user?.employeeNumber || '').trim();
  if (!emp && req.user) {
    req.user = await enrichUserFromDb(req.user);
    emp = String(req.user?.employeeNumber || '').trim();
  }
  return emp;
}

const deny = (res, status = 403, error = 'Access denied') =>
  res.status(status).json({ error });

/**
 * Employee numbers in the departments the caller supervises (read-only scope,
 * same rule as GET /api/supervisor-dtr/employees/me). Cached per request.
 */
async function supervisedEmployeeNumbers(req, caller) {
  if (req._supervisedEmployees) return req._supervisedEmployees;
  const { departments } = await fetchSupervisorDepartments(caller, { includeExpired: true });
  const codes = departments.map((d) => d.code).filter(Boolean);
  let list = [];
  if (codes.length) {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT employeeNumber FROM department_assignment WHERE code IN (${codes.map(() => '?').join(',')})`,
      codes,
    );
    list = rows.map((r) => String(r.employeeNumber || '').trim()).filter(Boolean);
  }
  req._supervisedEmployees = list;
  return list;
}

/** True when the caller may VIEW this employee's attendance: self or supervisor. */
async function canViewEmployee(req, caller, target) {
  if (employeeNumbersMatch(target, caller)) return true;
  const supervised = await supervisedEmployeeNumbers(req, caller);
  return supervised.some((e) => employeeNumbersMatch(e, target));
}

/**
 * Non-admin: req.body[field] must be the caller. A missing value is filled in
 * with the caller so new rows can only ever be created for themselves.
 */
function requireBodyOwner(field) {
  return (req, res, next) => {
    (async () => {
      if (isAdminRequest(req)) return next();
      const caller = await callerEmployeeNumber(req);
      if (!caller) return deny(res);
      const value = req.body?.[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        req.body = { ...(req.body || {}), [field]: caller };
        return next();
      }
      if (!employeeNumbersMatch(value, caller)) return deny(res);
      return next();
    })().catch(next);
  };
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Non-admin: the row `table.id = :idParam` must belong to the caller
 * (`ownerColumn`), and a body may not move it to someone else.
 * Table/column names are code constants, never request data.
 */
function requireRowOwner(table, ownerColumn, idParam = 'id') {
  if (!SAFE_IDENTIFIER.test(table) || !SAFE_IDENTIFIER.test(ownerColumn)) {
    throw new Error(`requireRowOwner: unsafe identifier ${table}.${ownerColumn}`);
  }
  return (req, res, next) => {
    (async () => {
      if (isAdminRequest(req)) return next();
      const caller = await callerEmployeeNumber(req);
      if (!caller) return deny(res);
      const [rows] = await db.promise().query(
        `SELECT ${ownerColumn} AS owner FROM ${table} WHERE id = ? LIMIT 1`,
        [req.params[idParam]],
      );
      if (!rows.length) return deny(res, 404, 'Record not found');
      if (!employeeNumbersMatch(rows[0].owner, caller)) return deny(res);
      const moved = req.body?.[ownerColumn];
      if (moved !== undefined && moved !== null && String(moved).trim() !== ''
        && !employeeNumbersMatch(moved, caller)) {
        return deny(res);
      }
      return next();
    })().catch(next);
  };
}

/**
 * List endpoints: admins get every row; anyone else gets only rows whose
 * `ownerField` is themselves. Implemented as a response filter so existing
 * list handlers stay unchanged (staff pages use these lists to find their
 * own row).
 */
function ownRowsOnly(ownerField) {
  return (req, res, next) => {
    (async () => {
      if (isAdminRequest(req)) return next();
      const caller = await callerEmployeeNumber(req);
      if (!caller) return deny(res);
      const json = res.json.bind(res);
      res.json = (body) => json(
        Array.isArray(body)
          ? body.filter((row) => employeeNumbersMatch(row?.[ownerField], caller))
          : body,
      );
      return next();
    })().catch(next);
  };
}

module.exports = {
  isAdminRequest,
  callerEmployeeNumber,
  supervisedEmployeeNumbers,
  canViewEmployee,
  requireBodyOwner,
  requireRowOwner,
  ownRowsOnly,
  deny,
};
