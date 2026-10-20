const db = require("../db");
const express = require("express");
const multer = require("multer");
const socketService = require("../socket/socketService");

const fs = require("fs"); // Import file system module
const xlsx = require("xlsx");
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const upload = multer({ dest: "uploads/" });
const authenticateToken = require("./authMiddleware");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);



router.get("/data", requireAdmin, (req, res) => {
  const query = `SELECT * FROM college_table`;
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// Read (Get All Colleges)
router.get("/college-table", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM college_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send({ message: "Internal Server Error" });
    res.status(200).send(result);
  });
});

router.get('/college-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM college_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching college by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch college records' });
    } else {
      res.json(results);
    }
  });
});

// Create (Add New College Entry)
router.post("/college-table", requireBodyOwner('person_id'), (req, res) => {
  const { collegeNameOfSchool, collegeDegree, collegePeriodFrom, collegePeriodTo, collegeHighestAttained, collegeYearGraduated, collegeScholarshipAcademicHonorsReceived, person_id } = req.body;

  const query = `
    INSERT INTO college_table (
      collegeNameOfSchool,
      collegeDegree,
      collegePeriodFrom,
      collegePeriodTo,
      collegeHighestAttained,
      collegeYearGraduated,
      collegeScholarshipAcademicHonorsReceived,
      person_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  db.query(query, [collegeNameOfSchool, collegeDegree, collegePeriodFrom, collegePeriodTo, collegeHighestAttained, collegeYearGraduated, collegeScholarshipAcademicHonorsReceived, person_id], (err, result) => {
    if (err) return res.status(500).send({ message: "Internal Server Error" });

    logDashboardCreate(req, "college_table", result.insertId, req.body);

    // Socket.IO (Option A): notify others to refresh
    socketService.notifyCollegeTableChanged("created", {
      id: result.insertId,
      person_id,
    });

    res.status(201).send({ message: "College entry created", id: result.insertId });
  });
});

// Update College Entry
router.put("/college-table/:id", requireRowOwner('college_table', 'person_id'), (req, res) => {
  const { collegeNameOfSchool, collegeDegree, collegePeriodFrom, collegePeriodTo, collegeHighestAttained, collegeYearGraduated, collegeScholarshipAcademicHonorsReceived, person_id } = req.body;

  const { id } = req.params;
  const query = `
    UPDATE college_table SET
      collegeNameOfSchool = ?,
      collegeDegree = ?,
      collegePeriodFrom = ?,
      collegePeriodTo = ?,
      collegeHighestAttained = ?,
      collegeYearGraduated = ?,
      collegeScholarshipAcademicHonorsReceived = ?,
      person_id = ?
    WHERE id = ?`;

  fetchDashboardRow("college_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send({ message: "Internal Server Error" });
    if (!oldRow) return res.status(404).send({ message: "College entry not found" });

    db.query(query, [collegeNameOfSchool, collegeDegree, collegePeriodFrom, collegePeriodTo, collegeHighestAttained, collegeYearGraduated, collegeScholarshipAcademicHonorsReceived, person_id, id], (err) => {
      if (err) return res.status(500).send({ message: "Internal Server Error" });

      logDashboardUpdate(req, "college_table", id, oldRow, req.body);

      socketService.notifyCollegeTableChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "College entry updated" });
    });
  });
});

// Delete College Entry
router.delete("/college-table/:id", requireRowOwner('college_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = "DELETE FROM college_table WHERE id = ?";

  fetchDashboardRow("college_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send({ message: "Internal Server Error" });
    if (!oldRow) return res.status(404).send({ message: "College entry not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).send({ message: "Internal Server Error" });

      logDashboardDelete(req, "college_table", id, oldRow);

      socketService.notifyCollegeTableChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "College entry deleted" });
    });
  });
});

//end of CRUD app


module.exports = router;
