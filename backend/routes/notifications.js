const express = require('express');
const router = express.Router();
const db = require('../db');
const {
  authenticateToken,
  requireSelfOrAdmin,
  employeeNumbersMatch,
  normalizeEmployeeNumber,
} = require('../middleware/auth');

function inferNotificationType(row) {
  const explicit = String(row?.notification_type || '').trim().toLowerCase();
  if (explicit) return explicit;
  const desc = String(row?.description || '').toLowerCase();
  const link = String(row?.action_link || '').toLowerCase();
  if (row?.announcement_id || desc.includes('announcement') || link.includes('announcement')) {
    return 'announcement';
  }
  if (desc.includes('holiday') || link.includes('holiday')) return 'holiday';
  if (desc.includes('suspension') || link.includes('suspension')) return 'suspension';
  if (desc.includes('payslip') || link.includes('payslip')) return 'payslip';
  if (desc.includes('ticket') || desc.includes('contact') || link.includes('settings')) {
    return 'contact';
  }
  if (desc.includes('leave')) return 'leave';
  return explicit || 'general';
}

function readEmployeeNumber(row) {
  return row?.employeeNumber ?? row?.employee_number ?? row?.employeenumber ?? '';
}

function normalizeRows(rows, employeeNumber) {
  const wanted = String(employeeNumber || '').trim();
  const list = Array.isArray(rows) ? rows : [];
  const matched = list.filter((row) => employeeNumbersMatch(readEmployeeNumber(row), wanted));
  const scoped = matched.length > 0 || list.length === 0 ? matched : list;
  return scoped
    .sort((a, b) => {
      const idDiff = Number(b.id || 0) - Number(a.id || 0);
      if (idDiff) return idDiff;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    })
    .slice(0, 50)
    .map((row) => ({
      ...row,
      employeeNumber: readEmployeeNumber(row),
      notification_type: inferNotificationType(row),
      read_status: Number(row.read_status) === 1 ? 1 : 0,
    }));
}

async function fetchNotificationsForEmployee(employeeNumber) {
  const raw = String(employeeNumber || '').trim();
  const normalized = normalizeEmployeeNumber(raw);

  try {
    // Compare the bare column (no CAST) so MySQL can use the
    // idx_notifications_emp_id (employeeNumber, id) index instead of scanning
    // every notification row on each Home page load / realtime refresh.
    const [rows] = await db.promise().query(
      `SELECT * FROM notifications
       WHERE employeeNumber IN (?, ?)
       ORDER BY id DESC
       LIMIT 80`,
      [raw, normalized || raw],
    );
    return normalizeRows(rows, raw);
  } catch (primaryErr) {
    console.error('Notification query fallback:', primaryErr.message);
    const [rows] = await db.promise().query(
      `SELECT * FROM notifications
       WHERE employeeNumber = ?
       ORDER BY id DESC
       LIMIT 80`,
      [raw],
    );
    return normalizeRows(rows, raw);
  }
}

router.get('/api/notifications/:employeeNumber', authenticateToken, requireSelfOrAdmin('employeeNumber'), async (req, res) => {
  try {
    const { employeeNumber } = req.params;
    const rows = await fetchNotificationsForEmployee(employeeNumber);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Error fetching notifications' });
  }
});

router.get('/api/notifications/:employeeNumber/unread-count', authenticateToken, requireSelfOrAdmin('employeeNumber'), async (req, res) => {
  try {
    const { employeeNumber } = req.params;
    const rows = await fetchNotificationsForEmployee(employeeNumber);
    res.json({ count: rows.filter((row) => Number(row.read_status) === 0).length });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ message: 'Error fetching unread count' });
  }
});

router.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const caller = String(req.user?.employeeNumber || '').trim();
    const role = String(req.user?.role || '').toLowerCase();
    const adminRoles = ['admin', 'administrator', 'superadmin', 'technical'];

    const [rows] = await db.promise().query(
      'SELECT employeeNumber FROM notifications WHERE id = ? LIMIT 1',
      [id],
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    const owner = String(rows[0].employeeNumber || '').trim();
    if (!adminRoles.includes(role) && !employeeNumbersMatch(owner, caller)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [result] = await db.promise().query(
      'UPDATE notifications SET read_status = 1 WHERE id = ?',
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({ message: 'Error updating notification' });
  }
});

router.put('/api/notifications/:employeeNumber/read-all', authenticateToken, requireSelfOrAdmin('employeeNumber'), async (req, res) => {
  try {
    const { employeeNumber } = req.params;
    const rows = await fetchNotificationsForEmployee(employeeNumber);
    const ids = rows.map((row) => row.id).filter(Boolean);
    if (ids.length) {
      await db.promise().query(
        `UPDATE notifications SET read_status = 1 WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating notifications:', error);
    res.status(500).json({ message: 'Error updating notifications' });
  }
});

module.exports = router;
