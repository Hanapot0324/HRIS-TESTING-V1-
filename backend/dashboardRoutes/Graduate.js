const db = require("../db");
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const xlsx = require("xlsx");

const socketService = require("../socket/socketService");


const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireSelfOrAdmin } = require('../middleware/auth');
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const authenticateToken = require("./authMiddleware");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);



router.get("/graduate-table", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM graduate_table";
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching graduate studies:", err);
      return res.status(500).json({ error: "Error fetching graduate studies" });
    }
    res.json(results);
  });
});

router.get('/graduate-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM graduate_table WHERE person_id = ?`;

  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching graduate records by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch graduate records' });
    } else {
      res.json(results);
    }
  });
});

// CREATE - Add new graduate study
router.post("/graduate-table", requireBodyOwner('person_id'), (req, res) => {
  console.log("POST Data Received:", req.body);

  const {
    person_id,
    graduateNameOfSchool,
    graduateDegree,
    graduatePeriodFrom,
    graduatePeriodTo,
    graduateHighestAttained,
    graduateYearGraduated,
    graduateScholarshipAcademicHonorsReceived,
  } = req.body;

  // Validate required fields
  if (!person_id) {
    return res.status(400).json({ error: "person_id is required" });
  }

  const query = `
    INSERT INTO graduate_table (
      person_id,
      graduateNameOfSchool,
      graduateDegree,
      graduatePeriodFrom,
      graduatePeriodTo,
      graduateHighestAttained,
      graduateYearGraduated,
      graduateScholarshipAcademicHonorsReceived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [
      person_id,
      graduateNameOfSchool || null,
      graduateDegree || null,
      graduatePeriodFrom || null,
      graduatePeriodTo || null,
      graduateHighestAttained || null,
      graduateYearGraduated || null,
      graduateScholarshipAcademicHonorsReceived || null,
    ],
    (err, result) => {
      if (err) {
        console.error("Error inserting graduate study:", err);
        return res.status(500).json({ error: "Error adding graduate study" });
      }

      socketService.notifyGraduateChanged("created", {
        id: result.insertId,
        person_id,
      });

      logDashboardCreate(req, "graduate_table", result.insertId, req.body);

      res.status(201).json({
        message: "Graduate study added successfully",
        id: result.insertId,
      });
    }
  );
});

// UPDATE - Update a graduate study by ID
router.put("/graduate-table/:id", requireRowOwner('graduate_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const {
    person_id,
    graduateNameOfSchool,
    graduateDegree,
    graduatePeriodFrom,
    graduatePeriodTo,
    graduateHighestAttained,
    graduateYearGraduated,
    graduateScholarshipAcademicHonorsReceived,
  } = req.body;

  const query = `
    UPDATE graduate_table SET
      person_id = ?,
      graduateNameOfSchool = ?,
      graduateDegree = ?,
      graduatePeriodFrom = ?,
      graduatePeriodTo = ?,
      graduateHighestAttained = ?,
      graduateYearGraduated = ?,
      graduateScholarshipAcademicHonorsReceived = ?
    WHERE id = ?
  `;

  fetchDashboardRow("graduate_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).json({ error: "Error updating graduate study" });
    if (!oldRow) return res.status(404).json({ error: "Graduate study not found" });

    db.query(
      query,
      [
        person_id,
        graduateNameOfSchool || null,
        graduateDegree || null,
        graduatePeriodFrom || null,
        graduatePeriodTo || null,
        graduateHighestAttained || null,
        graduateYearGraduated || null,
        graduateScholarshipAcademicHonorsReceived || null,
        id,
      ],
      (err, result) => {
        if (err) {
          console.error("Error updating graduate study:", err);
          return res.status(500).json({ error: "Error updating graduate study" });
        }
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Graduate study not found" });
        }

        logDashboardUpdate(req, "graduate_table", id, oldRow, req.body);

        socketService.notifyGraduateChanged("updated", {
          id: Number(id),
          person_id,
        });

        res.json({ message: "Graduate study updated successfully" });
      }
    );
  });
});

// DELETE - Remove a graduate study by ID
router.delete("/graduate-table/:id", requireRowOwner('graduate_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = `DELETE FROM graduate_table WHERE id = ?`;

  fetchDashboardRow("graduate_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).json({ error: "Error deleting graduate study" });
    if (!oldRow) return res.status(404).json({ error: "Graduate study not found" });

    db.query(query, [id], (err, result) => {
      if (err) {
        console.error("Error deleting graduate study:", err);
        return res.status(500).json({ error: "Error deleting graduate study" });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Graduate study not found" });
      }

      logDashboardDelete(req, "graduate_table", id, oldRow);

      socketService.notifyGraduateChanged("deleted", { id: Number(id) });

      res.json({ message: "Graduate study deleted successfully" });
    });
  });
});


module.exports = router;



