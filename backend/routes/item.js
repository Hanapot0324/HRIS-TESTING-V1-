const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, logAudit, requireAdmin } = require('../middleware/auth');
const { notifyPayrollChanged } = require('../socket/socketService');

// Mounted at '/' in index.js: scope the guard to this router's own paths so it
// does not run on (and reject) every other request that passes through.
router.use('/api/item-table', authenticateToken, requireAdmin);
const {
  fillExemptAttendanceForEmployeeOfficialRanges,
} = require('../services/autoAttendanceService');

async function triggerExemptAutoFill(employeeID) {
  if (!employeeID || !String(employeeID).trim()) {
    return {
      inserted: 0,
      skipped: 0,
      errors: ['Auto-attendance skipped: employeeID is missing.'],
    };
  }
  return fillExemptAttendanceForEmployeeOfficialRanges(
    String(employeeID).trim(),
  );
}

// GET all item table records
router.get('/api/item-table', (req, res) => {
  const sql = `
    SELECT 
      id, 
      COALESCE(item_description, '') as item_description, 
      COALESCE(employeeID, '') as employeeID, 
      COALESCE(name, '') as name, 
      COALESCE(item_code, '') as item_code, 
      COALESCE(salary_grade, '') as salary_grade, 
      COALESCE(step, '') as step, 
      COALESCE(effectivityDate, '') as effectivityDate,
      exempt_from_biometrics,
      dateCreated
    FROM item_table
    ORDER BY dateCreated DESC
  `;
  db.query(sql, (err, result) => {
    if (err) {
      console.error('Database Query Error:', err.message);
      console.error('SQL Error Code:', err.code);
      console.error('SQL Error SQL State:', err.sqlState);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
        details: 'Failed to fetch item records',
      });
    }

    console.log('=== ITEM TABLE FETCH DEBUG ===');
    console.log('Total records found:', result.length);
    if (result.length > 0) {
      console.log('Sample record:', {
        id: result[0].id,
        employeeID: result[0].employeeID,
        name: result[0].name,
        item_description: result[0].item_description,
        salary_grade: result[0].salary_grade,
        step: result[0].step,
        exempt_from_biometrics: result[0].exempt_from_biometrics,
      });
      const nullFields = result.filter(
        (r) =>
          r.employeeID === null ||
          r.name === null ||
          r.item_description === null,
      );
      if (nullFields.length > 0) {
        console.log('Records with NULL values:', nullFields.length);
        console.log('Sample NULL record:', nullFields[0]);
      }
    } else {
      console.log('No records found in item_table');
    }
    console.log('==============================');

    res.json(result);
  });
});

