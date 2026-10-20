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


router.get("/other-information", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM other_information_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// GET other information by person_id
router.get('/other-information-by-person/:person_id', requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  const sql = `SELECT * FROM other_information_table WHERE person_id = ?`;
  db.query(sql, [person_id], (err, results) => {
    if (err) {
      console.error('Error fetching other information by person_id:', err);
      res.status(500).json({ error: 'Failed to fetch other information' });
    } else {
      res.json(results);
    }
  });
});

router.post("/other-information", requireBodyOwner('person_id'), (req, res) => {
  const { specialSkills, nonAcademicDistinctions, membershipInAssociation, person_id } = req.body;
  const query = "INSERT INTO other_information_table (specialSkills, nonAcademicDistinctions, membershipInAssociation, person_id) VALUES (?, ?, ?, ?)";
  db.query(query, [specialSkills, nonAcademicDistinctions, membershipInAssociation, person_id], (err, result) => {
    if (err) return res.status(500).send(err);

    socketService.notifyOtherInformationChanged("created", {
      id: result.insertId,
      person_id,
    });

    logDashboardCreate(req, "other_information_table", result.insertId, req.body);

    res.status(201).send({ message: "Record created", id: result.insertId });
  });
});

router.put("/other-information/:id", requireRowOwner('other_information_table', 'person_id'), (req, res) => {
  const { specialSkills, nonAcademicDistinctions, membershipInAssociation, person_id } = req.body;
  const { id } = req.params;

  const query = "UPDATE other_information_table SET specialSkills = ?, nonAcademicDistinctions = ?, membershipInAssociation = ?, person_id = ? WHERE id = ?";

  fetchDashboardRow("other_information_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send(err);
    if (!oldRow) return res.status(404).send({ message: "Record not found" });

    db.query(query, [specialSkills, nonAcademicDistinctions, membershipInAssociation, person_id, id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardUpdate(req, "other_information_table", id, oldRow, req.body);

      socketService.notifyOtherInformationChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "Item updated" });
    });
  });
});

router.delete("/other-information/:id", requireRowOwner('other_information_table', 'person_id'), (req, res) => {
  const { id } = req.params;

  const query = "DELETE FROM other_information_table WHERE id = ?";

  fetchDashboardRow("other_information_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send(err);
    if (!oldRow) return res.status(404).send({ message: "Record not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardDelete(req, "other_information_table", id, oldRow);

      socketService.notifyOtherInformationChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "Item deleted" });
    });
  });
});

module.exports = router;
