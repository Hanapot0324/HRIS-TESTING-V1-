const { authenticateToken } = require('../middleware/auth');
const {
  isAdminRequest,
  callerEmployeeNumber,
  canViewEmployee,
  deny,
} = require('../utils/accessScope');

/**
 * Access policy for every route in dashboardRoutes/Attendance.js (mounted at
 * /attendance). Applied once with router.use, before the routes.
 *
 * DENY BY DEFAULT: any route not listed below is HR/admin-only, so a route
 * added later without a policy can't be reached by staff by accident.
 *
 *   shared         - any signed-in user (institution-wide calendars only)
 *   viewOne(...)   - one employee's records, named by the first present
 *                    field: allowed for that employee, their department
 *                    supervisor (read-only scope), or HR/admin
 *   viewMany(f)    - body[f] is a list of employees; every one must be
 *                    viewable as above (supervisor DTR page)
 *   selfDefault(...) - like viewOne, but a missing employee defaults to the
 *                    caller instead of "everyone"
 */
const shared = { kind: 'shared' };
const viewOne = (...fields) => ({ kind: 'viewOne', fields });
const viewMany = (field) => ({ kind: 'viewMany', field });
const selfDefault = (...fields) => ({ kind: 'selfDefault', fields });

const POLICIES = {
  'GET /api/suspensions': shared,
  'GET /api/holiday': shared,
  'POST /api/module-search-audit': shared, // writes an audit row about the caller's own search

  'GET /api/attendance': viewOne('personId'),
  'GET /api/check-attendance': viewOne('personID'),
  'POST /api/attendance': viewOne('personID'),
  'POST /api/view-attendance': viewOne('personID'),
  'GET /api/dtr': viewOne('personID'),
  'GET /api/overall_attendance_record': viewOne('personID'),
  'POST /api/attendance-records': viewOne('personID'),
  'POST /api/view-attendance-full': viewOne('personID'),
  'GET /api/leaves': selfDefault('personId', 'employeeNumber'),

  'POST /api/attendance-raw-batch': viewMany('personIDs'),
  'POST /api/view-attendance-all-users-paged': viewMany('employeeNumbers'),
  'POST /api/overall_attendance_record/daily-late-undertime/batch': viewMany('employeeNumbers'),
  'POST /api/dtr-print-status': viewMany('employeeNumbers'),
  // Supervisors record that they printed their department's DTRs.
  'POST /api/mark-dtr-printed': viewMany('employeeNumbers'),
};

/**
 * Every employee value supplied for these fields, from the query AND the body —
 * all must pass, so a caller can't put themselves in the query and someone
 * else in the body (handlers differ in which one they read).
 */
function suppliedTargets(req, fields) {
  const out = [];
  for (const src of [req.query, req.body]) {
    for (const f of fields) {
      const v = src?.[f];
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        if (String(item).trim() !== '') out.push(String(item).trim());
      }
    }
  }
  return out;
}

async function enforce(req, res, next) {
  if (isAdminRequest(req)) return next();

  const policy = POLICIES[`${req.method} ${req.path}`];
  if (!policy) return deny(res, 403, 'Insufficient permissions');
  if (policy.kind === 'shared') return next();

  const caller = await callerEmployeeNumber(req);
  if (!caller) return deny(res);

  if (policy.kind === 'viewOne' || policy.kind === 'selfDefault') {
    const targets = suppliedTargets(req, policy.fields);
    if (!targets.length) {
      if (policy.kind !== 'selfDefault') return deny(res, 400, 'Employee is required');
      // Scope "all employees" down to the caller.
      req.query[policy.fields[0]] = caller;
      return next();
    }
    for (const target of targets) {
      if (!(await canViewEmployee(req, caller, target))) return deny(res);
    }
    return next();
  }

  // viewMany: an explicit, non-empty list is required (no "everyone" default).
  const list = req.body?.[policy.field];
  if (!Array.isArray(list) || list.length === 0) {
    return deny(res, 400, `${policy.field} is required`);
  }
  for (const target of list) {
    if (!(await canViewEmployee(req, caller, String(target ?? '').trim()))) return deny(res);
  }
  return next();
}

/** router.use(...attendanceAccessPolicy) */
const attendanceAccessPolicy = [
  authenticateToken,
  (req, res, next) => enforce(req, res, next).catch(next),
];

module.exports = { attendanceAccessPolicy, POLICIES };
