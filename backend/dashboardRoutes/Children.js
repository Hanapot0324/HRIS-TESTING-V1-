const db = require("../db");
const express = require("express");
const multer = require("multer");
const fs = require("fs"); // Import file system module
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireSelfOrAdmin } = require('../middleware/auth');
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const xlsx = require("xlsx");
const socketService = require("../socket/socketService");
const authenticateToken = require("./authMiddleware");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);



// CRUD for Children
router.get("/children-table", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM children_table";
  db.query(query, (err, results) => {
    if (err) return res.status(500).json({ error: "Error fetching children" });
    res.json(results);
  });
});

// For children records
router.get('/children-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM children_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching children by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch children' });
    } else {
      res.json(results);
    }
  });
});

router.post("/children-table", requireBodyOwner('person_id'), (req, res) => {
  const { childrenFirstName, childrenMiddleName, childrenLastName, childrenNameExtension, dateOfBirth, person_id } = req.body;
  const query = `INSERT INTO children_table (childrenFirstName, childrenMiddleName, childrenLastName, childrenNameExtension, dateOfBirth, person_id) VALUES (?, ?, ?, ?, ?, ?)`;
  db.query(query, [childrenFirstName, childrenMiddleName, childrenLastName, childrenNameExtension, dateOfBirth, person_id], (err, result) => {
    if (err) return res.status(500).json({ error: "Error adding child" });

    logDashboardCreate(req, "children_table", result.insertId, req.body);

    socketService.notifyChildrenTableChanged("created", {
      id: result.insertId,
      person_id,
    });

    res.status(201).json({ message: "Child added", id: result.insertId });
  });
});

router.put("/children-table/:id", requireRowOwner('children_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const { childrenFirstName, childrenMiddleName, childrenLastName, childrenNameExtension, dateOfBirth, person_id } = req.body;
  const query = `UPDATE children_table SET childrenFirstName = ?, childrenMiddleName = ?, childrenLastName = ?, childrenNameExtension = ?, dateOfBirth = ?, person_id = ? WHERE id = ?`;

  fetchDashboardRow("children_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).json({ error: "Error updating child" });
    if (!oldRow) return res.status(404).json({ error: "Child record not found" });

    db.query(query, [childrenFirstName, childrenMiddleName, childrenLastName, childrenNameExtension, dateOfBirth, person_id, id], (err) => {
      if (err) return res.status(500).json({ error: "Error updating child" });

      logDashboardUpdate(req, "children_table", id, oldRow, req.body);

      socketService.notifyChildrenTableChanged("updated", {
      id: Number(id),
      person_id,
    });

      res.json({ message: "Child updated" });
    });
  });
});

router.delete("/children-table/:id", requireRowOwner('children_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = `DELETE FROM children_table WHERE id = ?`;

  fetchDashboardRow("children_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).json({ error: "Error deleting child" });
    if (!oldRow) return res.status(404).json({ error: "Child record not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).json({ error: "Error deleting child" });

      logDashboardDelete(req, "children_table", id, oldRow);

      socketService.notifyChildrenTableChanged("deleted", { id: Number(id) });

      res.json({ message: "Child deleted" });
    });
  });
});


module.exports = router;
