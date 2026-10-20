const db = require("../db");
const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs"); // Import file system module
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin } = require('../middleware/auth');
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



// CRUD routes (e.g., Create, Read, Update, Delete)
router.get("/data", requireAdmin, (req, res) => {
  const query = `SELECT * FROM  voluntary_work_table`;
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// more CRUD routes...
// Read (Get All Items)
router.get("/voluntary-work", ownRowsOnly('person_id'), (req, res) => {
  const query = "SELECT * FROM  voluntary_work_table";
  db.query(query, (err, result) => {
    if (err) return res.status(500).send(err);
    res.status(200).send(result);
  });
});

// Create (Add New Item)
router.post("/voluntary-work", requireBodyOwner('person_id'), (req, res) => {
  const { nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork, person_id } = req.body;
  const query = "INSERT INTO  voluntary_work_table (nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork, person_id) VALUES (?, ?, ?, ?, ?, ?)";
  db.query(query, [nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork, person_id], (err, result) => {
    if (err) return res.status(500).send(err);

    socketService.notifyVoluntaryWorkChanged("created", {
      id: result.insertId,
      person_id,
    });

    logDashboardCreate(req, "voluntary_work_table", result.insertId, req.body);

    res.status(201).send({ message: "Item created", id: result.insertId });
  });
});

// Update Item
router.put("/voluntary-work/:id", requireRowOwner('voluntary_work_table', 'person_id'), (req, res) => {
  const { nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork, person_id } = req.body;
  const { id } = req.params;
  const query = "UPDATE voluntary_work_table SET nameAndAddress = ?, dateFrom = ?, dateTo = ?, numberOfHours = ?, natureOfWork = ?, person_id = ?  WHERE id = ?";

  fetchDashboardRow("voluntary_work_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send({ message: "Internal Server Error" });
    if (!oldRow) return res.status(404).send({ message: "Item not found" });

    db.query(query, [nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork, person_id, id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardUpdate(req, "voluntary_work_table", id, oldRow, req.body);

      socketService.notifyVoluntaryWorkChanged("updated", {
        id: Number(id),
        person_id,
      });

      res.status(200).send({ message: "Item updated" });
    });
  });
});

// Delete Item
router.delete("/voluntary-work/:id", requireRowOwner('voluntary_work_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = "DELETE FROM voluntary_work_table WHERE id = ?";

  fetchDashboardRow("voluntary_work_table", id, (fetchErr, oldRow) => {
    if (fetchErr) return res.status(500).send({ message: "Internal Server Error" });
    if (!oldRow) return res.status(404).send({ message: "Item not found" });

    db.query(query, [id], (err) => {
      if (err) return res.status(500).send(err);

      logDashboardDelete(req, "voluntary_work_table", id, oldRow);

      socketService.notifyVoluntaryWorkChanged("deleted", { id: Number(id) });

      res.status(200).send({ message: "Item deleted" });
    });
  });
});

const uploads = multer({ dest: "uploads/" });
// Convert Excel date to normalized UTC date
function excelDateToUTCDate(excelDate) {
  const date = new Date((excelDate - 25569) * 86400 * 1000);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

router.post("/upload_voluntary_work_table", requireAdmin, uploads.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // Read the uploaded XLS file
    const workbook = xlsx.readFile(req.file.path);
    const sheet_name = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name]);

    // Log the uploaded data for troubleshooting
    console.log("Uploaded sheet data:", sheet);

    // Insert data into 'items' table
    sheet.forEach((row) => {
      const nameAndAddress = row.nameAndAddress;
      const dateFrom = excelDateToUTCDate(row.dateFrom);
      const formattedDateVoluntaryFrom = dateFrom.toISOString().split("T")[0];
      const dateTo = excelDateToUTCDate(row.dateTo);
      const formattedDateVoluntaryTo = dateTo.toISOString().split("T")[0];
      const numberOfHours = row.numberOfHours;
      const natureOfWork = row.natureOfWork;

      // Prepare SQL statement for insertion into 'items' table
      const sql = `
        INSERT INTO voluntary_work_table (nameAndAddress, dateFrom, dateTo, numberOfHours, natureOfWork) 
        VALUES (?, ?, ?, ?, ?)
      `;
      db.query(sql, [nameAndAddress, formattedDateVoluntaryFrom, formattedDateVoluntaryTo, numberOfHours, natureOfWork], (err, result) => {
        if (err) {
          console.error("Error inserting data:", err);
          return;
        }
        console.log("Data inserted successfully into items table:", result);
      });
    });

    // Send response after insertion
    socketService.notifyVoluntaryWorkChanged("updated", { source: "upload" });
    res.json({ message: "File uploaded and data inserted successfully into items table" });
  } catch (error) {
    console.error("Error processing XLS file:", error);
    res.status(500).json({ error: "Error processing XLS file" });
  } finally {
    // Delete the uploaded file to save space on the server
    fs.unlink(req.file.path, (err) => {
      if (err) {
        console.error("Error deleting uploaded file:", err);
      } else {
        console.log("Uploaded file deleted");
      }
    });
  }
});

module.exports = router;
