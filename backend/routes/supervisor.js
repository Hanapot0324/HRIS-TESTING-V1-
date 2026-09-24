const express = require('express');
const router  = express.Router();
const db      = require('../db');
const jwt     = require('jsonwebtoken');
const {
  authenticateToken,
  logAudit,
  requireAdmin,
  requireSupervisorSelfOrAdmin,
  requireSupervisorModuleAccess,
  ADMIN_ROLES,
} = require('../middleware/auth');
const {
  empMatchSql: supervisorEmpMatchSql,
  bindEmpMatchParams,
  resolveCanonicalEmployeeNumber,
  fetchSupervisorDepartments,
  grantSupervisorLeavePageAccess,
  revokeSupervisorLeavePageAccessIfUnassigned,
  DTR_SUPERVISOR_IDENTIFIER,
  hasSupervisorAssignment,
  sendSupervisorAssignmentNotice,
} = require('../utils/supervisorPageAccess');

const sanitizeAssignmentTitle = (role) => {
  const title = String(role || '').trim();
  if (!title) return 'Supervisor';
  return title.slice(0, 100);
};

const respondSupervisorContext = async (
  res,
  supervisorEmployeeNumber,
) => {
  try {
    const {
      supervisorEmployeeNumber: resolvedEmp,
      departments,
    } = await fetchSupervisorDepartments(
      supervisorEmployeeNumber,
    );

    // Check whether the employee has EVER had a
    // supervisor assignment, including expired ones.
    const hasAssignment =
      await hasSupervisorAssignment(
        supervisorEmployeeNumber,
      );

    // No assignment at all.
    if (!hasAssignment) {
      return res.json({
        isSupervisor: false,
        departments: [],
      });
    }

    // Only grant supervisor page access when there are
    // currently active assignments.
    if (departments.length > 0) {
      try {
        await grantSupervisorLeavePageAccess(
          resolvedEmp,
        );
      } catch (e) {
        console.error(
          "[supervisor-leave] context page access grant error:",
          e.message,
        );
      }
    }

    // IMPORTANT:
    // Even if the assignment has expired and departments=[]
    // the employee is still recognized as a supervisor.
    return res.json({
      isSupervisor: true,
      supervisorEmployeeNumber: String(
        resolvedEmp || supervisorEmployeeNumber,
      ).trim(),
      departments: Array.isArray(departments)
        ? departments
        : [],
    });
  } catch (err) {
    console.error(
      "[supervisor] context fetch error:",
      err.message,
    );

    return res.status(500).json({
      error: "Failed to fetch supervisor context",
    });
  }
};

const getActorEmployeeNumber = (req, fallback = null) => {
  if (req.user?.employeeNumber != null && String(req.user.employeeNumber).trim()) {
    return String(req.user.employeeNumber).trim();
  }
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded?.employeeNumber != null && String(decoded.employeeNumber).trim()) {
        return String(decoded.employeeNumber).trim();
      }
    } catch { /* silent */ }
  }
  return fallback ? String(fallback).trim() : 'unknown';
};

const resolveActorEmployeeNumber = async (req) => {
  const raw = getActorEmployeeNumber(req);
  if (raw && raw !== 'unknown') {
    const canonical = await resolveCanonicalEmployeeNumber(raw);
    if (canonical) return canonical;
  }
  const userId = req.user?.id;
  if (userId) {
    const rows = await new Promise((resolve, reject) => {
      db.query(
        'SELECT employeeNumber FROM users WHERE id = ? LIMIT 1',
        [userId],
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    });
    if (rows[0]?.employeeNumber) {
      return String(rows[0].employeeNumber).trim();
    }
  }
  return raw && raw !== 'unknown' ? raw : null;
};

const getEmployeeFullName = (employeeNumber) =>
  new Promise((resolve) => {
    if (!employeeNumber) return resolve('');
    db.query(
      `SELECT CONCAT_WS(' ', firstName, middleName, lastName, nameExtension) AS fullName
       FROM person_table WHERE agencyEmployeeNum = ? LIMIT 1`,
      [employeeNumber],
      (err, rows) => resolve((rows && rows[0] && rows[0].fullName) || ''),
    );
  });

const formatUserDisplayName = (employeeNumber, fullName) => {
  const emp  = employeeNumber ? String(employeeNumber) : 'unknown';
  const name = (fullName || '').trim();
  return name ? `${name} (${emp})` : emp;
};

const insertTransactionLog = (employeeId, message, actorEmployeeNumber = null, auditDetailsPayload = null) =>
  new Promise((resolve) => {
    if (!employeeId || !message) return resolve();
    db.query(
      'INSERT INTO transaction_table (employee_id, message) VALUES (?, ?)',
      [employeeId, message],
      (err, result) => {
        if (err) { console.error('[supervisor-leave] transaction log error:', err.message); return resolve(); }
        try {
          let detailsJson = null;
          if (auditDetailsPayload != null) {
            detailsJson = typeof auditDetailsPayload === 'string'
              ? auditDetailsPayload
              : JSON.stringify({ message, ...auditDetailsPayload });
          }
          logAudit(
            { employeeNumber: actorEmployeeNumber || employeeId },
            auditDetailsPayload != null ? 'Supervisor leave action' : message,
            'leave_request',
            result.insertId,
            employeeId,
            detailsJson,
          );
        } catch (e) { console.error('[supervisor-leave] audit mirror error:', e.message); }
        resolve();
      },
    );
  });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A — Supervisor Assignment CRUD  (Admin/HR manages these)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/supervisor-assignment
 * Returns all supervisor assignments, enriched with person names and dept description.
 */
router.get('/api/supervisor-assignment', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT
      sa.id,
      sa.supervisorEmployeeNumber,
      sa.departmentCode,
      sa.role,
      sa.start,
      sa.end,
      sa.createdAt,
      sa.updatedAt,
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) AS supervisorName,
      dt.description AS departmentDescription
    FROM supervisor_assignment sa
    LEFT JOIN person_table pt
      ON pt.agencyEmployeeNum = sa.supervisorEmployeeNumber
    LEFT JOIN person_table p
      ON p.agencyEmployeeNum = sa.supervisorEmployeeNumber
    LEFT JOIN department_table dt
      ON dt.code = sa.departmentCode
      WHERE sa.status = 0
    ORDER BY sa.role, sa.departmentCode, sa.supervisorEmployeeNumber
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch supervisor assignments' });
    res.json(Array.isArray(rows) ? rows : []);
  });
});

