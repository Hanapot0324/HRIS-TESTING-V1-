const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Mounted at '/' in index.js: scope the guard to this router's own paths so it
// does not run on (and reject) every other request that passes through.
router.use('/tasks', authenticateToken, requireAdmin);

// GET all tasks
router.get('/tasks', (req, res) => {
  db.query('SELECT * FROM tasks ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// POST: Add task
router.post('/tasks', (req, res) => {
  const { title, priority } = req.body;
  db.query(
    'INSERT INTO tasks (title, priority) VALUES (?, ?)',
    [title, priority],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json({ id: result.insertId, title, priority, completed: false });
    },
  );
});

// PUT: Toggle task completed
router.put('/tasks/:id/toggle', (req, res) => {
  const { id } = req.params;
  db.query(
    'UPDATE tasks SET completed = NOT completed WHERE id = ?',
    [id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

// DELETE: Delete task
router.delete('/tasks/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM tasks WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

module.exports = router;
