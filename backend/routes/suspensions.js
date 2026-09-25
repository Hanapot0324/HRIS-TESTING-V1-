const express = require("express");
const router = express.Router();
const db = require("../db");
const { upload } = require("../middleware/upload");
const path = require("path");
const fs = require("fs");
const {
  broadcastToRoles,
  notifyMultipleUsers,
} = require("../socket/socketService");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { insertNotificationsBulk } = require("../utils/notificationFanout");
const { parseBranchField } = require("../utils/branchScope");

// GET all suspensions (normalize date_start/date_end for backward compat)
router.get("/api/suspensions", (req, res) => {
  const query = `SELECT id, title, about,
    DATE_FORMAT(COALESCE(date_start, date), '%Y-%m-%d') AS date_start,
    DATE_FORMAT(COALESCE(date_end, date), '%Y-%m-%d') AS date_end,
    DATE_FORMAT(date, '%Y-%m-%d') AS date,
    reason, image,
    COALESCE(personnel_scope, 'all') AS personnel_scope, COALESCE(suspension_type, 'whole_day') AS suspension_type, effective_time,
    branch
    FROM suspensions ORDER BY COALESCE(date_start, date) DESC`;
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching suspensions:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
    const normalized = (results || []).map((row) => ({
      ...row,
      branch:
        row.branch !== null && row.branch !== undefined
          ? Number(row.branch)
          : null,
    }));
    res.json(normalized);
  });
});

// POST: Create suspension (Title, About, Date Range, Reason, branch)
router.post(
  "/api/suspensions",
  authenticateToken,
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    const { title, about, date_start, date_end, reason } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : null;
    const date = date_start || date_end || null;
    const branch = parseBranchField(req.body.branch);

    const ALLOWED_SCOPES = new Set(["all", "academic", "non_teaching"]);
    const personnel_scope = ALLOWED_SCOPES.has(req.body.personnel_scope)
      ? req.body.personnel_scope
      : "all";

    const ALLOWED_TYPES = new Set(["whole_day", "partial_day"]);
    const suspension_type = ALLOWED_TYPES.has(req.body.suspension_type)
      ? req.body.suspension_type
      : "whole_day";

    let effective_time = null;
    if (suspension_type === "partial_day") {
      if (!req.body.effective_time) {
        return res.status(400).json({
          error:
            "effective_time is required when suspension_type is partial_day",
        });
      }
      effective_time = req.body.effective_time;
    }

    const query =
      "INSERT INTO suspensions (title, about, date, date_start, date_end, reason, image, personnel_scope, suspension_type, effective_time, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    db.query(
      query,
      [
        title || "",
        about || "",
        date,
        date_start || null,
        date_end || null,
        reason || "",
        image,
        personnel_scope,
        suspension_type,
        effective_time,
        branch,
      ],
      (err, result) => {
        if (err) {
          console.error("Error creating suspension:", err);
          return res.status(500).json({ error: "Internal server error" });
        }

        const suspensionId = result.insertId;
        const notificationDescription =
          "New suspension notice has been posted. Click to see details.";

        broadcastToRoles(
          ["administrator", "superadmin", "technical"],
          "adminDashboardUpdated",
          { source: "suspensions", action: "created", suspensionId },
        );

        let userSql;
        let userParams = [];
        if (branch === null) {
          userSql = `SELECT DISTINCT employeeNumber FROM users WHERE employeeNumber IS NOT NULL AND employeeNumber != ""
         UNION
         SELECT DISTINCT agencyEmployeeNum AS employeeNumber FROM person_table WHERE agencyEmployeeNum IS NOT NULL AND agencyEmployeeNum != ""`;
        } else {
          userSql = `SELECT DISTINCT employeeNumber FROM users
            WHERE employeeNumber IS NOT NULL AND employeeNumber != "" AND branch = ?`;
          userParams = [branch];
        }

        db.query(userSql, userParams, (userErr, users) => {
          if (userErr) {
            console.error(
              "Error fetching users for suspension notifications:",
              userErr.message,
            );
            return res.status(201).json({
              message: "Suspension created successfully",
              id: suspensionId,
            });
          }
          const employeeNumbers = Array.from(
            new Set(
              (users || [])
                .map((u) => String(u.employeeNumber || "").trim())
                .filter(Boolean),
            ),
          );
          if (employeeNumbers.length === 0) {
            return res.status(201).json({
              message: "Suspension created successfully",
              id: suspensionId,
            });
          }
          insertNotificationsBulk(employeeNumbers, {
            description: notificationDescription,
            type: "suspension",
            actionLink: `/suspension/${suspensionId}`,
          })
            .then(() => {
              notifyMultipleUsers(employeeNumbers, "notificationCreated", {
                notification_type: "suspension",
                description: notificationDescription,
              });
            })
            .catch((e) => console.error("Suspension notification insert error:", e));
        });

        res.status(201).json({
          message: "Suspension created successfully",
          id: suspensionId,
        });
      },
    );
  },
);

// DELETE: Delete suspension
router.delete(
  "/api/suspensions/:id",
  authenticateToken,
  requireAdmin,
  (req, res) => {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    const getQuery = "SELECT image FROM suspensions WHERE id = ?";
    db.query(getQuery, [id], (err, results) => {
      if (err) {
        return res.status(500).json({ error: "Internal server error" });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: "Suspension not found" });
      }
      if (results[0].image) {
        const imagePath = path.join(__dirname, "..", results[0].image);
        fs.unlink(imagePath, (e) => {
          if (e) console.error("Error deleting image:", e.message);
        });
      }
      db.query("DELETE FROM suspensions WHERE id = ?", [id], (delErr) => {
        if (delErr) {
          return res.status(500).json({ error: "Internal server error" });
        }
        broadcastToRoles(
          ["administrator", "superadmin", "technical"],
          "adminDashboardUpdated",
          { source: "suspensions", action: "deleted", suspensionId: id },
        );
        res.json({ message: "Suspension deleted successfully" });
      });
    });
  },
);

module.exports = router;
