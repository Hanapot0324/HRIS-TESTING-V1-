const db = require("../db");
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { requireAdmin, JWT_SECRET, employeeNumbersMatch } = require('../middleware/auth');

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Audit logging
function logAudit(user, action, tableName, recordId, targetEmployeeNumber = null) {
  const auditQuery = `
    INSERT INTO audit_log (employeeNumber, action, table_name, record_id, targetEmployeeNumber, timestamp)
    VALUES (?, ?, ?, ?, ?, NOW())
  `;
  const employeeNumber =
    user && typeof user === 'object' && user.employeeNumber
      ? user.employeeNumber
      : user || null;
  db.query(auditQuery, [employeeNumber, action, tableName, recordId, targetEmployeeNumber], (err) => {
    if (err) console.error('Error inserting audit log:', err);
  });
}

// ============================================================
// EMPLOYMENT TYPE CONFIG ROUTES (Dynamic types management)
// ============================================================

// GET all employment type configs (flat + grouped)
router.get('/employment-type-config', authenticateToken, (req, res) => {
  const sql = `
    SELECT id, parentGroup, typeName, colorHex, isActive, sortOrder
    FROM employment_type_config
    ORDER BY sortOrder ASC, parentGroup ASC, typeName ASC
  `;
  db.query(sql, (err, results) => {
    if (err) {
      console.error('Error fetching employment type configs:', err);
      return res.status(500).json({ message: 'Error fetching employment type configs' });
    }
    const grouped = {};
    results.forEach(row => {
      if (!grouped[row.parentGroup]) grouped[row.parentGroup] = [];
      grouped[row.parentGroup].push(row);
    });
    res.json({ flat: results, grouped });
  });
});

// GET all unique parent groups
router.get('/employment-type-config/groups', authenticateToken, (req, res) => {
  const sql = `SELECT DISTINCT parentGroup FROM employment_type_config ORDER BY parentGroup ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: 'Error fetching groups' });
    res.json(results.map(r => r.parentGroup));
  });
});

// CREATE new employment type config
router.post('/employment-type-config', authenticateToken, requireAdmin, (req, res) => {
  const { parentGroup, typeName, colorHex, sortOrder } = req.body;

  if (!parentGroup || !parentGroup.trim())
    return res.status(400).json({ error: 'Parent group is required' });
  if (!typeName || !typeName.trim())
    return res.status(400).json({ error: 'Type name is required' });
  if (parentGroup.length > 100)
    return res.status(400).json({ error: 'Parent group must not exceed 100 characters' });
  if (typeName.length > 100)
    return res.status(400).json({ error: 'Type name must not exceed 100 characters' });

  const validHex = /^#[0-9A-Fa-f]{6}$/.test(colorHex || '');
  const finalColor = validHex ? colorHex : '#757575';

  const checkSql = `SELECT id FROM employment_type_config WHERE parentGroup = ? AND typeName = ?`;
  db.query(checkSql, [parentGroup.trim(), typeName.trim()], (err, existing) => {
    if (err) return res.status(500).json({ message: 'Error checking duplicate' });
    if (existing.length > 0)
      return res.status(409).json({ error: 'This type already exists under that group' });

    const insertSql = `
      INSERT INTO employment_type_config (parentGroup, typeName, colorHex, sortOrder, isActive)
      VALUES (?, ?, ?, ?, 1)
    `;
    db.query(insertSql, [parentGroup.trim(), typeName.trim(), finalColor, sortOrder || 0], (err, result) => {
      if (err) {
        console.error('Error creating employment type config:', err);
        return res.status(500).json({ message: 'Error creating employment type config' });
      }
      logAudit(req.user, 'create', 'employment_type_config', result.insertId, null);
      res.status(201).json({
        message: 'Employment type created successfully',
        id: result.insertId,
        parentGroup: parentGroup.trim(),
        typeName: typeName.trim(),
        colorHex: finalColor,
        sortOrder: sortOrder || 0,
        isActive: 1,
      });
    });
  });
});

// UPDATE employment type config
router.put('/employment-type-config/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { parentGroup, typeName, colorHex, sortOrder, isActive } = req.body;

  if (!parentGroup || !parentGroup.trim())
    return res.status(400).json({ error: 'Parent group is required' });
  if (!typeName || !typeName.trim())
    return res.status(400).json({ error: 'Type name is required' });

  const validHex = /^#[0-9A-Fa-f]{6}$/.test(colorHex || '');
  const finalColor = validHex ? colorHex : '#757575';

  const checkSql = `SELECT id FROM employment_type_config WHERE parentGroup = ? AND typeName = ? AND id != ?`;
  db.query(checkSql, [parentGroup.trim(), typeName.trim(), id], (err, existing) => {
    if (err) return res.status(500).json({ message: 'Error checking duplicate' });
    if (existing.length > 0)
      return res.status(409).json({ error: 'This type already exists under that group' });

    const updateSql = `
      UPDATE employment_type_config
      SET parentGroup = ?, typeName = ?, colorHex = ?, sortOrder = ?, isActive = ?
      WHERE id = ?
    `;
    db.query(
      updateSql,
      [parentGroup.trim(), typeName.trim(), finalColor, sortOrder !== undefined ? sortOrder : 0, isActive !== undefined ? isActive : 1, id],
      (err, result) => {
        if (err) {
          console.error('Error updating employment type config:', err);
          return res.status(500).json({ message: 'Error updating employment type config' });
        }
        if (result.affectedRows === 0)
          return res.status(404).json({ message: 'Employment type not found' });

        logAudit(req.user, 'update', 'employment_type_config', id, null);
        res.json({
          message: 'Employment type updated successfully',
          id: parseInt(id),
          parentGroup: parentGroup.trim(),
          typeName: typeName.trim(),
          colorHex: finalColor,
          sortOrder: sortOrder || 0,
          isActive: isActive !== undefined ? isActive : 1,
        });
      }
    );
  });
});

// DELETE employment type config
router.delete('/employment-type-config/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  const checkUsageSql = `SELECT COUNT(*) as count FROM employment_category WHERE employmentCategory = ?`;
  db.query(checkUsageSql, [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Error checking usage' });

    const usageCount = results[0].count;
    if (usageCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${usageCount} employee(s) are assigned to this type. Reassign them first.`,
        usageCount,
      });
    }

    const deleteSql = `DELETE FROM employment_type_config WHERE id = ?`;
    db.query(deleteSql, [id], (err, result) => {
      if (err) {
        console.error('Error deleting employment type config:', err);
        return res.status(500).json({ message: 'Error deleting employment type config' });
      }
      if (result.affectedRows === 0)
        return res.status(404).json({ message: 'Employment type not found' });

      logAudit(req.user, 'delete', 'employment_type_config', id, null);
      res.json({ message: 'Employment type deleted successfully', deletedId: parseInt(id) });
    });
  });
});

