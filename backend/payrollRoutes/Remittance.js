const db = require('../db');
const express = require('express');
const router = express.Router();
const { notifyPayrollChanged } = require('../socket/socketService');
const { authenticateToken, logAudit, requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');

const getFullNameSQL = () => {
  return `CONCAT_WS(' ',
    p.firstName,
    p.middleName,
    p.lastName,
    CASE WHEN p.nameExtension IS NOT NULL AND p.nameExtension != ''
         THEN p.nameExtension
         ELSE NULL
    END
  ) as name`;
};

/**
 * Names for many employees in one round trip. Admin screens (PDS sections,
 * Leave Request, Department Assignment, Item Table, ...) used to call
 * GET /employees/:employeeNumber once per row, i.e. thousands of requests per
 * page load. Rows mirror GET /employees/:employeeNumber, plus person_table-only
 * employees (no users row), which the per-row person_table lookups also found.
 */
router.post('/employees/lookup', authenticateToken, requireAdmin, (req, res) => {
  const ids = [
    ...new Set(
      (Array.isArray(req.body?.employeeNumbers) ? req.body.employeeNumbers : [])
        .map((e) => String(e ?? '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 5000);
  if (ids.length === 0) return res.json([]);

  const sql = `
    SELECT u.employeeNumber, ${getFullNameSQL()},
           p.firstName, p.middleName, p.lastName, p.nameExtension
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE u.employeeNumber IN (?)
    UNION ALL
    SELECT p.agencyEmployeeNum AS employeeNumber, ${getFullNameSQL()},
           p.firstName, p.middleName, p.lastName, p.nameExtension
    FROM person_table p
    WHERE p.agencyEmployeeNum IN (?)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employeeNumber = p.agencyEmployeeNum)
  `;
  db.query(sql, [ids, ids], (err, rows) => {
    if (err) {
      console.error('Error looking up employees:', err);
      return res.status(500).json({ message: 'Error looking up employees' });
    }
    return res.json(rows);
  });
});

router.get('/employees/search', authenticateToken, requireAdmin, (req, res) => {
  const { q } = req.query;

  let sql = `
    SELECT u.employeeNumber, ${getFullNameSQL()}
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE p.firstName IS NOT NULL
  `;

  let queryParams = [];

  if (q && q.trim() !== '') {
    sql += ` AND (
      CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) LIKE ?
      OR p.firstName LIKE ?
      OR p.lastName LIKE ?
      OR u.employeeNumber LIKE ?
    )`;
    const searchTerm = `%${q.trim()}%`;
    queryParams = [searchTerm, searchTerm, searchTerm, searchTerm];
  }

  sql += ` ORDER BY p.firstName, p.lastName ASC LIMIT 50`;

  db.query(sql, queryParams, (err, result) => {
    if (err) {
      console.error('Error fetching employees:', err);
      return res.status(500).json({ message: 'Error fetching employees' });
    }
    return res.json(result);
  });
});

router.get(
  '/employees/department/search',
  authenticateToken,
  requireAdmin,
  (req, res) => {
    const { q } = req.query;
    const loggedInEmployeeNumber = req.user.employeeNumber;

    // First, determine the logged-in user's role
    const userSql = `
      SELECT 
        u.employeeNumber,
        u.role,
        sa.departmentCode AS supervisorDepartment
      FROM users u
      LEFT JOIN supervisor_assignment sa
        ON sa.supervisorEmployeeNumber = u.employeeNumber
        AND LOWER(sa.role) = 'supervisor'
      WHERE u.employeeNumber = ?
      LIMIT 1
    `;

    db.query(userSql, [loggedInEmployeeNumber], (err, userResult) => {
      if (err) {
        console.error('Error checking user access:', err);
        return res.status(500).json({
          message: 'Error checking user access',
        });
      }

      if (!userResult.length) {
        return res.status(403).json({
          message: 'User not found',
        });
      }

      const user = userResult[0];

      /*
       * ==========================================
       * 1. SUPERADMIN / TECHNICAL
       * ==========================================
       * These users can see ALL employees.
       */
      const isPrivileged =
        ['superadmin', 'technical'].includes(
          String(user.role).toLowerCase()
        );

      /*
       * ==========================================
       * 2. SUPERVISOR
       * ==========================================
       * If the user exists in supervisor_assignment
       * with role = Supervisor, use their department.
       */
      const departmentCode = user.supervisorDepartment;


      /*
       * ==========================================
       * 3. BUILD EMPLOYEE QUERY
       * ==========================================
       */
      let sql = `
        SELECT 
          u.employeeNumber,
          ${getFullNameSQL()}
        FROM users u
        LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
        LEFT JOIN department_assignment da ON da.employeeNumber = u.employeeNumber
        WHERE p.firstName IS NOT NULL
      `;

      const queryParams = [];

      // Supervisor can only see employees in their department
      if (!isPrivileged) {
        if (!departmentCode) {
          return res.json([]);
        }

        sql += `
          AND da.code = ?
        `;

        queryParams.push(departmentCode);
      }

      // Search condition
      if (q && q.trim() !== '') {
        sql += `
          AND (
            CONCAT_WS(
              ' ',
              p.firstName,
              p.middleName,
              p.lastName,
              p.nameExtension
            ) LIKE ?
            OR p.firstName LIKE ?
            OR p.lastName LIKE ?
            OR u.employeeNumber LIKE ?
          )
        `;

        const searchTerm = `%${q.trim()}%`;

        queryParams.push(
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm
        );
      }

      sql += `
        ORDER BY p.firstName ASC, p.lastName ASC
        LIMIT 50
      `;

      db.query(sql, queryParams, (err, result) => {
        if (err) {
          console.error('Error fetching employees:', err);
          return res.status(500).json({
            message: 'Error fetching employees',
          });
        }

        return res.json(result);
      });
    });
  }
);

router.get('/employees/:employeeNumber', authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const { employeeNumber } = req.params;

  const sql = `
    SELECT u.employeeNumber, ${getFullNameSQL()},
           p.firstName, p.middleName, p.lastName, p.nameExtension
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE u.employeeNumber = ?
  `;

  db.query(sql, [employeeNumber], (err, result) => {
    if (err) {
      console.error('Error fetching employee:', err);
      return res.status(500).json({ message: 'Error fetching employee' });
    }
    if (result.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    return res.json(result[0]);
  });
});

router.get('/employee-remittance', authenticateToken, requireAdmin, (req, res) => {
  const currentPage = Math.max(0, parseInt(req.query.page, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const offset = currentPage * limit;
  const queryTerm = (req.query.q || '').trim();

  let whereClause = '';
  const queryParams = [];
  if (queryTerm) {
    whereClause = `
      WHERE (
        r.employeeNumber LIKE ?
        OR CONCAT_WS(' ', p.lastName, p.firstName, p.middleName, p.nameExtension) LIKE ?
        OR CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) LIKE ?
      )
    `;
    const searchTerm = `%${queryTerm}%`;
    queryParams.push(searchTerm, searchTerm, searchTerm);
  }

  const countSql = `
    SELECT COUNT(*) AS total
    FROM remittance_table r
    LEFT JOIN users u ON r.employeeNumber = u.employeeNumber
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    ${whereClause}
  `;

  const sql = `
    SELECT r.id, r.employeeNumber,
           COALESCE(pp.name,
             CONCAT_WS(' ',
               p.firstName,
               p.middleName,
               p.lastName,
               CASE WHEN p.nameExtension IS NOT NULL AND p.nameExtension != ''
                    THEN p.nameExtension
                    ELSE NULL
               END
             )
           ) as name,
           p.firstName,
           p.middleName,
           p.lastName,
           p.nameExtension,
           r.liquidatingCash, r.gsisSalaryLoan, r.gsisPolicyLoan, r.gfal, r.gsisArrears,
           r.cpl, r.mpl, r.mplLite, r.emergencyLoan, r.nbc594, r.increment, r.sss,
           r.pagibig, r.pagibigFundCont, r.pagibig2, r.multiPurpLoan,
           r.landbankSalaryLoan, r.earistCreditCoop, r.feu, r.created_at, r.rel, r.gsl, r.gbk
    FROM remittance_table r
    LEFT JOIN users u ON r.employeeNumber = u.employeeNumber
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    LEFT JOIN payroll_processing pp ON r.employeeNumber = pp.employeeNumber
    ${whereClause}
    ORDER BY COALESCE(p.lastName, ''), COALESCE(p.firstName, ''), COALESCE(p.middleName, ''), COALESCE(p.nameExtension, '')
    LIMIT ?
    OFFSET ?
  `;

  db.query(countSql, queryParams, (err, countResult) => {
    if (err) {
      console.error('Error fetching remittance count:', err);
      return res.status(500).json({ message: 'Error fetching data', error: err.message });
    }

    const total = countResult?.[0]?.total || 0;
    const paramsWithPagination = [...queryParams, limit, offset];

    db.query(sql, paramsWithPagination, (err, result) => {
      if (err) {
        console.error('Error fetching remittance data:', err);
        return res.status(500).json({ message: 'Error fetching data', error: err.message });
      }
      return res.json({ total, page: currentPage, limit, data: result });
    });
  });
});

router.get('/debug/person-structure', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT u.employeeNumber,
           p.agencyEmployeeNum,
           p.firstName,
           p.middleName,
           p.lastName,
           p.nameExtension,
           ${getFullNameSQL()}
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE p.firstName IS NOT NULL
    LIMIT 5
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.error('Error fetching sample data:', err);
      return res.status(500).json({ message: 'Error fetching sample data' });
    }
    return res.json({
      message: 'Sample person data with constructed full names',
      sampleData: result,
      nameConstructionSQL: getFullNameSQL(),
    });
  });
});

router.post('/employee-remittance', authenticateToken, requireAdmin, (req, res) => {
  const {
    employeeNumber,
    liquidatingCash,
    gsisSalaryLoan,
    gsisPolicyLoan,
    gfal,
    gsisArrears,
    cpl,
    mpl,
    mplLite,
    emergencyLoan,
    nbc594,
    increment,
    sss,
    pagibig,
    pagibigFundCont,
    pagibig2,
    multiPurpLoan,
    landbankSalaryLoan,
    earistCreditCoop,
    feu,
    rel,
    gsl,
    gbk,
  } = req.body;

  const validateEmployeeSql = `
    SELECT u.employeeNumber
    FROM users u
    WHERE u.employeeNumber = ?
  `;

  db.query(validateEmployeeSql, [employeeNumber], (err, employeeResult) => {
    if (err) {
      console.error('Error validating employee:', err);
      return res.status(500).json({ message: 'Error validating employee' });
    }

    if (employeeResult.length === 0) {
      return res.status(400).json({ message: 'Employee not found' });
    }

    const checkDuplicateSql = `
      SELECT id, employeeNumber
      FROM remittance_table
      WHERE employeeNumber = ?
    `;

    db.query(checkDuplicateSql, [employeeNumber], (err, duplicateResult) => {
      if (err) {
        console.error('Error checking for duplicate employee:', err);
        return res.status(500).json({ message: 'Error checking for existing records' });
      }

      if (duplicateResult.length > 0) {
        return res.status(409).json({
          message: 'Employee data already exists',
          error: 'DUPLICATE_EMPLOYEE',
          existingRecordId: duplicateResult[0].id,
        });
      }

      const sql = `
        INSERT INTO remittance_table (
          employeeNumber, liquidatingCash, gsisSalaryLoan, gsisPolicyLoan, gfal, gsisArrears,
          cpl, mpl, mplLite, emergencyLoan, nbc594, increment, sss,
          pagibig, pagibigFundCont, pagibig2, multiPurpLoan,
          landbankSalaryLoan, earistCreditCoop, feu, gsl, rel, gbk
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        employeeNumber,
        liquidatingCash || 0,
        gsisSalaryLoan || 0,
        gsisPolicyLoan || 0,
        gfal || 0,
        gsisArrears || 0,
        cpl || 0,
        mpl || 0,
        mplLite || 0,
        emergencyLoan || 0,
        nbc594 || 0,
        increment || 0,
        sss || 0,
        pagibig || 0,
        pagibigFundCont || 0,
        pagibig2 || 0,
        multiPurpLoan || 0,
        landbankSalaryLoan || 0,
        earistCreditCoop || 0,
        feu || 0,
        rel || 0,
        gsl || 0,
        gbk || 0,
      ];

      db.query(sql, values, (err, result) => {
        if (err) {
          console.error('Error during POST request:', err);
          try {
            logAudit(req.user, 'Insert Failed', 'remittance_table', null, employeeNumber);
          } catch (e) {
            console.error('Audit log error:', e);
          }
          return res.status(500).json({ message: 'Error adding data' });
        }

        try {
          logAudit(req.user, 'Insert', 'remittance_table', result.insertId, employeeNumber);
        } catch (e) {
          console.error('Audit log error:', e);
        }

        notifyPayrollChanged('created', {
          module: 'remittance',
          id: result.insertId,
          employeeNumber,
        });

        return res.status(201).json({
          message: 'Data added successfully',
          id: result.insertId,
        });
      });
    });
  });
});

router.put('/employee-remittance/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const {
    employeeNumber,
    liquidatingCash,
    gsisSalaryLoan,
    gsisPolicyLoan,
    gfal,
    gsisArrears,
    cpl,
    mpl,
    mplLite,
    emergencyLoan,
    nbc594,
    increment,
    sss,
    pagibig,
    pagibigFundCont,
    pagibig2,
    multiPurpLoan,
    landbankSalaryLoan,
    earistCreditCoop,
    feu,
    rel,
    gsl,
    gbk,
  } = req.body;

  const validateEmployeeSql = `
    SELECT u.employeeNumber
    FROM users u
    WHERE u.employeeNumber = ?
  `;

  db.query(validateEmployeeSql, [employeeNumber], (err, employeeResult) => {
    if (err) {
      console.error('Error validating employee:', err);
      return res.status(500).json({ message: 'Error validating employee' });
    }

    if (employeeResult.length === 0) {
      return res.status(400).json({ message: 'Employee not found' });
    }

    const checkDuplicateSql = `
      SELECT id, employeeNumber
      FROM remittance_table
      WHERE employeeNumber = ? AND id != ?
    `;

    db.query(checkDuplicateSql, [employeeNumber, id], (err, duplicateResult) => {
      if (err) {
        console.error('Error checking for duplicate employee:', err);
        return res.status(500).json({ message: 'Error checking for existing records' });
      }

      if (duplicateResult.length > 0) {
        return res.status(409).json({
          message: 'Employee data already exists',
          error: 'DUPLICATE_EMPLOYEE',
          existingRecordId: duplicateResult[0].id,
        });
      }

      const sql = `
        UPDATE remittance_table
        SET employeeNumber = ?,
            liquidatingCash = ?,
            gsisSalaryLoan = ?,
            gsisPolicyLoan = ?,
            gfal = ?,
            gsisArrears = ?,
            cpl = ?,
            mpl = ?,
            mplLite = ?,
            emergencyLoan = ?,
            nbc594 = ?,
            increment = ?,
            sss = ?,
            pagibig = ?,
            pagibigFundCont = ?,
            pagibig2 = ?,
            multiPurpLoan = ?,
            landbankSalaryLoan = ?,
            earistCreditCoop = ?,
            feu = ?,
            rel = ?,
            gsl = ?,
            gbk = ?
        WHERE id = ?
      `;

      const values = [
        employeeNumber,
        liquidatingCash || 0,
        gsisSalaryLoan || 0,
        gsisPolicyLoan || 0,
        gfal || 0,
        gsisArrears || 0,
        cpl || 0,
        mpl || 0,
        mplLite || 0,
        emergencyLoan || 0,
        nbc594 || 0,
        increment || 0,
        sss || 0,
        pagibig || 0,
        pagibigFundCont || 0,
        pagibig2 || 0,
        multiPurpLoan || 0,
        landbankSalaryLoan || 0,
        earistCreditCoop || 0,
        feu || 0,
        rel || 0,
        gsl || 0,
        gbk || 0,
        id,
      ];

      db.query(sql, values, (err, result) => {
        if (err) {
          console.error('Error updating data:', err);
          try {
            logAudit(req.user, 'Update Failed', 'remittance_table', id, employeeNumber);
          } catch (e) {
            console.error('Audit log error:', e);
          }
          return res.status(500).json({ message: 'Error updating data' });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({ message: 'Remittance record not found' });
        }

        try {
          logAudit(req.user, 'Update', 'remittance_table', id, employeeNumber);
        } catch (e) {
          console.error('Audit log error:', e);
        }

        notifyPayrollChanged('updated', {
          module: 'remittance',
          id,
          employeeNumber,
        });

        return res.status(200).json({ message: 'Data updated successfully' });
      });
    });
  });
});

router.delete('/employee-remittance/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM remittance_table WHERE id = ?';

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('Error deleting data:', err);
      try {
        logAudit(req.user, 'Delete Failed', 'remittance_table', id, null);
      } catch (e) {
        console.error('Audit log error:', e);
      }
      return res.status(500).json({ message: 'Error deleting data' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Remittance record not found' });
    }

    try {
      logAudit(req.user, 'Delete', 'remittance_table', id, null);
    } catch (e) {
      console.error('Audit log error:', e);
    }

    notifyPayrollChanged('deleted', { module: 'remittance', id });
    return res.status(200).json({ message: 'Data deleted successfully' });
  });
});

module.exports = router;
