const db = require("../db");
const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const uploads = multer({ dest: "uploads/" });
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const fs = require("fs");
const authenticateToken = require("./authMiddleware");
const socketService = require("../socket/socketService");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);





router.get("/data", requireAdmin, (req, res) => {
  const query = "SELECT * FROM vocational_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// CRUD for vocational_table
router.get("/vocational-table", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM vocational_table";
  db.query(query, (err, result) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Internal Server Error");
    }
    res.status(200).send(result);
  });
});

// GET vocational by person_id
router.get('/vocational-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM vocational_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching vocational by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch vocational records' });
    } else {
      res.json(results);
    }
  });
});

router.post("/vocational-table", requireBodyOwner('person_id'), (req, res) => {
  const { vocationalNameOfSchool, vocationalDegree, vocationalPeriodFrom, vocationalPeriodTo, vocationalHighestAttained, vocationalYearGraduated, person_id } = req.body;
  const query = "INSERT INTO vocational_table (vocationalNameOfSchool, vocationalDegree, vocationalPeriodFrom, vocationalPeriodTo, vocationalHighestAttained, vocationalYearGraduated, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)";
  db.query(query, [vocationalNameOfSchool, vocationalDegree, vocationalPeriodFrom, vocationalPeriodTo, vocationalHighestAttained, vocationalYearGraduated, person_id], (err, result) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Internal Server Error");
    }

    socketService.notifyVocationalChanged("created", {
      id: result.insertId,
      person_id,
    });

    logDashboardCreate(req, "vocational_table", result.insertId, req.body);

    res.status(201).send({ message: "Vocational record created", id: result.insertId });
  });
});

router.put("/vocational-table/:id", requireRowOwner('vocational_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const { vocationalNameOfSchool, vocationalDegree, vocationalPeriodFrom, vocationalPeriodTo, vocationalHighestAttained, vocationalYearGraduated, person_id} = req.body;
  const query = "UPDATE vocational_table SET vocationalNameOfSchool = ?, vocationalDegree = ?, vocationalPeriodFrom = ?, vocationalPeriodTo = ?, vocationalHighestAttained = ?, vocationalYearGraduated = ?, person_id = ? WHERE id = ?";

  fetchDashboardRow("vocational_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send("Internal Server Error");
    if (!oldRow) return res.status(404).send({ message: "Vocational record not found" });

    db.query(query, [vocationalNameOfSchool, vocationalDegree, vocationalPeriodFrom, vocationalPeriodTo, vocationalHighestAttained, vocationalYearGraduated, person_id, id], (err) => {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).send("Internal Server Error");
      }

      logDashboardUpdate(req, "vocational_table", id, oldRow, req.body);

      socketService.notifyVocationalChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "Vocational record updated" });
    });
  });
});

router.delete("/vocational-table/:id", requireRowOwner('vocational_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = "DELETE FROM vocational_table WHERE id = ?";

  fetchDashboardRow("vocational_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send("Internal Server Error");
    if (!oldRow) return res.status(404).send({ message: "Vocational record not found" });

    db.query(query, [id], (err) => {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).send("Internal Server Error");
      }

      logDashboardDelete(req, "vocational_table", id, oldRow);

      socketService.notifyVocationalChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "Vocational record deleted" });
    });
  });
});

module.exports = router;
