const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { empMatchSql, bindEmpMatchParams } = require('../utils/supervisorPageAccess');
const { isLeaveAllowedForGender } = require('../utils/leaveGender');

/**
 * Staff self-service endpoints (mobile app + web staff pages).
 *
 * Every handler reads the employee ONLY from the verified session token
 * (req.user.employeeNumber). None of these routes accept an employee number,
 * person ID or record ID from the client, so there is nothing to tamper with
 * to reach another employee's data. Responses are limited to allow-listed fields.
 */
const router = express.Router();
router.use(authenticateToken);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DTR_RANGE_DAYS = 62;

function callerEmployeeNumber(req) {
  return String(req.user?.employeeNumber || '').trim();
}

/** Deny by default when the caller's identity can't be established. */
router.use((req, res, next) => {
  if (!callerEmployeeNumber(req)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

function parseDateOnly(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

// GET /api/me/profile — the caller's own employee-viewable profile fields.
router.get('/profile', async (req, res) => {
  const emp = callerEmployeeNumber(req);
  try {
    const [rows] = await db.promise().query(
      `SELECT
         u.employeeNumber,
         p.firstName, p.middleName, p.lastName, p.nameExtension,
         u.email,
         p.mobileNum,
         etc.typeName AS employmentType,
         da.name AS department
       FROM users u
       LEFT JOIN person_table p ON p.agencyEmployeeNum = u.employeeNumber
       LEFT JOIN employment_category ec
         ON CAST(ec.employeeNumber AS CHAR) = CAST(u.employeeNumber AS CHAR)
       LEFT JOIN employment_type_config etc
         ON etc.id = COALESCE(ec.employmentCategory, u.employmentCategory)
       LEFT JOIN department_assignment da ON da.employeeNumber = u.employeeNumber
       WHERE ${empMatchSql('u.employeeNumber')}
       LIMIT 1`,
      bindEmpMatchParams(emp),
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/me/profile failed:', err.code || err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// GET /api/me/dtr?from=YYYY-MM-DD&to=YYYY-MM-DD — the caller's own DTR rows.
router.get('/dtr', async (req, res) => {
  const from = parseDateOnly(req.query.from);
  const to = parseDateOnly(req.query.to);
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to must be valid dates (YYYY-MM-DD)' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'to must not be before from' });
  }
  const days = Math.round((to - from) / 86_400_000) + 1;
  if (days > MAX_DTR_RANGE_DAYS) {
    return res.status(400).json({ error: `Date range may not exceed ${MAX_DTR_RANGE_DAYS} days` });
  }

  const emp = callerEmployeeNumber(req);
  try {
    const [rows] = await db.promise().query(
      `SELECT
         DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
         DAYNAME(ar.date) AS day,
         ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
         ar.remarks,
         ot.officialTimeIN, ot.officialTimeOUT,
         ot.officialBreaktimeIN, ot.officialBreaktimeOUT
       FROM attendancerecord ar
       LEFT JOIN officialtime ot ON DAYNAME(ar.date) = ot.day
         AND ar.personID = ot.employeeID
         AND ar.date BETWEEN ot.startDate AND ot.endDate
       WHERE ${empMatchSql('ar.personID')}
         AND ar.date BETWEEN ? AND ?
       ORDER BY ar.date ASC`,
      [...bindEmpMatchParams(emp), req.query.from, req.query.to],
    );
    res.json({ from: req.query.from, to: req.query.to, records: rows });
  } catch (err) {
    console.error('GET /api/me/dtr failed:', err.code || err.message);
    res.status(500).json({ error: 'Failed to load DTR' });
  }
});

// GET /api/me/leave-types — leave types the caller may file, per the server's
// gender_restriction rule. Id, code + description only; entitlements stay server-side.
router.get('/leave-types', async (req, res) => {
  const emp = callerEmployeeNumber(req);
  try {
    const [[person], [types]] = await Promise.all([
      db.promise().query(
        `SELECT p.sex FROM person_table p WHERE ${empMatchSql('p.agencyEmployeeNum')} LIMIT 1`,
        bindEmpMatchParams(emp),
      ),
      db.promise().query(
        'SELECT id, leave_code, leave_description, gender_restriction FROM leave_table ORDER BY leave_code',
      ),
    ]);
    const sex = person[0]?.sex;
    res.json(
      types
        .filter((t) => isLeaveAllowedForGender(t.gender_restriction, sex))
        .map((t) => ({ id: t.id, leave_code: t.leave_code, leave_description: t.leave_description })),
    );
  } catch (err) {
    console.error('GET /api/me/leave-types failed:', err.code || err.message);
    res.status(500).json({ error: 'Failed to load leave types' });
  }
});

module.exports = router;