/**
 * GET /api/supervisor-assignment/by-supervisor/:employeeNumber
 * Returns all department assignments for a given supervisor.
 */
router.get('/api/supervisor-assignment/by-supervisor/:employeeNumber', authenticateToken, requireSupervisorSelfOrAdmin('employeeNumber'), (req, res) => {
  const sql = `
    SELECT sa.*, dt.description AS departmentDescription
    FROM supervisor_assignment sa
    LEFT JOIN department_table dt ON dt.code = sa.departmentCode
    WHERE sa.supervisorEmployeeNumber = ? AND status = 0
    ORDER BY sa.departmentCode
  `;
  db.query(
    sql.replace('sa.supervisorEmployeeNumber = ?', supervisorEmpMatchSql('sa.supervisorEmployeeNumber')),
    bindEmpMatchParams(req.params.employeeNumber),
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(Array.isArray(rows) ? rows : []);
    },
  );
});

/**
 * POST /api/supervisor-assignment
 * Assigns an employee as supervisor for a department.
 * Body: { supervisorEmployeeNumber, departmentCode, role, start, end  }
 */
router.post('/api/supervisor-assignment', authenticateToken, requireAdmin, async (req, res) => {
  const { supervisorEmployeeNumber, departmentCode, role, start, end } = req.body;
  const actorEmpNum = getActorEmployeeNumber(req);

  if (!supervisorEmployeeNumber || !departmentCode) {
    return res.status(400).json({ error: 'supervisorEmployeeNumber and departmentCode are required' });
  }
  const assignedRole = sanitizeAssignmentTitle(role);

  let canonicalSupervisor;
  try {
    canonicalSupervisor = await resolveCanonicalEmployeeNumber(supervisorEmployeeNumber);
  } catch (e) {
    console.error('[supervisor-leave] resolve supervisor employee error:', e.message);
    return res.status(500).json({ error: 'Failed to resolve supervisor employee' });
  }
  if (!canonicalSupervisor) {
    return res.status(400).json({ error: 'Supervisor employee not found in users table.' });
  }

  // ── Guard: block ANY duplicate active (status = 0) assignment for this
  // employee, whether it's the same department or a different one. ──
  const dupCheckSql = `
    SELECT id, departmentCode
    FROM supervisor_assignment
    WHERE ${supervisorEmpMatchSql('supervisorEmployeeNumber')}
      AND status = 0
    LIMIT 1
  `;
  db.query(dupCheckSql, bindEmpMatchParams(canonicalSupervisor), async (dupErr, dupRows) => {
    if (dupErr) {
      console.error('[supervisor-leave] duplicate check error:', dupErr.message);
      return res.status(500).json({ error: 'Failed to verify existing supervisor assignment' });
    }
    if (dupRows && dupRows.length) {
      try {
        await grantSupervisorLeavePageAccess(canonicalSupervisor);
      } catch (grantErr) {
        console.error('[supervisor-leave] duplicate guard page access grant error:', grantErr.message);
      }
      return res.status(409).json({
        error: `This employee already has an active supervisor assignment (department ${dupRows[0].departmentCode}). Remove or archive it before assigning a new one.`,
      });
    }

    // ── Original insert logic continues here, unchanged ──
    const sql = `
      INSERT INTO supervisor_assignment (supervisorEmployeeNumber, departmentCode, role, start, end)
      VALUES (?, ?, ?, ?, ?)
    `;
    db.query(sql, [canonicalSupervisor, departmentCode, assignedRole, start, end], async (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          try {
            await grantSupervisorLeavePageAccess(canonicalSupervisor);
          } catch (grantErr) {
            console.error('[supervisor-leave] duplicate assign page access grant error:', grantErr.message);
          }
          return res.status(409).json({ error: 'This supervisor is already assigned to this department.' });
        }
        logAudit({ employeeNumber: actorEmpNum }, 'Insert Failed', 'supervisor_assignment', null, canonicalSupervisor);
        return res.status(500).json({ error: 'Failed to create supervisor assignment' });
      }
      const insertedId = result.insertId;
      try {
        const [supName, actorName] = await Promise.all([
          getEmployeeFullName(canonicalSupervisor),
          getEmployeeFullName(actorEmpNum),
        ]);
        const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
        const supDisplay   = formatUserDisplayName(canonicalSupervisor, supName);
        logAudit({ employeeNumber: actorEmpNum }, `Assign Supervisor - ${assignedRole} for dept ${departmentCode}`, 'supervisor_assignment', insertedId, canonicalSupervisor);
        await insertTransactionLog(
          String(canonicalSupervisor),
          `${actorDisplay} assigned ${supDisplay} as ${assignedRole} for department ${departmentCode}.`,
          actorEmpNum,
          { action: 'supervisor_assigned', departmentCode, role: assignedRole, assignment_id: insertedId },
        );
      } catch (e) { console.error('[supervisor-leave] post-insert log error:', e.message); }

      try {
        await grantSupervisorLeavePageAccess(canonicalSupervisor);
      } catch (e) {
        console.error('[supervisor-leave] page access grant error:', e.message);
      }

      res.status(201).json({ id: insertedId, supervisorEmployeeNumber: canonicalSupervisor, departmentCode, role: assignedRole });
    });
  });
});