// ============================================================
// EMPLOYMENT CATEGORY ROUTES
//
// FIX: Removed "AND ec.employmentCategory > 5" from every JOIN.
// That condition incorrectly excluded employment_type_config rows
// whose auto-increment IDs happen to be 1-5, causing those employees
// to fall back to wrong legacy hardcoded labels in the UI.
// The LEFT JOIN alone is sufficient: if no matching type-config row
// exists the join columns are NULL, which is already handled by the
// CASE expression and the frontend fallback.
// ============================================================

// GET ALL - Fetch all employment categories
router.get('/employment-category', authenticateToken, (req, res) => {
  const sql = `
    SELECT
      ec.id,
      ec.employeeNumber,
      ec.employmentCategory,
      ec.customCategory,
      CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS employeeName,
      etc.parentGroup,
      etc.typeName,
      etc.colorHex,
      CASE
        WHEN etc.id IS NOT NULL THEN CONCAT(etc.parentGroup, ' | ', etc.typeName)
        WHEN ec.customCategory IS NOT NULL AND ec.customCategory != '' THEN CONCAT('Other (', ec.customCategory, ')')
        ELSE 'Unassigned'
      END AS categoryLabel
    FROM employment_category ec
    LEFT JOIN person_table pt ON pt.agencyEmployeeNum = ec.employeeNumber
    LEFT JOIN employment_type_config etc
      ON etc.id = ec.employmentCategory
    ORDER BY ec.employeeNumber ASC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Error fetching employment categories:', err);
      return res.status(500).json({ message: 'Error fetching employment categories' });
    }
    // Reference lookup for Earnings/Payroll/DTR badges — not a sensitive record view (avoids audit spam).
    res.json(results);
  });
});

// GET ONE - Fetch employment category by employee number
router.get('/employment-category/:employeeNumber', authenticateToken, (req, res) => {
  const { employeeNumber } = req.params;

  const sql = `
    SELECT
      ec.id,
      ec.employeeNumber,
      ec.employmentCategory,
      ec.customCategory,
      CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS employeeName,
      etc.parentGroup,
      etc.typeName,
      etc.colorHex,
      CASE
        WHEN etc.id IS NOT NULL THEN CONCAT(etc.parentGroup, ' | ', etc.typeName)
        WHEN ec.customCategory IS NOT NULL AND ec.customCategory != '' THEN CONCAT('Other (', ec.customCategory, ')')
        ELSE 'Unassigned'
      END AS categoryLabel
    FROM employment_category ec
    LEFT JOIN person_table pt ON pt.agencyEmployeeNum = ec.employeeNumber
    LEFT JOIN employment_type_config etc
      ON etc.id = ec.employmentCategory
    WHERE ec.employeeNumber = ?
  `;

  db.query(sql, [employeeNumber], (err, results) => {
    if (err) {
      console.error('Error fetching employment category:', err);
      return res.status(500).json({ message: 'Error fetching employment category' });
    }
    if (results.length === 0)
      return res.status(404).json({ message: 'Employment category not found' });

    // An employee reading their own category (DTR badge on every DTR load) is
    // not a record view worth auditing; each audit row is also broadcast to all
    // admins. Viewing someone else's record is still audited.
    if (!employeeNumbersMatch(req.user?.employeeNumber, employeeNumber)) {
      logAudit(req.user, 'view', 'employment_category', results[0].id, employeeNumber);
    }
    res.json(results[0]);
  });
});

// SEARCH
router.get('/employment-category/search/:searchTerm', authenticateToken, (req, res) => {
  const { searchTerm } = req.params;

  if (!searchTerm || searchTerm.trim() === '')
    return res.status(400).json({ error: 'Search term is required' });

  const sql = `
    SELECT
      ec.id,
      ec.employeeNumber,
      ec.employmentCategory,
      ec.customCategory,
      CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS employeeName,
      etc.parentGroup,
      etc.typeName,
      etc.colorHex,
      CASE
        WHEN etc.id IS NOT NULL THEN CONCAT(etc.parentGroup, ' | ', etc.typeName)
        WHEN ec.customCategory IS NOT NULL AND ec.customCategory != '' THEN CONCAT('Other (', ec.customCategory, ')')
        ELSE 'Unassigned'
      END AS categoryLabel
    FROM employment_category ec
    LEFT JOIN person_table pt ON pt.agencyEmployeeNum = ec.employeeNumber
    LEFT JOIN employment_type_config etc
      ON etc.id = ec.employmentCategory
    WHERE ec.employeeNumber LIKE ?
       OR pt.lastName LIKE ?
       OR pt.firstName LIKE ?
       OR pt.middleName LIKE ?
       OR CONCAT(pt.firstName, ' ', pt.lastName) LIKE ?
       OR CONCAT(pt.lastName, ' ', pt.firstName) LIKE ?
       OR etc.typeName LIKE ?
       OR etc.parentGroup LIKE ?
    ORDER BY ec.employeeNumber ASC
  `;

  const searchPattern = `%${searchTerm}%`;
  db.query(
    sql,
    [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern],
    (err, results) => {
      if (err) {
        console.error('Error searching employment categories:', err);
        return res.status(500).json({ message: 'Error searching employment categories' });
      }
      logAudit(req.user, 'search', 'employment_category', null, searchTerm);
      res.json(results);
    }
  );
});

// CREATE - Add new employment category
router.post('/employment-category', authenticateToken, requireAdmin, (req, res) => {
  const { employeeNumber, employmentCategory } = req.body;

  if (!employeeNumber)
    return res.status(400).json({ error: 'Employee number is required' });
  if (!employmentCategory || isNaN(employmentCategory))
    return res.status(400).json({ error: 'Employment category type is required' });

  // Verify the type config exists and is active
  const checkTypeSql = `SELECT id FROM employment_type_config WHERE id = ? AND isActive = 1`;
  db.query(checkTypeSql, [employmentCategory], (err, typeResults) => {
    if (err) return res.status(500).json({ message: 'Error checking employment type' });
    if (typeResults.length === 0)
      return res.status(404).json({ error: 'Employment type not found or inactive' });

    const checkEmployeeSql = `SELECT agencyEmployeeNum FROM person_table WHERE agencyEmployeeNum = ?`;
    db.query(checkEmployeeSql, [employeeNumber], (err, empResults) => {
      if (err) return res.status(500).json({ message: 'Error checking employee' });
      if (empResults.length === 0)
        return res.status(404).json({ error: 'Employee not found' });

      const checkSql = `SELECT id FROM employment_category WHERE employeeNumber = ?`;
      db.query(checkSql, [employeeNumber], (err, existing) => {
        if (err) return res.status(500).json({ message: 'Error checking existing record' });
        if (existing.length > 0)
          return res.status(409).json({ error: 'Employment category already exists for this employee' });

        const insertSql = `
          INSERT INTO employment_category (employeeNumber, employmentCategory, customCategory)
          VALUES (?, ?, NULL)
        `;
        db.query(insertSql, [employeeNumber, employmentCategory], (err, result) => {
          if (err) {
            console.error('Error creating employment category:', err);
            return res.status(500).json({ message: 'Error creating employment category' });
          }

          const updateUsersSql = `UPDATE users SET employmentCategory = ?, customCategory = NULL WHERE employeeNumber = ?`;
          db.query(updateUsersSql, [employmentCategory, employeeNumber], (updateErr) => {
            if (updateErr) console.error('Error updating users table:', updateErr);
          });

          logAudit(req.user, 'create', 'employment_category', result.insertId, employeeNumber);
          res.status(201).json({
            message: 'Employment category created successfully',
            id: result.insertId,
            employeeNumber,
            employmentCategory,
          });
        });
      });
    });
  });
});

// UPDATE - Update employment category
router.put('/employment-category/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { employeeNumber, employmentCategory } = req.body;

  if (!employeeNumber)
    return res.status(400).json({ error: 'Employee number is required' });
  if (!employmentCategory || isNaN(employmentCategory))
    return res.status(400).json({ error: 'Employment category type is required' });

  // Verify the type config exists and is active
  const checkTypeSql = `SELECT id FROM employment_type_config WHERE id = ? AND isActive = 1`;
  db.query(checkTypeSql, [employmentCategory], (err, typeResults) => {
    if (err) return res.status(500).json({ message: 'Error checking employment type' });
    if (typeResults.length === 0)
      return res.status(404).json({ error: 'Employment type not found or inactive' });

    const checkSql = `SELECT employeeNumber FROM employment_category WHERE id = ?`;
    db.query(checkSql, [id], (err, results) => {
      if (err) return res.status(500).json({ message: 'Error checking record' });
      if (results.length === 0)
        return res.status(404).json({ message: 'Employment category not found' });

      const oldEmployeeNumber = results[0].employeeNumber;

      const performUpdate = () => {
        const updateSql = `
          UPDATE employment_category
          SET employeeNumber = ?, employmentCategory = ?, customCategory = NULL
          WHERE id = ?
        `;
        db.query(updateSql, [employeeNumber, employmentCategory, id], (err, result) => {
          if (err) {
            console.error('Error updating employment category:', err);
            return res.status(500).json({ message: 'Error updating employment category' });
          }
          if (result.affectedRows === 0)
            return res.status(404).json({ message: 'Employment category not found' });

          const updateUsersSql = `UPDATE users SET employmentCategory = ?, customCategory = NULL WHERE employeeNumber = ?`;
          db.query(updateUsersSql, [employmentCategory, employeeNumber], (updateErr) => {
            if (updateErr) console.error('Error updating users table:', updateErr);
          });

          logAudit(req.user, 'update', 'employment_category', id, employeeNumber);
          res.json({
            message: 'Employment category updated successfully',
            id,
            employeeNumber,
            employmentCategory,
          });
        });
      };

      if (oldEmployeeNumber !== employeeNumber) {
        const dupSql = `SELECT id FROM employment_category WHERE employeeNumber = ? AND id != ?`;
        db.query(dupSql, [employeeNumber, id], (err, dupResults) => {
          if (err) return res.status(500).json({ message: 'Error checking duplicate' });
          if (dupResults.length > 0)
            return res.status(409).json({ error: 'Employment category already exists for this employee' });
          performUpdate();
        });
      } else {
        performUpdate();
      }
    });
  });
});

// POST /employee-category — alias used by UsersList create/edit path (upsert)
router.post('/employee-category', authenticateToken, requireAdmin, (req, res) => {
  const { employeeNumber, employmentCategory } = req.body;

  if (!employeeNumber)
    return res.status(400).json({ error: 'Employee number is required' });
  if (!employmentCategory || isNaN(employmentCategory))
    return res.status(400).json({ error: 'Employment category type is required' });

  const checkTypeSql = `SELECT id FROM employment_type_config WHERE id = ? AND isActive = 1`;
  db.query(checkTypeSql, [employmentCategory], (err, typeResults) => {
    if (err) return res.status(500).json({ message: 'Error checking employment type' });
    if (typeResults.length === 0)
      return res.status(404).json({ error: 'Employment type not found or inactive' });

    // Upsert — update if exists, otherwise insert
    const checkSql = `SELECT id FROM employment_category WHERE employeeNumber = ?`;
    db.query(checkSql, [employeeNumber], (err, existing) => {
      if (err) return res.status(500).json({ message: 'Error checking existing record' });

      if (existing.length > 0) {
        const updateSql = `
          UPDATE employment_category
          SET employmentCategory = ?, customCategory = NULL
          WHERE employeeNumber = ?
        `;
        db.query(updateSql, [employmentCategory, employeeNumber], (err) => {
          if (err) return res.status(500).json({ message: 'Error updating employment category' });

          const updateUsersSql = `UPDATE users SET employmentCategory = ?, customCategory = NULL WHERE employeeNumber = ?`;
          db.query(updateUsersSql, [employmentCategory, employeeNumber], (updateErr) => {
            if (updateErr) console.error('Error updating users table:', updateErr);
          });

          logAudit(req.user, 'update', 'employment_category', existing[0].id, employeeNumber);
          res.json({ message: 'Employment category updated successfully', employeeNumber, employmentCategory });
        });
      } else {
        const insertSql = `
          INSERT INTO employment_category (employeeNumber, employmentCategory, customCategory)
          VALUES (?, ?, NULL)
        `;
        db.query(insertSql, [employeeNumber, employmentCategory], (err, result) => {
          if (err) return res.status(500).json({ message: 'Error creating employment category' });

          const updateUsersSql = `UPDATE users SET employmentCategory = ?, customCategory = NULL WHERE employeeNumber = ?`;
          db.query(updateUsersSql, [employmentCategory, employeeNumber], (updateErr) => {
            if (updateErr) console.error('Error updating users table:', updateErr);
          });

          logAudit(req.user, 'create', 'employment_category', result.insertId, employeeNumber);
          res.status(201).json({
            message: 'Employment category created successfully',
            id: result.insertId,
            employeeNumber,
            employmentCategory,
          });
        });
      }
    });
  });
});

// DELETE - Delete employment category
router.delete('/employment-category/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id))
    return res.status(400).json({ error: 'Invalid ID provided' });

  const getEmployeeNumberSql = `SELECT employeeNumber FROM employment_category WHERE id = ?`;
  db.query(getEmployeeNumberSql, [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Error fetching record' });
    if (results.length === 0)
      return res.status(404).json({ message: 'Employment category not found' });

    const employeeNumber = results[0].employeeNumber;

    const deleteSql = `DELETE FROM employment_category WHERE id = ?`;
    db.query(deleteSql, [id], (err, result) => {
      if (err) {
        console.error('Error deleting employment category:', err);
        return res.status(500).json({ message: 'Error deleting employment category' });
      }
      if (result.affectedRows === 0)
        return res.status(404).json({ message: 'Employment category not found' });

      const updateUsersSql = `UPDATE users SET employmentCategory = NULL, customCategory = NULL WHERE employeeNumber = ?`;
      db.query(updateUsersSql, [employeeNumber], (updateErr) => {
        if (updateErr) console.error('Error updating users table:', updateErr);
      });

      logAudit(req.user, 'delete', 'employment_category', id, employeeNumber);
      res.json({
        message: 'Employment category deleted successfully',
        deletedId: id,
        employeeNumber,
      });
    });
  });
});

// ============================================================
// ATTENDANCE DEDUCTION POLICY (per employment_type_config.id)
// Table: employment_category_deduction_types
// ============================================================

const DEDUCTION_CONTEXTS = ['ABSENCE', 'HALF_DAY', 'TARDINESS'];

router.get(
  '/employment-category-deduction-types/:employmentCategoryId',
  authenticateToken,
  (req, res) => {
    const id = parseInt(req.params.employmentCategoryId, 10);
    if (!Number.isFinite(id) || id < 1)
      return res.status(400).json({ error: 'Invalid employment category id' });

    db.query(
      'SELECT id FROM employment_type_config WHERE id = ? LIMIT 1',
      [id],
      (e1, etcRows) => {
        if (e1) {
          console.error('employment-category-deduction-types type check:', e1);
          return res.status(500).json({ message: 'Database error' });
        }
        if (!etcRows.length)
          return res.status(404).json({ error: 'Employment type not found' });

        const sql = `
          SELECT ecdt.id,
                 ecdt.leave_type_id,
                 ecdt.deduction_context,
                 lt.leave_code,
                 lt.leave_description
          FROM employment_category_deduction_types ecdt
          INNER JOIN leave_table lt ON lt.id = ecdt.leave_type_id
          WHERE ecdt.employment_category_id = ?
          ORDER BY ecdt.deduction_context ASC, lt.leave_code ASC
        `;
        db.query(sql, [id], (err, rows) => {
          if (err) {
            console.error('employment-category-deduction-types:', err);
            if (err.code === 'ER_NO_SUCH_TABLE')
              return res.status(503).json({
                error:
                  'Table employment_category_deduction_types is missing. Run the migration SQL to create it.',
              });
            return res.status(500).json({ message: 'Error fetching deduction policy' });
          }
          const byContext = { ABSENCE: [], HALF_DAY: [], TARDINESS: [] };
          for (const r of rows || []) {
            const c = String(r.deduction_context || '').toUpperCase();
            if (byContext[c] && !byContext[c].includes(r.leave_type_id))
              byContext[c].push(r.leave_type_id);
          }
          res.json({
            employment_category_id: id,
            rows: rows || [],
            byContext,
          });
        });
      },
    );
  },
);

router.put(
  '/employment-category-deduction-types/:employmentCategoryId',
  authenticateToken,
  requireAdmin,
  (req, res) => {
    const id = parseInt(req.params.employmentCategoryId, 10);
    if (!Number.isFinite(id) || id < 1)
      return res.status(400).json({ error: 'Invalid employment category id' });

    const body = req.body || {};
    const seen = new Set();
    const tuples = [];
    for (const ctx of DEDUCTION_CONTEXTS) {
      const arr = Array.isArray(body[ctx]) ? body[ctx] : [];
      for (const raw of arr) {
        const tid = parseInt(raw, 10);
        if (!Number.isFinite(tid) || tid < 1) continue;
        const k = `${ctx}:${tid}`;
        if (seen.has(k)) continue;
        seen.add(k);
        tuples.push([id, tid, ctx]);
      }
    }

    db.query(
      'SELECT id FROM employment_type_config WHERE id = ? LIMIT 1',
      [id],
      (e1, etcRows) => {
        if (e1) {
          console.error('employment-category-deduction-types put type check:', e1);
          return res.status(500).json({ message: 'Database error' });
        }
        if (!etcRows.length)
          return res.status(404).json({ error: 'Employment type not found' });

        db.query(
          'DELETE FROM employment_category_deduction_types WHERE employment_category_id = ?',
          [id],
          (delErr) => {
            if (delErr) {
              console.error('employment-category-deduction-types delete:', delErr);
              if (delErr.code === 'ER_NO_SUCH_TABLE')
                return res.status(503).json({
                  error:
                    'Table employment_category_deduction_types is missing. Run the migration SQL to create it.',
                });
              return res.status(500).json({ message: 'Error clearing policy' });
            }

            if (tuples.length === 0) {
              logAudit(
                req.user,
                'update',
                'employment_category_deduction_types',
                id,
                null,
              );
              return res.json({
                message: 'Policy saved (no leave types selected)',
                employment_category_id: id,
                inserted: 0,
              });
            }

            const placeholders = tuples.map(() => '(?,?,?)').join(',');
            const flat = tuples.flat();
            const ins = `INSERT INTO employment_category_deduction_types (employment_category_id, leave_type_id, deduction_context) VALUES ${placeholders}`;
            db.query(ins, flat, (insErr) => {
              if (insErr) {
                console.error('employment-category-deduction-types insert:', insErr);
                if (
                  insErr.code === 'ER_NO_REFERENCED_ROW_2' ||
                  insErr.code === 'ER_NO_REFERENCED_ROW'
                )
                  return res.status(400).json({
                    error: 'Invalid leave_type_id — use ids from the Leave Types table.',
                  });
                return res.status(500).json({ message: 'Error saving policy' });
              }
              logAudit(
                req.user,
                'update',
                'employment_category_deduction_types',
                id,
                null,
              );
              res.json({
                message: 'Deduction policy saved',
                employment_category_id: id,
                inserted: tuples.length,
              });
            });
          },
        );
      },
    );
  },
);

module.exports = router;