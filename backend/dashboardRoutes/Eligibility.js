const db = require("../db");
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const xlsx = require("xlsx");
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const socketService = require("../socket/socketService");
const authenticateToken = require("./authMiddleware");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);



const upload = multer({ dest: "uploads/" });


function excelDateToUTCDate(excelDate) {
  const date = new Date((excelDate - 25569) * 86400 * 1000);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}


//data
router.get("/data", requireAdmin, (req, res) => {
  const query = `SELECT * FROM eligibility_table`;
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// Read (Get All Eligibility Data)
router.get("/eligibility", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM eligibility_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// For eligibility records
router.get('/eligibility-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM eligibility_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching eligibility by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch eligibility records' });
    } else {
      res.json(results);
    }
  });
});

// Create (Add New Eligibility)
router.post("/eligibility", requireBodyOwner('person_id'), (req, res) => {
  const { eligibilityName, eligibilityRating, eligibilityDateOfExam, eligibilityPlaceOfExam, licenseNumber, DateOfValidity, person_id } = req.body;
  const query = "INSERT INTO eligibility_table (eligibilityName, eligibilityRating, eligibilityDateOfExam, eligibilityPlaceOfExam, licenseNumber, DateOfValidity, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)";
  db.query(query, [eligibilityName, eligibilityRating, eligibilityDateOfExam, eligibilityPlaceOfExam, licenseNumber, DateOfValidity, person_id], (err, result) => {
    if (err) {
      console.error("Error adding eligibility:", err);
      return res.status(500).send(err);
    }

    socketService.notifyEligibilityChanged("created", {
      id: result.insertId,
      person_id,
    });

    logDashboardCreate(req, "eligibility_table", result.insertId, req.body);

    res.status(201).send({ message: "Eligibility created", id: result.insertId });
  });
});

// Update Eligibility Record
router.put("/eligibility/:id", requireRowOwner('eligibility_table', 'person_id'), (req, res) => {
  const { eligibilityName, eligibilityRating, eligibilityDateOfExam, eligibilityPlaceOfExam, licenseNumber, DateOfValidity, person_id } = req.body;
  const { id } = req.params;
  const query = "UPDATE eligibility_table SET eligibilityName = ?, eligibilityRating = ?, eligibilityDateOfExam = ?, eligibilityPlaceOfExam = ?, licenseNumber = ?, DateOfValidity = ?, person_id = ? WHERE id = ?";

  fetchDashboardRow("eligibility_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send({ message: "Error updating eligibility" });
    if (!oldRow) return res.status(404).send({ message: "Eligibility record not found" });

    db.query(query, [eligibilityName, eligibilityRating, eligibilityDateOfExam, eligibilityPlaceOfExam, licenseNumber, DateOfValidity, person_id, id], (err) => {
      if (err) {
        console.error("Error updating eligibility:", err);
        return res.status(500).send({ message: "Error updating eligibility" });
      }

      logDashboardUpdate(req, "eligibility_table", id, oldRow, req.body);

      socketService.notifyEligibilityChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "Eligibility record updated" });
    });
  });
});

// Delete Eligibility Record
router.delete("/eligibility/:id", requireRowOwner('eligibility_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = "DELETE FROM eligibility_table WHERE id = ?";

  fetchDashboardRow("eligibility_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send(err);
    if (!oldRow) return res.status(404).send({ message: "Eligibility record not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardDelete(req, "eligibility_table", id, oldRow);

      socketService.notifyEligibilityChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "Eligibility record deleted" });
    });
  });
});

module.exports = router;
