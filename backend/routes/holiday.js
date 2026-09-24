const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { upload } = require('../middleware/upload');
const { broadcastToRoles, notifyMultipleUsers } = require('../socket/socketService');
const { notifyPayrollChanged } = require('../socket/socketService');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { insertNotificationsBulk } = require('../utils/notificationFanout');
const { parseBranchField } = require('../utils/branchScope');

function notifyEmployeesForHoliday(holidayId, branch, notificationDescription, res) {
  const finishOk = () => {
    if (!res.headersSent) {
      res.status(201).json({ message: 'Holiday record added successfully', id: holidayId });
    }
  };

  let userSql;
  let userParams = [];
  if (branch === null) {
    userSql = `SELECT DISTINCT employeeNumber FROM users WHERE employeeNumber IS NOT NULL AND employeeNumber != ""
       UNION
       SELECT DISTINCT agencyEmployeeNum AS employeeNumber FROM person_table WHERE agencyEmployeeNum IS NOT NULL AND agencyEmployeeNum != ""`;
  } else {
    userSql = `SELECT DISTINCT employeeNumber FROM users
      WHERE employeeNumber IS NOT NULL AND employeeNumber != "" AND branch = ?`;
    userParams = [branch];
  }

  db.query(userSql, userParams, (userErr, users) => {
    if (userErr) {
      console.error('Error fetching users for holiday notifications:', userErr.message);
      return finishOk();
    }
    const employeeNumbers = Array.from(
      new Set(
        (users || [])
          .map((u) => String(u.employeeNumber || '').trim())
          .filter(Boolean),
      ),
    );
    if (employeeNumbers.length === 0) return finishOk();
    insertNotificationsBulk(employeeNumbers, {
      description: notificationDescription,
      type: 'holiday',
      actionLink: `/holiday/${holidayId}`,
    })
      .then(() => {
        notifyMultipleUsers(employeeNumbers, 'notificationCreated', {
          notification_type: 'holiday',
          description: notificationDescription,
        });
      })
      .catch((e) => console.error('Holiday notification insert error:', e));
    finishOk();
  });
}

// GET all holiday records — always 200 + array (DB errors or missing table → [])
router.get('/holiday', (req, res) => {
  const send = (data) => {
    if (!res.headersSent) res.status(200).json(data);
  };

  const queryHolidays = () => {
    db.query('SELECT * FROM holiday', (err, result) => {
      if (err) {
        console.error('Holiday GET Database Error:', err.message);
        return send([]);
      }
      try {
        const rows = Array.isArray(result) ? result : [];
        const normalized = rows.map((row) => ({
          id: row.id,
          title: row.title != null ? row.title : row.description,
          about: row.about != null ? row.about : '',
          date_start: row.date_start != null ? row.date_start : row.date,
          date_end: row.date_end != null ? row.date_end : row.date,
          description: row.description,
          date: row.date,
          status: row.status,
          image: row.image,
          branch: row.branch !== null && row.branch !== undefined ? Number(row.branch) : null,
        }));
        send(normalized);
      } catch (e) {
        console.error('Holiday GET normalize error:', e.message);
        send([]);
      }
    });
  };

  try {
    if (db && typeof db.query === 'function') {
      queryHolidays();
    } else {
      send([]);
    }
  } catch (e) {
    console.error('Holiday GET error:', e.message);
    send([]);
  }
});

// POST: Create holiday record (Title, About, Date Range, branch scope)
router.post('/holiday', authenticateToken, requireAdmin, upload.single('image'), (req, res) => {
  const { title, about, date_start, date_end, status } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const branch = parseBranchField(req.body.branch);

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const sql = `INSERT INTO holiday (title, about, date_start, date_end, description, date, status, image, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.query(
    sql,
    [title, about || null, date_start || null, date_end || null, title, date_start || date_end, status || 'Active', image, branch],
    (err, result) => {
      if (err) {
        console.error('Database Insert Error:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      const holidayId = result.insertId;
      const notificationDescription = 'New holiday has been scheduled. Click to see details.';

      notifyPayrollChanged('created', {
        module: 'holiday',
        holidayId,
      });

      broadcastToRoles(
        ['administrator', 'superadmin', 'technical'],
        'adminDashboardUpdated',
        { source: 'holiday', action: 'created', holidayId },
      );

      notifyEmployeesForHoliday(holidayId, branch, notificationDescription, res);
    },
  );
});

// PUT: Update holiday record (Title, About, Date Range, optional image, branch)
router.put('/holiday/:id', authenticateToken, requireAdmin, upload.single('image'), (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const { title, about, date_start, date_end, status } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const branch = parseBranchField(req.body.branch);

  let sql, params;
  if (image) {
    sql = `UPDATE holiday SET title = ?, about = ?, date_start = ?, date_end = ?, description = ?, date = ?, status = ?, image = ?, branch = ? WHERE id = ?`;
    params = [title, about || null, date_start || null, date_end || null, title, date_start || date_end, status || 'Active', image, branch, id];
  } else {
    sql = `UPDATE holiday SET title = ?, about = ?, date_start = ?, date_end = ?, description = ?, date = ?, status = ?, branch = ? WHERE id = ?`;
    params = [title, about || null, date_start || null, date_end || null, title, date_start || date_end, status || 'Active', branch, id];
  }

  db.query(sql, params, (err, result) => {
    if (err) {
      console.error('Database Update Error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Hol record not found' });
    }

    notifyPayrollChanged('updated', { module: 'holiday', holidayId: id });

    broadcastToRoles(
      ['administrator', 'superadmin', 'technical'],
      'adminDashboardUpdated',
      { source: 'holiday', action: 'updated', holidayId: id },
    );

    res.json({ message: 'Hol record updated successfully' });
  });
});

// DELETE: Delete holiday record (and image file if present)
router.delete('/holiday/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const getQuery = 'SELECT image FROM holiday WHERE id = ?';
  db.query(getQuery, [id], (err, rows) => {
    if (err) {
      console.error('Database Query Error:', err.message);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Holiday record not found' });
    }

    const imagePath = rows[0].image;
    if (imagePath) {
      const fullPath = path.join(__dirname, '..', imagePath);
      fs.unlink(fullPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting holiday image:', unlinkErr);
      });
    }

    const sql = `DELETE FROM holiday WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('Database Delete Error:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Holiday record not found' });
      }

      notifyPayrollChanged('deleted', { module: 'holiday', holidayId: id });

      broadcastToRoles(
        ['administrator', 'superadmin', 'technical'],
        'adminDashboardUpdated',
        { source: 'holiday', action: 'deleted', holidayId: id },
      );

      res.json({ message: 'Holiday record deleted successfully' });
    });
  });
});

module.exports = router;