/**
 * PUT /api/supervisor-assignment/:id
 * Update role for an existing supervisor assignment.
 * Body: { role }
 */
router.put('/api/supervisor-assignment/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, start, end } = req.body;
  const actorEmpNum = getActorEmployeeNumber(req);
  const assignedRole = sanitizeAssignmentTitle(role);

  if (start && end && new Date(start) >= new Date(end)) {
    return res.status(400).json({ error: 'Start time must be before end time.' });
  }

  db.query(
    'SELECT * FROM supervisor_assignment WHERE id = ?',
    [id],
    async (fetchErr, rows) => {
      if (fetchErr || !rows.length) return res.status(404).json({ error: 'Assignment not found' });
      const current = rows[0];

      // Keep existing values if the client didn't send new ones.
      const newStart = start !== undefined && start !== null && start !== '' ? start : current.start;
      const newEnd   = end   !== undefined && end   !== null && end   !== '' ? end   : current.end;
      const endDate = newEnd ? new Date(newEnd) : null;
      const shouldReactivate =
        endDate && !Number.isNaN(endDate.getTime()) && endDate.getTime() > Date.now();

      db.query(
        'UPDATE supervisor_assignment SET role = ?, start = ?, end = ?, status = ? WHERE id = ?',
        [assignedRole, newStart, newEnd, shouldReactivate ? 0 : current.status, id],
        async (updateErr) => {
          if (updateErr) {
            logAudit({ employeeNumber: actorEmpNum }, 'Update Failed', 'supervisor_assignment', id, current.supervisorEmployeeNumber);
            return res.status(500).json({ error: 'Failed to update supervisor assignment' });
          }
          try {
            const [supName, actorName] = await Promise.all([
              getEmployeeFullName(current.supervisorEmployeeNumber),
              getEmployeeFullName(actorEmpNum),
            ]);
            const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
            const supDisplay   = formatUserDisplayName(current.supervisorEmployeeNumber, supName);

            const changeParts = [];
            if (assignedRole !== current.role) changeParts.push(`role to ${assignedRole}`);
            if (String(newStart) !== String(current.start)) changeParts.push(`start to ${newStart}`);
            if (String(newEnd) !== String(current.end)) changeParts.push(`end to ${newEnd}`);
            const changeSummary = changeParts.length ? changeParts.join(', ') : 'no changes';

            logAudit({ employeeNumber: actorEmpNum }, `Update Supervisor Assignment - ${changeSummary}`, 'supervisor_assignment', id, current.supervisorEmployeeNumber);
            await insertTransactionLog(
              String(current.supervisorEmployeeNumber),
              `${actorDisplay} updated ${supDisplay}'s assignment (${changeSummary}) for department ${current.departmentCode}.`,
              actorEmpNum,
              {
                action: 'supervisor_assignment_updated',
                departmentCode: current.departmentCode,
                old_role: current.role, new_role: assignedRole,
                old_start: current.start, new_start: newStart,
                old_end: current.end, new_end: newEnd,
              },
            );
          } catch (e) { console.error('[supervisor-leave] update log error:', e.message); }

          if (shouldReactivate) {
            try {
              await grantSupervisorLeavePageAccess(current.supervisorEmployeeNumber);
            } catch (grantErr) {
              console.error('[supervisor-leave] reactivate page access grant error:', grantErr.message);
            }
          }

          res.json({
            id,
            supervisorEmployeeNumber: current.supervisorEmployeeNumber,
            departmentCode: current.departmentCode,
            role: assignedRole,
            start: newStart,
            end: newEnd,
          });
        },
      );
    },
  );
});

/**
 * DELETE /api/supervisor-assignment/:id
 * Removes a supervisor from a department.
 */
