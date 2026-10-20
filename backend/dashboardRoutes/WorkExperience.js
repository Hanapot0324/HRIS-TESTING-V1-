const db = require("../db");
const express = require("express");
const multer = require("multer");
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireSelfOrAdmin } = require('../middleware/auth');
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



router.get("/work-experience-table", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM work_experience_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// GET work experience by person_id
router.get('/work-experience-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM work_experience_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching work experience by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch work experience records' });
    } else {
      res.json(results);
    }
  });
});

router.post("/work-experience-table", requireBodyOwner('person_id'), (req, res) => {
  const { person_id, workDateFrom, workDateTo, workPositionTitle, workCompany, workMonthlySalary, SalaryJobOrPayGrade, StatusOfAppointment, isGovtService } = req.body;

  const query = "INSERT INTO work_experience_table (person_id, workDateFrom, workDateTo, workPositionTitle, workCompany, workMonthlySalary, SalaryJobOrPayGrade, StatusOfAppointment, isGovtService) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

  db.query(query, [person_id, workDateFrom, workDateTo, workPositionTitle, workCompany, workMonthlySalary, SalaryJobOrPayGrade, StatusOfAppointment, isGovtService], (err, result) => {
    if (err) return res.status(500).send(err);

    socketService.notifyWorkExperienceChanged("created", {
      id: result.insertId,
      person_id,
    });

    logDashboardCreate(req, "work_experience_table", result.insertId, req.body);

    res.status(201).send({ message: "Item created", id: result.insertId });
  });
});

router.put("/work-experience-table/:id", requireRowOwner('work_experience_table', 'person_id'), (req, res) => {
  const { person_id, workDateFrom, workDateTo, workPositionTitle, workCompany, workMonthlySalary, SalaryJobOrPayGrade, StatusOfAppointment, isGovtService } = req.body;
  const { id } = req.params;

  const query = "UPDATE work_experience_table SET person_id = ?, workDateFrom = ?, workDateTo = ?, workPositionTitle = ?, workCompany = ?, workMonthlySalary = ?, SalaryJobOrPayGrade = ?, StatusOfAppointment = ?, isGovtService = ? WHERE id = ?";

  fetchDashboardRow("work_experience_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send(err);
    if (!oldRow) return res.status(404).send({ message: "Item not found" });

    db.query(query, [person_id, workDateFrom, workDateTo, workPositionTitle, workCompany, workMonthlySalary, SalaryJobOrPayGrade, StatusOfAppointment, isGovtService, id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardUpdate(req, "work_experience_table", id, oldRow, req.body);

      socketService.notifyWorkExperienceChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "Item updated" });
    });
  });
});

router.delete("/work-experience-table/:id", requireRowOwner('work_experience_table', 'person_id'), (req, res) => {
  const { id } = req.params;

  const query = "DELETE FROM work_experience_table WHERE id = ?";

  fetchDashboardRow("work_experience_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send(err);
    if (!oldRow) return res.status(404).send({ message: "Item not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardDelete(req, "work_experience_table", id, oldRow);

      socketService.notifyWorkExperienceChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "Item deleted" });
    });
  });
});

module.exports = router;
