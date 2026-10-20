const express = require('express');
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { ownRowsOnly, requireBodyOwner, requireRowOwner } = require('../utils/accessScope');
const db = require('../db');
const xlsx = require('xlsx');
const fs = require('fs');
const { upload } = require('../middleware/upload');
const { authenticateToken, requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');
const socketService = require('../socket/socketService');
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require('../dashboardRoutes/dashboardAuditHelper');

// ============================================
// LEARNING AND DEVELOPMENT ROUTES
// ============================================

// GET all learning and development records
router.get('/learning_and_development_table', authenticateToken, ownRowsOnly('person_id'), (req, res) => {
  const query = 'SELECT * FROM learning_and_development_table';
  db.query(query, (err, result) => {
    if (err) {
      console.error('Error fetching learning_and_development_table:', err);
      return res.status(500).json({ error: 'Failed to fetch learning and development records' });
    }
    res.status(200).json(result);
  });
});

// GET learning and development records by person_id
router.get('/learning_and_development_table/by-person/:person_id', authenticateToken, requireSelfOrAdmin('person_id'), (req, res) => {
  const { person_id } = req.params;
  console.log('Received request for person_id:', person_id);

  const query = 'SELECT * FROM learning_and_development_table WHERE person_id = ?';
  db.query(query, [person_id], (err, result) => {
    if (err) {
      console.error('Error fetching learning_and_development_table by person_id:', err);
      return res.status(500).json({ error: 'Failed to fetch learning and development records' });
    }
    console.log('Query result:', result);
    res.status(200).json(result);
  });
});

// POST - Add new learning and development record
router.post('/learning_and_development_table', authenticateToken, requireBodyOwner('person_id'), (req, res) => {
  const {
    titleOfProgram,
    dateFrom,
    dateTo,
    numberOfHours,
    typeOfLearningDevelopment,
    conductedSponsored,
    person_id,
    incValue
  } = req.body;

  const query = `
    INSERT INTO learning_and_development_table 
    (titleOfProgram, dateFrom, dateTo, numberOfHours, typeOfLearningDevelopment, conductedSponsored, person_id, incValue) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [
      titleOfProgram,
      dateFrom,
      dateTo,
      numberOfHours,
      typeOfLearningDevelopment,
      conductedSponsored,
      person_id,
      incValue || 0
    ],
    (err, result) => {
      if (err) {
        console.error('Error adding record to learning_and_development_table:', err);
        return res.status(500).json({ error: 'Failed to add learning and development record' });
      }

      socketService.notifyLearningChanged('created', {
        id: result.insertId,
        person_id,
      });

      logDashboardCreate(req, 'learning_and_development_table', result.insertId, req.body);

      res.status(201).json({
        message: 'Record successfully added',
        id: result.insertId
      });
    }
  );
});

// PUT - Update existing learning and development record
router.put('/learning_and_development_table/:id', authenticateToken, requireRowOwner('learning_and_development_table', 'person_id'), (req, res) => {
  const {
    titleOfProgram,
    dateFrom,
    dateTo,
    numberOfHours,
    typeOfLearningDevelopment,
    conductedSponsored,
    person_id,
    incValue
  } = req.body;

  const { id } = req.params;

  const query = `
    UPDATE learning_and_development_table 
    SET titleOfProgram = ?, dateFrom = ?, dateTo = ?, numberOfHours = ?, 
        typeOfLearningDevelopment = ?, conductedSponsored = ?, 
        person_id = ?, incValue = ? 
    WHERE id = ?
  `;

  fetchDashboardRow('learning_and_development_table', id, (fetchErr, oldRow) => {
    if (fetchErr) {
      return res.status(500).json({ error: 'Failed to update learning and development record' });
    }
    if (!oldRow) {
      return res.status(404).json({ error: 'Record not found' });
    }

    db.query(
      query,
      [
        titleOfProgram,
        dateFrom,
        dateTo,
        numberOfHours,
        typeOfLearningDevelopment,
        conductedSponsored,
        person_id,
        incValue || 0,
        id
      ],
      (err, result) => {
        if (err) {
          console.error('Error updating record in learning_and_development_table:', err);
          return res.status(500).json({ error: 'Failed to update learning and development record' });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Record not found' });
        }

        logDashboardUpdate(req, 'learning_and_development_table', id, oldRow, req.body);

        socketService.notifyLearningChanged('updated', {
          id: Number(id),
          person_id,
        });

        res.status(200).json({ message: 'Record successfully updated' });
      }
    );
  });
});

// DELETE - Delete learning and development record
router.delete('/learning_and_development_table/:id', authenticateToken, requireRowOwner('learning_and_development_table', 'person_id'), (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM learning_and_development_table WHERE id = ?';

  fetchDashboardRow('learning_and_development_table', id, (fetchErr, oldRow) => {
    if (fetchErr) {
      return res.status(500).json({ error: 'Failed to delete learning and development record' });
    }
    if (!oldRow) {
      return res.status(404).json({ error: 'Record not found' });
    }

    db.query(query, [id], (err, result) => {
      if (err) {
        console.error('Error deleting record from learning_and_development_table:', err);
        return res.status(500).json({ error: 'Failed to delete learning and development record' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Record not found' });
      }

      logDashboardDelete(req, 'learning_and_development_table', id, oldRow);
      socketService.notifyLearningChanged('deleted', { id: Number(id) });
      res.status(200).json({ message: 'Record successfully deleted' });
    });
  });
});

// Helper function to convert Excel date to UTC date
function excelDateToUTCDate(excelDate) {
  const date = new Date((excelDate - 25569) * 86400 * 1000);
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
}

// POST - Upload learning and development records from Excel file
router.post(
  '/upload_learning_and_development_table',
  authenticateToken,
  requireAdmin, upload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      // Read the uploaded XLS file
      const workbook = xlsx.readFile(req.file.path);
      const sheet_name = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name]);

      // Log the uploaded data for troubleshooting
      console.log('Uploaded learning and development data:', sheet);

      // Handle empty sheet
      if (sheet.length === 0) {
        fs.unlink(req.file.path, (err) => {
          if (err) console.error('Error deleting uploaded file:', err);
        });
        return res.status(400).json({ error: 'Excel file is empty' });
      }

      let completedCount = 0;
      let insertedCount = 0;
      let errorCount = 0;
      const errors = [];

      // Insert data into MySQL
      sheet.forEach((row, index) => {
        const titleOfProgram = row.titleOfProgram;
        const dateFrom = excelDateToUTCDate(row.dateFrom);
        const formattedDateFrom = dateFrom.toISOString().split('T')[0];
        const dateTo = excelDateToUTCDate(row.dateTo);
        const formattedDateTo = dateTo.toISOString().split('T')[0];
        const numberOfHours = row.numberOfHours;
        const typeOfLearningDevelopment = row.typeOfLearningDevelopment;
        const conductedSponsored = row.conductedSponsored;

        const query =
          'INSERT INTO learning_and_development_table (titleOfProgram, dateFrom, dateTo, numberOfHours, typeOfLearningDevelopment, conductedSponsored) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(
          query,
          [
            titleOfProgram,
            formattedDateFrom,
            formattedDateTo,
            numberOfHours,
            typeOfLearningDevelopment,
            conductedSponsored,
          ],
          (err, result) => {
            completedCount++;

            if (err) {
              console.error(`Error inserting data at row ${index + 1}:`, err);
              errorCount++;
              errors.push({ row: index + 1, error: err.message });
            } else {
              insertedCount++;
              console.log(`Data inserted successfully at row ${index + 1}:`, result);
            }

            // Send response after all insertions are complete
            if (completedCount === sheet.length) {
              // Clean up uploaded file
              fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting uploaded file:', err);
              });

              socketService.notifyLearningChanged('updated', { source: 'upload' });

              if (errorCount > 0) {
                return res.status(207).json({
                  message: 'Partial success',
                  inserted: insertedCount,
                  errors: errorCount,
                  errorDetails: errors,
                });
              }

              res.json({
                message: 'Data uploaded successfully',
                inserted: insertedCount,
              });
            }
          }
        );
      });
    } catch (error) {
      console.error('Error processing uploaded file:', error);
      if (req.file && req.file.path) {
        fs.unlink(req.file.path, (err) => {
          if (err) console.error('Error deleting uploaded file:', err);
        });
      }
      res.status(500).json({ error: 'Failed to process uploaded file', details: error.message });
    }
  }
);

module.exports = router;