router.delete('/api/supervisor-assignment/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id }  = req.params;
  const actorEmpNum = getActorEmployeeNumber(req);

  db.query('SELECT * FROM supervisor_assignment WHERE id = ?', [id], async (fetchErr, rows) => {
    if (fetchErr || !rows.length) return res.status(404).json({ error: 'Assignment not found' });
    const current = rows[0];
    db.query('DELETE FROM supervisor_assignment WHERE id = ?', [id], async (deleteErr) => {
      if (deleteErr) {
        logAudit({ employeeNumber: actorEmpNum }, 'Delete Failed', 'supervisor_assignment', id, current.supervisorEmployeeNumber);
        return res.status(500).json({ error: 'Failed to delete supervisor assignment' });
      }
      try {
        const [supName, actorName] = await Promise.all([
          getEmployeeFullName(current.supervisorEmployeeNumber),
          getEmployeeFullName(actorEmpNum),
        ]);
        const actorDisplay = formatUserDisplayName(actorEmpNum, actorName);
        const supDisplay   = formatUserDisplayName(current.supervisorEmployeeNumber, supName);
        logAudit({ employeeNumber: actorEmpNum }, `Remove Supervisor - ${current.role} from dept ${current.departmentCode}`, 'supervisor_assignment', id, current.supervisorEmployeeNumber);
        await insertTransactionLog(
          String(current.supervisorEmployeeNumber),
          `${actorDisplay} removed ${supDisplay} as ${current.role} from department ${current.departmentCode}.`,
          actorEmpNum,
          { action: 'supervisor_removed', departmentCode: current.departmentCode, role: current.role },
        );
      } catch (e) { console.error('[supervisor-leave] delete log error:', e.message); }

      try {
        await revokeSupervisorLeavePageAccessIfUnassigned(current.supervisorEmployeeNumber);
      } catch (e) {
        console.error('[supervisor-leave] page access revoke error:', e.message);
      }

      res.json({ message: 'Supervisor assignment removed successfully' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B — Supervisor Context Queries  (used by supervisor-facing UI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/supervisor-leave/context/me
 * Returns supervisor context for the logged-in user (avoids employee-number URL mismatches).
 */
router.get('/api/supervisor-leave/context/me', authenticateToken, async (req, res) => {
  try {
    const actorEmployeeNumber = await resolveActorEmployeeNumber(req);
    if (!actorEmployeeNumber) {
      return res.json({ isSupervisor: false, departments: [] });
    }
    return respondSupervisorContext(res, actorEmployeeNumber);
  } catch (e) {
    console.error('[supervisor-leave] context/me resolve error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch supervisor context' });
  }
});

/**
 * GET /api/supervisor-leave/context/:supervisorEmployeeNumber
 * Returns the supervisor's department codes and assigned title.
 */
router.get('/api/supervisor-leave/context/:supervisorEmployeeNumber', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), (req, res) => {
  respondSupervisorContext(res, req.params.supervisorEmployeeNumber);
});

const respondSupervisorLeaveRequests = (res, supervisorEmployeeNumber, query = {}) => {
  const { status, departmentCode } = query;

  db.query(
    `SELECT departmentCode, role FROM supervisor_assignment WHERE ${supervisorEmpMatchSql('supervisorEmployeeNumber')} AND status = 0`,
    bindEmpMatchParams(supervisorEmployeeNumber),
    (err, depts) => {
      if (err) return res.status(500).json({ error: 'Failed to resolve supervisor departments' });
      if (!depts || !depts.length) return res.json([]);

      const allowedCodes = depts.map((d) => d.departmentCode);
      const deptFilter   = departmentCode && allowedCodes.includes(departmentCode)
        ? [departmentCode]
        : allowedCodes;

      const placeholders = deptFilter.map(() => '?').join(',');

      let sql = `
        SELECT
          lr.id,
          lr.employeeNumber,
          lr.leave_code,
          lr.status,
          lr.deduction_applied_hours,
          lr.hr_approval_rate,
          lr.created_at,
          DATE_FORMAT(lr.leave_date, '%Y-%m-%d') AS leave_date,
          lt.leave_description,
          CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) AS employeeName,
          da.code AS departmentCode,
          dt.description AS departmentDescription
        FROM leave_request lr
        LEFT JOIN leave_table lt   ON lt.leave_code = lr.leave_code
        LEFT JOIN person_table p   ON p.agencyEmployeeNum = lr.employeeNumber
        INNER JOIN department_assignment da
          ON TRIM(CAST(da.employeeNumber AS CHAR)) = TRIM(CAST(lr.employeeNumber AS CHAR))
          AND da.code IN (${placeholders})
        LEFT JOIN department_table dt ON dt.code = da.code
        WHERE da.code IN (${placeholders})
      `;
      const params = [...deptFilter, ...deptFilter];

      if (status !== undefined && status !== null && status !== '') {
        sql += ' AND lr.status = ?';
        params.push(Number(status));
      }
      sql += ' ORDER BY lr.created_at DESC';

      db.query(sql, params, (err2, rows) => {
        if (err2) return res.status(500).json({ error: 'Failed to fetch supervisor leave requests' });
        res.json(Array.isArray(rows) ? rows : []);
      });
    },
  );
};

/**
 * GET /api/supervisor-leave/requests/me
 * Leave requests for employees in the logged-in supervisor's assigned department(s).
 */
router.get('/api/supervisor-leave/requests/me', authenticateToken, async (req, res) => {
  try {
    const supervisorEmployeeNumber = await resolveActorEmployeeNumber(req);
    if (!supervisorEmployeeNumber) {
      return res.json([]);
    }
    return respondSupervisorLeaveRequests(res, supervisorEmployeeNumber, req.query);
  } catch (e) {
    console.error('[supervisor-leave] requests/me resolve error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch supervisor leave requests' });
  }
});

/**
 * GET /api/supervisor-leave/requests/:supervisorEmployeeNumber
 */
router.get('/api/supervisor-leave/requests/:supervisorEmployeeNumber', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), (req, res) => {
  respondSupervisorLeaveRequests(res, req.params.supervisorEmployeeNumber, req.query);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C — Supervisor Approve / Deny  (status 1 = supervisor approved, 3 = denied)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/supervisor-leave/action/:leaveRequestId
 * Supervisor approves (status → 1) or denies (status → 3) a leave request.
 * Body: { newStatus: 1|3, supervisorEmployeeNumber, remarks? }
 *
 * Guards:
 *  - Only status 0 (pending) requests may be actioned by supervisor.
 *  - Supervisor must have the employee's department in their assignment list.
 *  - Once status is 1/2/3/4, supervisor cannot change it (HR owns 2/3/4).
 */
router.put('/api/supervisor-leave/action/:leaveRequestId', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), async (req, res) => {
  const { leaveRequestId } = req.params;
  const { newStatus, supervisorEmployeeNumber, remarks } = req.body;
  const actorEmpNum = getActorEmployeeNumber(req, supervisorEmployeeNumber);

  if (![1, 3].includes(Number(newStatus))) {
    return res.status(400).json({ error: 'Supervisor may only set status to 1 (approved) or 3 (denied).' });
  }
  if (!supervisorEmployeeNumber) {
    return res.status(400).json({ error: 'supervisorEmployeeNumber is required.' });
  }

  const callerRole = String(req.user?.role || '').toLowerCase();
  const callerEmp = String(req.user?.employeeNumber || '').trim();
  const actingSupervisor = ADMIN_ROLES.includes(callerRole)
    ? String(supervisorEmployeeNumber).trim()
    : callerEmp;

  if (!ADMIN_ROLES.includes(callerRole) && actingSupervisor !== String(supervisorEmployeeNumber).trim()) {
    return res.status(403).json({ error: 'Cannot act on behalf of another supervisor.' });
  }

  // Fetch the leave request
  db.query('SELECT * FROM leave_request WHERE id = ?', [leaveRequestId], async (fetchErr, rows) => {
    if (fetchErr || !rows.length) return res.status(404).json({ error: 'Leave request not found' });
    const request = rows[0];

    if (Number(request.status) !== 0) {
      return res.status(409).json({
        error: `Cannot action this request. Current status is ${request.status}; only Pending (0) requests can be actioned by the supervisor.`,
      });
    }

    // Verify supervisor has authority over the employee's department
    const verifySQL = `
      SELECT sa.departmentCode, sa.role
      FROM supervisor_assignment sa
      INNER JOIN department_assignment da
        ON da.code = sa.departmentCode
        AND CAST(da.employeeNumber AS CHAR) = CAST(? AS CHAR)
      WHERE ${supervisorEmpMatchSql('sa.supervisorEmployeeNumber')}
      LIMIT 1
    `;
    db.query(verifySQL, [request.employeeNumber, ...bindEmpMatchParams(actingSupervisor)], async (vErr, vRows) => {
      if (vErr) return res.status(500).json({ error: 'Failed to verify supervisor authority' });
      if (!vRows.length) {
        return res.status(403).json({
          error: 'You do not have supervisor authority over this employee\'s department.',
        });
      }
      const supRole        = vRows[0].role;
      const departmentCode = vRows[0].departmentCode;

      // Update leave_request status
      db.query(
        'UPDATE leave_request SET status = ? WHERE id = ?',
        [Number(newStatus), leaveRequestId],
        async (updateErr) => {
          if (updateErr) {
            logAudit({ employeeNumber: actorEmpNum }, 'Supervisor Action Failed', 'leave_request', leaveRequestId, request.employeeNumber);
            return res.status(500).json({ error: 'Failed to update leave request status' });
          }

          const actionLabel = Number(newStatus) === 1 ? 'approved' : 'denied';
          try {
            const [supName, empName, leaveDescRes] = await Promise.all([
              getEmployeeFullName(supervisorEmployeeNumber),
              getEmployeeFullName(request.employeeNumber),
              new Promise((resolve) =>
                db.query(
                  'SELECT leave_description FROM leave_table WHERE leave_code = ? LIMIT 1',
                  [request.leave_code],
                  (e, r) => resolve((r && r[0] && r[0].leave_description) || request.leave_code),
                ),
              ),
            ]);
            const supDisplay = formatUserDisplayName(supervisorEmployeeNumber, supName);
            const empDisplay = formatUserDisplayName(request.employeeNumber, empName);
            const actionMsg  = Number(newStatus) === 1
              ? `${supRole} ${supDisplay} approved ${empDisplay}'s ${leaveDescRes} request (leave date: ${request.leave_date}).`
              : `${supRole} ${supDisplay} denied ${empDisplay}'s ${leaveDescRes} request (leave date: ${request.leave_date}).${remarks ? ' Reason: ' + remarks : ''}`;

            logAudit(
              { employeeNumber: actorEmpNum },
              `Supervisor ${actionLabel === 'approved' ? 'Approved' : 'Denied'} Leave - ${leaveDescRes}`,
              'leave_request',
              leaveRequestId,
              request.employeeNumber,
            );
            await insertTransactionLog(
              String(request.employeeNumber),
              actionMsg,
              actorEmpNum,
              {
                action: `supervisor_${actionLabel}`,
                leave_request_id: leaveRequestId,
                leave_code: request.leave_code,
                leave_date: request.leave_date,
                supervisor_role: supRole,
                departmentCode,
                remarks: remarks || null,
              },
            );
          } catch (e) { console.error('[supervisor-leave] action log error:', e.message); }

          res.json({
            message: `Leave request ${actionLabel} by ${supRole}.`,
            id:     leaveRequestId,
            status: Number(newStatus),
          });
        },
      );
    });
  });
});

/**
 * PUT /api/supervisor-leave/bulk-action
 * Bulk approve or deny by supervisor.
 * Body: { ids: [1,2,3], newStatus: 1|3, supervisorEmployeeNumber, remarks? }
 */
router.put('/api/supervisor-leave/bulk-action', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), async (req, res) => {
  const { ids, newStatus, supervisorEmployeeNumber, remarks } = req.body;
  const callerRole = String(req.user?.role || '').toLowerCase();
  const callerEmp = String(req.user?.employeeNumber || '').trim();
  const actingSupervisor = ADMIN_ROLES.includes(callerRole)
    ? String(supervisorEmployeeNumber).trim()
    : callerEmp;
  const actorEmpNum = getActorEmployeeNumber(req, actingSupervisor);

  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (![1, 3].includes(Number(newStatus))) return res.status(400).json({ error: 'newStatus must be 1 or 3' });
  if (!supervisorEmployeeNumber) return res.status(400).json({ error: 'supervisorEmployeeNumber is required' });

  if (!ADMIN_ROLES.includes(callerRole) && actingSupervisor !== String(supervisorEmployeeNumber).trim()) {
    return res.status(403).json({ error: 'Cannot act on behalf of another supervisor.' });
  }

  const placeholders = ids.map(() => '?').join(',');
  db.query(
    `SELECT lr.id, lr.employeeNumber, lr.leave_code, lr.leave_date, lr.status, lt.leave_description
     FROM leave_request lr
     LEFT JOIN leave_table lt ON lt.leave_code = lr.leave_code
     WHERE lr.id IN (${placeholders})`,
    ids,
    async (fetchErr, requests) => {
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!requests.length) return res.status(404).json({ error: 'No requests found' });

      // Validate only pending ones
      const pending = requests.filter((r) => Number(r.status) === 0);
      if (!pending.length) return res.status(409).json({ error: 'None of the selected requests are in Pending status.' });

      // Verify supervisor authority over all employees
      const empNums      = [...new Set(pending.map((r) => r.employeeNumber))];
      const empPlaceholders = empNums.map(() => '?').join(',');
      const verifySql = `
        SELECT DISTINCT da.employeeNumber
        FROM supervisor_assignment sa
        INNER JOIN department_assignment da ON da.code = sa.departmentCode
        WHERE ${supervisorEmpMatchSql('sa.supervisorEmployeeNumber')}
          AND CAST(da.employeeNumber AS CHAR) IN (${empPlaceholders})
      `;
      db.query(verifySql, [...bindEmpMatchParams(actingSupervisor), ...empNums.map(String)], async (vErr, vRows) => {
        if (vErr) return res.status(500).json({ error: 'Failed to verify supervisor authority' });
        const authorizedEmps = new Set(vRows.map((r) => String(r.employeeNumber)));
        const unauthorized   = empNums.filter((n) => !authorizedEmps.has(String(n)));
        if (unauthorized.length) {
          return res.status(403).json({ error: `Not authorized for employees: ${unauthorized.join(', ')}` });
        }

        const pendingIds = pending.map((r) => r.id);
        const idPH       = pendingIds.map(() => '?').join(',');
        db.query(
          `UPDATE leave_request SET status = ? WHERE id IN (${idPH})`,
          [Number(newStatus), ...pendingIds],
          async (updateErr) => {
            if (updateErr) return res.status(500).json({ error: 'Bulk update failed' });
            const actionLabel = Number(newStatus) === 1 ? 'approved' : 'denied';
            try {
              const [supName] = await Promise.all([getEmployeeFullName(actingSupervisor)]);
              const supDisplay = formatUserDisplayName(actingSupervisor, supName);
              const [supRole]  = await new Promise((resolve) =>
                db.query(
                  `SELECT role FROM supervisor_assignment WHERE ${supervisorEmpMatchSql('supervisorEmployeeNumber')} AND status = 0 LIMIT 1`,
                  bindEmpMatchParams(actingSupervisor),
                  (e, r) => resolve([r && r[0] && r[0].role ? r[0].role : 'Supervisor']),
                ),
              );
              logAudit(
                { employeeNumber: actorEmpNum },
                `Supervisor Bulk ${actionLabel === 'approved' ? 'Approve' : 'Deny'} Leave (${pendingIds.length} requests)`,
                'leave_request',
                null,
                actingSupervisor,
              );
              await Promise.all(
                pending.map(async (r) => {
                  const empName = await getEmployeeFullName(r.employeeNumber);
                  const empDisplay = formatUserDisplayName(r.employeeNumber, empName);
                  const msg = `${supRole} ${supDisplay} bulk ${actionLabel} ${empDisplay}'s ${r.leave_description || r.leave_code} request (leave date: ${r.leave_date}).${remarks ? ' Reason: ' + remarks : ''}`;
                  return insertTransactionLog(String(r.employeeNumber), msg, actorEmpNum, {
                    action: `supervisor_bulk_${actionLabel}`,
                    leave_request_id: r.id,
                    leave_code: r.leave_code,
                    leave_date: r.leave_date,
                    supervisor_role: supRole,
                    remarks: remarks || null,
                  });
                }),
              );
            } catch (e) { console.error('[supervisor-leave] bulk action log error:', e.message); }
            res.json({ message: `${pendingIds.length} request(s) ${actionLabel} by supervisor.`, updated: pendingIds.length, newStatus: Number(newStatus) });
          },
        );
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION D — Department employee list  (for supervisor's dashboard overview)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/supervisor-leave/employees/:supervisorEmployeeNumber
 * Returns all employees under the supervisor's department(s), with leave summary.
 */
router.get('/api/supervisor-leave/employees/:supervisorEmployeeNumber', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), (req, res) => {
  const { supervisorEmployeeNumber } = req.params;
  const deptSql = `
    SELECT departmentCode FROM supervisor_assignment WHERE ${supervisorEmpMatchSql('supervisorEmployeeNumber')} AND status = 0
  `;
  db.query(deptSql, bindEmpMatchParams(supervisorEmployeeNumber), (err, depts) => {
    if (err) return res.status(500).json({ error: 'Failed to resolve supervisor departments' });
    if (!depts.length) return res.json([]);
    const codes        = depts.map((d) => d.departmentCode);
    const placeholders = codes.map(() => '?').join(',');
    const sql = `
      SELECT
        da.employeeNumber,
        da.code AS departmentCode,
        dt.description AS departmentDescription,
        CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) AS employeeName,
        0 AS pendingCount,
        0 AS supervisorApprovedCount,
        0 AS hrApprovedCount
      FROM department_assignment da
      LEFT JOIN department_table dt ON dt.code = da.code
      LEFT JOIN person_table p      ON p.agencyEmployeeNum = da.employeeNumber
      WHERE da.code IN (${placeholders})
      ORDER BY da.code, p.lastName, p.firstName
    `;
    db.query(sql, codes, (err2, rows) => {
      if (err2) return res.status(500).json({ error: 'Failed to fetch department employees' });
      const list = Array.isArray(rows) ? rows : [];
      // Leave counts in one grouped, index-friendly query. They used to be three
      // correlated CAST(...) subqueries per employee, each scanning all of
      // leave_request (millions of row reads for a large department).
      const keyOf = (v) => String(v ?? '').trimEnd().toLowerCase();
      const empNums = [...new Set(list.map((r) => String(r.employeeNumber ?? '')).filter(Boolean))];
      if (empNums.length === 0) return res.json(list);
      db.query(
        `SELECT employeeNumber, status, COUNT(*) AS n
         FROM leave_request
         WHERE employeeNumber IN (?) AND status IN (0, 1, 2)
         GROUP BY employeeNumber, status`,
        [empNums],
        (err3, counts) => {
          if (err3) return res.status(500).json({ error: 'Failed to fetch department employees' });
          const field = { 0: 'pendingCount', 1: 'supervisorApprovedCount', 2: 'hrApprovedCount' };
          const byEmp = new Map();
          for (const c of counts) {
            const k = keyOf(c.employeeNumber);
            const f = field[Number(c.status)];
            if (!f) continue;
            const acc = byEmp.get(k) || { pendingCount: 0, supervisorApprovedCount: 0, hrApprovedCount: 0 };
            acc[f] += Number(c.n) || 0;
            byEmp.set(k, acc);
          }
          for (const r of list) Object.assign(r, byEmp.get(keyOf(r.employeeNumber)) || {});
          res.json(list);
        },
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION E — Transaction log fetch for supervisor view
// ─────────────────────────────────────────────────────────────────────────────

const respondSupervisorTransactions = (res, supervisorEmployeeNumber) => {
  db.query(
    `SELECT departmentCode FROM supervisor_assignment WHERE ${supervisorEmpMatchSql('supervisorEmployeeNumber')} AND status = 0`,
    bindEmpMatchParams(supervisorEmployeeNumber),
    (err, depts) => {
      if (err) return res.status(500).json({ error: 'Failed to resolve departments' });
      if (!depts.length) return res.json([]);
      const codes = depts.map((d) => d.departmentCode);
      const ph    = codes.map(() => '?').join(',');
      const sql   = `
        SELECT DISTINCT tt.*
        FROM transaction_table tt
        INNER JOIN department_assignment da
          ON TRIM(CAST(da.employeeNumber AS CHAR)) = TRIM(CAST(tt.employee_id AS CHAR))
          AND da.code IN (${ph})
        ORDER BY tt.id DESC
        LIMIT 500
      `;
      db.query(sql, codes, (err2, rows) => {
        if (err2) return res.status(500).json({ error: 'Failed to fetch transaction logs' });
        res.json(Array.isArray(rows) ? rows : []);
      });
    },
  );
};

/**
 * GET /api/supervisor-leave/transactions/me
 */
router.get('/api/supervisor-leave/transactions/me', authenticateToken, async (req, res) => {
  try {
    const supervisorEmployeeNumber = await resolveActorEmployeeNumber(req);
    if (!supervisorEmployeeNumber) {
      return res.json([]);
    }
    return respondSupervisorTransactions(res, supervisorEmployeeNumber);
  } catch (e) {
    console.error('[supervisor-leave] transactions/me resolve error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch supervisor transactions' });
  }
});

/**
 * GET /api/supervisor-leave/transactions/:supervisorEmployeeNumber
 */
router.get('/api/supervisor-leave/transactions/:supervisorEmployeeNumber', authenticateToken, requireSupervisorSelfOrAdmin('supervisorEmployeeNumber'), (req, res) => {
  respondSupervisorTransactions(res, req.params.supervisorEmployeeNumber);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION F — Supervisor DTR (department-scoped employee list)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/supervisor-dtr/context/me
 * Same supervisor_assignment context as leave (shared departments).
 * Staff with supervisor_assignment may access (role stays staff).
 */
router.get('/api/supervisor-dtr/context/me', authenticateToken, async (req, res) => {
  try {
    const actorEmployeeNumber = await resolveActorEmployeeNumber(req);
    if (!actorEmployeeNumber) {
      return res.json({ isSupervisor: false, departments: [] });
    }
    return respondSupervisorContext(res, actorEmployeeNumber);
  } catch (e) {
    console.error('[supervisor-dtr] context/me resolve error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch supervisor context' });
  }
});

/**
 * GET /api/supervisor-dtr/employees/me
 * All employees in the supervisor's assigned department(s) (department_assignment).
 * startDate/endDate are accepted for client compatibility; attendance is loaded separately.
 *
 * [CHANGE] READ-ONLY VIEWING AFTER EXPIRY: this route now passes
 * { includeExpired: true } to fetchSupervisorDepartments(), so a supervisor
 * whose supervisor_assignment window has lapsed (status flipped to 1 by the
 * expireSupervisorAssignments() cron job) can still see their former
 * department's employee list here. This endpoint is GET-only and never
 * mutates data, so surfacing it after expiry does not grant any write
 * capability — official time create/edit/upload endpoints separately call
 * ensureActiveSupervisorAssignment() and will still reject an expired
 * supervisor with a 403, regardless of what this endpoint returns.
 */
router.get('/api/supervisor-dtr/employees/me', authenticateToken, requireSupervisorModuleAccess(DTR_SUPERVISOR_IDENTIFIER), async (req, res) => {
  const { departmentCode } = req.query;

  try {
    const actorEmployeeNumber = await resolveActorEmployeeNumber(req);
    if (!actorEmployeeNumber) return res.json([]);

    // [CHANGE] includeExpired: true — view-only list stays populated even
    // after the assignment's end date has passed.
    const { departments } = await fetchSupervisorDepartments(actorEmployeeNumber, { includeExpired: true });
    if (!departments.length) return res.json([]);

    let codes = departments.map((d) => d.code);
    if (departmentCode && codes.includes(departmentCode)) {
      codes = [departmentCode];
    }

    const placeholders = codes.map(() => '?').join(',');
    // Fast path: no full-table attendancerecordinfo GROUP BY (indexes can be used).
    // Device names loaded only for employees missing person_table names.
    const sql = `
      SELECT DISTINCT
        da.employeeNumber AS personID,
        p.firstName,
        p.lastName,
        p.middleName,
        CASE
          WHEN p.agencyEmployeeNum IS NOT NULL THEN 'Registered'
          ELSE 'Not Registered'
        END AS registrationStatus,
        da.code AS departmentCode
      FROM department_assignment da
      LEFT JOIN person_table p
        ON da.employeeNumber = p.agencyEmployeeNum
      WHERE da.code IN (${placeholders})
      ORDER BY
        CASE WHEN p.lastName IS NULL THEN 1 ELSE 0 END,
        p.lastName ASC,
        p.firstName ASC,
        da.employeeNumber ASC
    `;

    db.query(sql, codes, (err, rows) => {
      if (err) {
        console.error('[supervisor-dtr] employees/me error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch supervisor DTR employees' });
      }

      const list = Array.isArray(rows) ? rows : [];
      const missingIds = [
        ...new Set(
          list
            .filter((r) => !(r.firstName || r.lastName))
            .map((r) => String(r.personID ?? '').trim())
            .filter(Boolean),
        ),
      ];

      if (!missingIds.length) {
        return res.json(list.map((r) => ({ ...r, devicePersonName: null })));
      }

      const idPh = missingIds.map(() => '?').join(',');
      db.query(
        `SELECT PersonID, MAX(PersonName) AS PersonName
         FROM attendancerecordinfo
         WHERE PersonID IN (${idPh})
         GROUP BY PersonID`,
        missingIds,
        (nameErr, nameRows) => {
          if (nameErr) {
            console.warn('[supervisor-dtr] device names:', nameErr.message || nameErr);
            return res.json(list.map((r) => ({ ...r, devicePersonName: null })));
          }
          const nameMap = new Map();
          (nameRows || []).forEach((n) => {
            nameMap.set(String(n.PersonID), n.PersonName || null);
          });
          res.json(
            list.map((r) => ({
              ...r,
              devicePersonName: nameMap.get(String(r.personID)) || null,
            })),
          );
        },
      );
    });
  } catch (e) {
    console.error('[supervisor-dtr] employees/me resolve error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch supervisor DTR employees' });
  }
});

/**
 * GET /api/supervisor-assignment/archived
 * Returns supervisor assignments whose period has ended (status = 1).
 */
router.get('/api/supervisor-assignment/archived', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT
      sa.id,
      sa.supervisorEmployeeNumber,
      sa.departmentCode,
      sa.role,
      sa.start,
      sa.end,
      sa.createdAt,
      sa.updatedAt,
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) AS supervisorName,
      dt.description AS departmentDescription
    FROM supervisor_assignment sa
    LEFT JOIN person_table p
      ON p.agencyEmployeeNum = sa.supervisorEmployeeNumber
    LEFT JOIN department_table dt
      ON dt.code = sa.departmentCode
    WHERE sa.status = 1
    ORDER BY sa.end DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch archived supervisor assignments' });
    res.json(Array.isArray(rows) ? rows : []);
  });
});

module.exports = router;
