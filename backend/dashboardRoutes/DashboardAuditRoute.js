const express = require('express');
const db = require('../db');
const authenticateToken = require('./authMiddleware');
const { getModuleConfig } = require('./dashboardAuditHelper');

const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/logs', requireAdmin, (req, res) => {
  const tableName = String(req.query.table || '').trim();
  const config = getModuleConfig(tableName);

  if (!config) {
    return res.status(400).json({ error: 'Invalid or missing dashboard table name' });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);

  const query = `
    SELECT
      al.id,
      al.employeeNumber,
      al.action,
      al.table_name,
      al.record_id,
      al.targetEmployeeNumber,
      al.details_json,
      al.timestamp,
      TRIM(CONCAT(p1.firstName, ' ', COALESCE(p1.middleName, ''), ' ', p1.lastName)) AS actorName,
      TRIM(CONCAT(p2.firstName, ' ', COALESCE(p2.middleName, ''), ' ', p2.lastName)) AS targetName
    FROM audit_log al
    LEFT JOIN person_table p1 ON p1.agencyEmployeeNum = al.employeeNumber
    LEFT JOIN person_table p2 ON p2.agencyEmployeeNum = al.targetEmployeeNumber
    WHERE al.table_name = ?
    ORDER BY al.timestamp DESC
    LIMIT ?
  `;

  db.query(query, [tableName, limit], (err, rows) => {
    if (err) {
      console.error('[dashboard-audit] fetch logs:', err);
      return res.status(500).json({ error: 'Failed to fetch dashboard audit logs' });
    }
    res.json(Array.isArray(rows) ? rows : []);
  });
});

module.exports = router;
