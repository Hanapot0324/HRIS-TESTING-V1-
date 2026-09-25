const express = require('express');
const router = express.Router();
const db = require('../db');
const { upload } = require('../middleware/upload');
const path = require('path');
const fs = require('fs');
const {
  broadcastToRoles,
  notifyMultipleUsers,
  notifyAnnouncementChanged,
} = require('../socket/socketService');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { insertNotificationsBulk } = require('../utils/notificationFanout');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Parse the flexi fields coming from a multipart/form-data body.
 * Returns { is_flexi, flexi_hours, flexi_custom_time }
 *
 *  is_flexi          – boolean  (checkbox / "true" string)
 *  flexi_hours       – number   (e.g. 2, 1.5) – how many hours of grace
 *  flexi_custom_time – "HH:MM"  – explicit override instead of computed time
 */
function parseFlexiFields(body) {
  const is_flexi = body.is_flexi === true || body.is_flexi === 'true' || body.is_flexi === '1' ? 1 : 0;
  const hr_only  = body.hr_only  === true || body.hr_only  === 'true' || body.hr_only  === '1' ? 1 : 0;

  let flexi_hours = null;
  if (is_flexi && body.flexi_hours !== undefined && body.flexi_hours !== '') {
    const parsed = parseFloat(body.flexi_hours);
    flexi_hours = isNaN(parsed) ? 2.0 : parsed;
  }

  let flexi_custom_time = null;
  if (is_flexi && body.flexi_custom_time && body.flexi_custom_time.trim() !== '') {
    // Accept "HH:MM" or "HH:MM:SS" – store as "HH:MM:SS"
    const t = body.flexi_custom_time.trim();
    flexi_custom_time = t.length === 5 ? `${t}:00` : t;
  }

  return { hr_only, is_flexi, flexi_hours, flexi_custom_time };
}

