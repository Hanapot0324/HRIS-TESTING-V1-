const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, logAudit, requireAdmin } = require('../middleware/auth');

// Mounted at '/' in index.js: scope the guard to this router's own paths so it
// does not run on (and reject) every other request that passes through.
router.use('/api/salary-grade-status', authenticateToken, requireAdmin);

// GET all salary grade status records
router.get('/api/salary-grade-status', (req, res) => {
  db.query('SELECT * FROM salary_grade_status', (err, result) => {
    if (err) res.status(500).send(err);
    else {
      try {
        logAudit(req.user, 'View', 'salary_grade_status', null, null);
      } catch (e) {
        console.error('Audit log error:', e);
      }
      res.json(result);
    }
  });
});

// POST: Add a new record
router.post('/api/salary-grade-status', (req, res) => {
  const { effectivityDate, step_number, status } = req.body;

  const sql = `
    INSERT INTO salary_grade_status (effectivityDate, step_number, status)
    VALUES (?, ?, ?)
  `;

  db.query(sql, [effectivityDate, step_number, status], (err, result) => {
    if (err) res.status(500).send(err);
    else {
      try {
        logAudit(
          req.user,
          'Insert',
          'salary_grade_status',
          result.insertId,
          null
        );
      } catch (e) {
        console.error('Audit log error:', e);
      }
      res.json({ message: 'Record added successfully', id: result.insertId });
    }
  });
});

// PUT: Update a record
router.put('/api/salary-grade-status/:id', (req, res) => {
  const { id } = req.params;
  const { effectivityDate, step_number, status } = req.body;

  const sql = `
    UPDATE salary_grade_status
    SET effectivityDate = ?, step_number = ?, status = ?
    WHERE id = ?
  `;

  db.query(sql, [effectivityDate, step_number, status, id], (err) => {
    if (err) res.status(500).send(err);
    else {
      try {
        logAudit(req.user, 'Update', 'salary_grade_status', id, null);
      } catch (e) {
        console.error('Audit log error:', e);
      }
      res.json({ message: 'Record updated successfully' });
    }
  });
});

// DELETE: Delete a record
router.delete('/api/salary-grade-status/:id', (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM salary_grade_status WHERE id = ?', [id], (err) => {
    if (err) res.status(500).send(err);
    else {
      try {
        logAudit(req.user, 'Delete', 'salary_grade_status', id, null);
      } catch (e) {
        console.error('Audit log error:', e);
      }
      res.json({ message: 'Record deleted successfully' });
    }
  });
});

module.exports = router;