// POST: Add new item
router.post('/api/item-table', (req, res) => {
  const {
    item_description,
    employeeID,
    name,
    item_code,
    salary_grade,
    step,
    effectivityDate,
    exempt_from_biometrics,
  } = req.body;

  const normalizedData = {
    item_description: item_description || null,
    employeeID: employeeID || null,
    name: name || null,
    item_code: item_code || null,
    salary_grade:
      salary_grade !== null && salary_grade !== undefined ? salary_grade : '',
    step: step || null,
    effectivityDate: effectivityDate || null,
    exempt_from_biometrics: exempt_from_biometrics ? 1 : 0,
  };

  console.log('Inserting item data:', normalizedData);

  const sql = `
    INSERT INTO item_table (
      item_description, employeeID, name, item_code,
      salary_grade, step, effectivityDate, exempt_from_biometrics
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  db.query(
    sql,
    [
      normalizedData.item_description,
      normalizedData.employeeID,
      normalizedData.name,
      normalizedData.item_code,
      normalizedData.salary_grade,
      normalizedData.step,
      normalizedData.effectivityDate,
      normalizedData.exempt_from_biometrics,
    ],
    (err, result) => {
      if (err) {
        console.error('Database Insert Error:', err.message);
        console.error('SQL Error Code:', err.code);
        console.error('SQL Error SQL State:', err.sqlState);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: err.message,
          details:
            'Failed to insert item record. Please check the data and try again.',
        });
      }

      try {
        logAudit(req.user, 'Insert', 'item_table', result.insertId, employeeID);
      } catch (e) {
        console.error('Audit log error:', e);
      }

      notifyPayrollChanged('created', {
        module: 'item-table',
        id: result.insertId,
        employeeID,
      });

      const finalize = (autoResult) =>
        res.json({
          message: 'Item record added successfully',
          id: result.insertId,
          autoAttendance: autoResult
            ? {
                inserted: autoResult.inserted,
                skipped: autoResult.skipped,
                rangesProcessed: autoResult.rangesProcessed,
              }
            : undefined,
          warnings:
            autoResult && autoResult.errors && autoResult.errors.length
              ? autoResult.errors
              : undefined,
        });

      if (
        normalizedData.exempt_from_biometrics === 1 &&
        normalizedData.employeeID
      ) {
        triggerExemptAutoFill(normalizedData.employeeID)
          .then(finalize)
          .catch((autoErr) =>
            finalize({
              inserted: 0,
              skipped: 0,
              rangesProcessed: 0,
              errors: [`Auto-attendance trigger failed: ${autoErr.message}`],
            }),
          );
        return;
      }

      finalize(null);
    },
  );
});

// PUT: Update item
router.put('/api/item-table/:id', (req, res) => {
  const { id } = req.params;
  const {
    item_description,
    employeeID,
    name,
    item_code,
    salary_grade,
    step,
    effectivityDate,
    exempt_from_biometrics,
  } = req.body;

  const normalizedData = {
    item_description: item_description || null,
    employeeID: employeeID || null,
    name: name || null,
    item_code: item_code || null,
    salary_grade:
      salary_grade !== null && salary_grade !== undefined ? salary_grade : '',
    step: step || null,
    effectivityDate: effectivityDate || null,
    exempt_from_biometrics: exempt_from_biometrics ? 1 : 0,
  };

  console.log('Updating item data for ID:', id, normalizedData);

  db.query(
    'SELECT employeeID, exempt_from_biometrics FROM item_table WHERE id = ? LIMIT 1',
    [id],
    (preErr, preRows) => {
      if (preErr) {
        console.error('Database Read Error:', preErr.message);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: preErr.message,
          details: 'Failed to read existing item record before update.',
        });
      }

      if (!preRows || preRows.length === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }

      const previous = preRows[0];

      const sql = `
        UPDATE item_table SET
          item_description = ?,
          employeeID = ?,
          name = ?,
          item_code = ?,
          salary_grade = ?,
          step = ?,
          effectivityDate = ?,
          exempt_from_biometrics = ?
        WHERE id = ?
      `;

      db.query(
        sql,
        [
          normalizedData.item_description,
          normalizedData.employeeID,
          normalizedData.name,
          normalizedData.item_code,
          normalizedData.salary_grade,
          normalizedData.step,
          normalizedData.effectivityDate,
          normalizedData.exempt_from_biometrics,
          id,
        ],
        (err, result) => {
          if (err) {
            console.error('Database Update Error:', err.message);
            console.error('SQL Error Code:', err.code);
            console.error('SQL Error SQL State:', err.sqlState);
            return res.status(500).json({
              error: 'Internal Server Error',
              message: err.message,
              details:
                'Failed to update item record. Please check the data and try again.',
            });
          }
          if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item not found' });
          }

          try {
            logAudit(req.user, 'Update', 'item_table', id, employeeID);
          } catch (e) {
            console.error('Audit log error:', e);
          }

          notifyPayrollChanged('updated', {
            module: 'item-table',
            id,
            employeeID,
          });

          const wasExempt = Number(previous.exempt_from_biometrics) === 1;
          const isExempt = normalizedData.exempt_from_biometrics === 1;
          const targetEmployeeID =
            normalizedData.employeeID || previous.employeeID;
          const becameExempt = !wasExempt && isExempt && targetEmployeeID;

          const finalize = (autoResult) =>
            res.json({
              message: 'Item record updated successfully',
              autoAttendance: autoResult
                ? {
                    inserted: autoResult.inserted,
                    skipped: autoResult.skipped,
                    rangesProcessed: autoResult.rangesProcessed,
                  }
                : undefined,
              warnings:
                autoResult && autoResult.errors && autoResult.errors.length
                  ? autoResult.errors
                  : undefined,
            });

          if (becameExempt) {
            triggerExemptAutoFill(targetEmployeeID)
              .then(finalize)
              .catch((autoErr) =>
                finalize({
                  inserted: 0,
                  skipped: 0,
                  rangesProcessed: 0,
                  errors: [
                    `Auto-attendance trigger failed: ${autoErr.message}`,
                  ],
                }),
              );
            return;
          }

          finalize(null);
        },
      );
    },
  );
});

// DELETE: Delete item
router.delete('/api/item-table/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM item_table WHERE id = ?', [id], (err, result) => {
    if (err) {
      console.error('Database Delete Error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    try {
      logAudit(req.user, 'Delete', 'item_table', id, null);
    } catch (e) {
      console.error('Audit log error:', e);
    }

    notifyPayrollChanged('deleted', { module: 'item-table', id });

    res.json({ message: 'Item record deleted successfully' });
  });
});

module.exports = router;