// ─────────────────────────────────────────────────────────────
// GET /api/announcements
// Supports optional query param: ?audience=hr  (filter HR-only)
// ─────────────────────────────────────────────────────────────
router.get('/api/announcements', (req, res) => {
  const { audience } = req.query; // "hr" | "all" | undefined

  let whereClause = '';
  const params = [];

  if (audience === 'employee') {
    // Employee-facing feed: exclude HR-only items
    whereClause = 'WHERE hr_only = 0';
  } else if (audience === 'hr') {
    whereClause = 'WHERE hr_only = 1';
  }
  // "all" or undefined → no filter (admin view)

  const query = `
    SELECT
      id,
      title,
      about,
      COALESCE(date_start, date) AS date_start,
      COALESCE(date_end,   date) AS date_end,
      date,
      image,
      hr_only,
      is_flexi,
      flexi_hours,
      flexi_custom_time
    FROM announcements
    ${whereClause}
    ORDER BY COALESCE(date_start, date) DESC
  `;

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching announcements:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json(results);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/announcements  – Create
// ─────────────────────────────────────────────────────────────
router.post('/api/announcements', authenticateToken, requireAdmin, upload.single('image'), (req, res) => {
  const { title, about, date_start, date_end } = req.body;
  const { hr_only, is_flexi, flexi_hours, flexi_custom_time } = parseFlexiFields(req.body);

  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const date  = date_start || date_end || null;

  const query = `
    INSERT INTO announcements
      (title, about, date, date_start, date_end, image,
       hr_only, is_flexi, flexi_hours, flexi_custom_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [title, about, date, date_start || null, date_end || null, image,
     hr_only, is_flexi, flexi_hours, flexi_custom_time],
    (err, result) => {
      if (err) {
        console.error('Error creating announcement:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const announcementId = result.insertId;
      const notificationDescription = `New announcement has been posted. Click to see details.`;

      // Fetch full row and broadcast
      db.query('SELECT * FROM announcements WHERE id = ?', [announcementId], (fetchErr, rows) => {
        if (!fetchErr && rows.length > 0) {
          notifyAnnouncementChanged('created', rows[0]);
        }
      });

      // Admin dashboard real-time refresh
      broadcastToRoles(
        ['administrator', 'superadmin', 'technical'],
        'adminDashboardUpdated',
        { source: 'announcements', action: 'created', announcementId },
      );

      // ── Notification targeting ─────────────────────────────
      // If hr_only → notify only employees whose role is 'hr'
      // Otherwise  → notify everyone
      const employeeQuery = hr_only
        ? `
            SELECT DISTINCT employeeNumber
            FROM users
            WHERE employeeNumber IS NOT NULL AND employeeNumber != ""
              AND role = 'hr'
            UNION
            SELECT DISTINCT agencyEmployeeNum AS employeeNumber
            FROM person_table
            WHERE agencyEmployeeNum IS NOT NULL AND agencyEmployeeNum != ""
              AND department_code = 'HR'
          `
        : `
            SELECT DISTINCT employeeNumber
            FROM users
            WHERE employeeNumber IS NOT NULL AND employeeNumber != ""
            UNION
            SELECT DISTINCT agencyEmployeeNum AS employeeNumber
            FROM person_table
            WHERE agencyEmployeeNum IS NOT NULL AND agencyEmployeeNum != ""
          `;

      db.query(employeeQuery, async (userErr, users) => {
        if (userErr) {
          console.error('Error fetching users for notifications:', userErr);
          return res.status(201).json({
            message: 'Announcement created successfully',
            id: announcementId,
          });
        }

        if (users && users.length > 0) {
          const employeeNumbers = Array.from(
            new Set(
              users
                .map((u) => String(u.employeeNumber || '').trim())
                .filter(Boolean),
            ),
          );

          insertNotificationsBulk(employeeNumbers, {
            description: notificationDescription,
            type: 'announcement',
            actionLink: `/announcement/${announcementId}`,
            announcementId,
          })
            .then((created) => {
              const failed = employeeNumbers.length - created;
              console.log(`Created ${created} announcement notifications${failed > 0 ? ` (${failed} failed)` : ''}`);
              notifyMultipleUsers(employeeNumbers, 'notificationCreated', {
                notification_type: 'announcement',
                announcement_id: announcementId,
                description: notificationDescription,
              });
            })
            .catch((e) => console.error('Notification insert error:', e));
        }

        res.status(201).json({ message: 'Announcement created successfully', id: announcementId });
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────
// PUT /api/announcements/:id  – Update
// ─────────────────────────────────────────────────────────────
router.put('/api/announcements/:id', authenticateToken, requireAdmin, upload.single('image'), (req, res) => {
  const { id } = req.params;
  const { title, about, date_start, date_end } = req.body;
  const { hr_only, is_flexi, flexi_hours, flexi_custom_time } = parseFlexiFields(req.body);

  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const date  = date_start || date_end || null;

  let query, params;
  if (image) {
    query = `
      UPDATE announcements
      SET title = ?, about = ?, date = ?, date_start = ?, date_end = ?, image = ?,
          hr_only = ?, is_flexi = ?, flexi_hours = ?, flexi_custom_time = ?
      WHERE id = ?
    `;
    params = [title, about, date, date_start || null, date_end || null, image,
               hr_only, is_flexi, flexi_hours, flexi_custom_time, id];
  } else {
    query = `
      UPDATE announcements
      SET title = ?, about = ?, date = ?, date_start = ?, date_end = ?,
          hr_only = ?, is_flexi = ?, flexi_hours = ?, flexi_custom_time = ?
      WHERE id = ?
    `;
    params = [title, about, date, date_start || null, date_end || null,
               hr_only, is_flexi, flexi_hours, flexi_custom_time, id];
  }

  db.query(query, params, (err, result) => {
    if (err) {
      console.error('Error updating announcement:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    db.query('SELECT * FROM announcements WHERE id = ?', [id], (fetchErr, rows) => {
      if (!fetchErr && rows.length > 0) {
        notifyAnnouncementChanged('updated', rows[0]);
      }
    });

    broadcastToRoles(
      ['administrator', 'superadmin', 'technical'],
      'adminDashboardUpdated',
      { source: 'announcements', action: 'updated', announcementId: id },
    );

    res.json({ message: 'Announcement updated successfully' });
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/announcements/:id
// ─────────────────────────────────────────────────────────────
router.delete('/api/announcements/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  db.query('SELECT image FROM announcements WHERE id = ?', [id], (err, results) => {
    if (err)                  return res.status(500).json({ error: 'Internal server error' });
    if (results.length === 0) return res.status(404).json({ error: 'Announcement not found' });

    if (results[0].image) {
      const imagePath = path.join(__dirname, '..', results[0].image);
      fs.unlink(imagePath, (e) => { if (e) console.error('Error deleting image:', e); });
    }

    db.query('DELETE FROM announcements WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({ error: 'Internal server error' });

      notifyAnnouncementChanged('deleted', { id: parseInt(id) });

      broadcastToRoles(
        ['administrator', 'superadmin', 'technical'],
        'adminDashboardUpdated',
        { source: 'announcements', action: 'deleted', announcementId: id },
      );

      res.json({ message: 'Announcement deleted successfully' });
    });
  });
});

module.exports = router;