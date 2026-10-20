const db = require("../db");
const express = require("express");
const multer = require("multer");
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin } = require('../middleware/auth');
const authenticateToken = require("./authMiddleware");

router.use(authenticateToken);



router.get("/all_data", requireAdmin, (req, res) => {
  const query = `
    SELECT 
    person_table.*,
    vocational_table.*,
    college_table.*,
    graduate_table.*
    FROM person_table
    INNER JOIN vocational_table ON person_table.id = vocational_table.person_id
    INNER JOIN college_table ON person_table.id = college_table.person_id
    INNER JOIN graduate_table ON person_table.id = graduate_table.person_id;
    `;

  db.query(query, (err, results) => {
    console.log(err);
    if (err) return res.status(500).json({ error: "Error fetching data", details: err });
    res.status(200).json(results);
  });
});

router.get("/all_data2", requireAdmin, (req, res) => {
  const query = `
    SELECT 
    person_table.*,
    eligibility_table.*,
    work_experience_table.*
  FROM person_table
  INNER JOIN eligibility_table ON person_table.id = eligibility_table.person_id
  INNER JOIN work_experience_table ON person_table.id = work_experience_table.person_id;
    `;

  db.query(query, (err, results) => {
    console.log(err);
    if (err) return res.status(500).json({ error: "Error fetching data", details: err });
    res.status(200).json(results);
  });
});

module.exports = router;
