const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { mapWithConcurrency } = require('../utils/concurrency');
const { authenticateToken, logAudit, requireAdmin, requireSuperAdmin, requireSelfOrAdmin, requireRoles } = require('../middleware/auth');
const transporter = require('../config/email');
const { notifyPayrollChanged } = require('../socket/socketService');

/** Rows registered in parallel by POST bulk-register (each row runs ~6 queries). */
const BULK_REGISTER_CONCURRENCY = 5;

/**
 * Callback for fire-and-forget cleanup queries. A db.query without a callback
 * emits an unhandled 'error' event on failure (e.g. "Queue limit reached"),
 * which crashes the whole server.
 */
const logQueryError = (err) => {
  if (err) console.error('Background query failed:', err.message);
};

// Helper function to validate email
const validateEmail = (email, isRestricted) => {
  if (!email || typeof email !== 'string') return false;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return false;

  if (isRestricted) {
    return email.toLowerCase().endsWith('@earist.edu.ph');
  }

  return true;
};

const VALID_BRANCH_CODES = [0, 1];

/** Display name as "Surname, First M." (middle name → initial). */
function formatSurnameFirstName({
  firstName,
  middleName,
  lastName,
  nameExtension,
} = {}) {
  const last = String(lastName || '').trim();
  const first = String(firstName || '').trim();
  const middleRaw = String(middleName || '').trim();
  const ext = String(nameExtension || '').trim();
  const middle = middleRaw
    ? `${middleRaw.replace(/\./g, '').charAt(0).toUpperCase()}.`
    : '';
  const given = [first, middle].filter(Boolean).join(' ');
  let name = '';
  if (last && given) name = `${last}, ${given}`;
  else name = last || given;
  if (ext && name) name = `${name} ${ext}`;
  else if (ext) name = ext;
  return name;
}

// GET: Check email domain restriction setting
router.get('/email-domain-restriction', authenticateToken, async (req, res) => {
  try {
    const query = `SELECT setting_value FROM system_settings WHERE setting_key = 'email_domain_restriction'`;

    db.query(query, (err, results) => {
      if (err) {
        console.error('Error fetching email domain restriction:', err);
        return res
          .status(500)
          .json({ error: 'Failed to fetch email domain restriction' });
      }

      // Default to false (disabled) if not set
      const isRestricted =
        results.length > 0 ? results[0].setting_value === 'true' : false;

      res.status(200).json({
        setting_value: isRestricted,
        message: isRestricted
          ? 'Email domain restricted to @earist.edu.ph'
          : 'All email domains allowed',
      });
    });
  } catch (err) {
    console.error('Error checking email domain restriction:', err);
    res.status(500).json({ error: 'Failed to check email domain restriction' });
  }
});

// PUT: Update email domain restriction setting
router.put('/email-domain-restriction', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { value } = req.body;

  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Value must be a boolean' });
  }

  try {
    const checkQuery = `SELECT * FROM system_settings WHERE setting_key = 'email_domain_restriction'`;

    db.query(checkQuery, (err, results) => {
      if (err) {
        console.error('Error checking email domain restriction:', err);
        return res
          .status(500)
          .json({ error: 'Failed to update email domain restriction' });
      }

      const query =
        results.length > 0
          ? `UPDATE system_settings SET setting_value = ? WHERE setting_key = 'email_domain_restriction'`
          : `INSERT INTO system_settings (setting_key, setting_value) VALUES ('email_domain_restriction', ?)`;

      db.query(query, [value.toString()], (updateErr) => {
        if (updateErr) {
          console.error('Error updating email domain restriction:', updateErr);
          return res
            .status(500)
            .json({ error: 'Failed to update email domain restriction' });
        }

        res.status(200).json({
          message: 'Email domain restriction updated successfully',
          setting_value: value,
        });
      });
    });
  } catch (err) {
    console.error('Error updating email domain restriction:', err);
    res
      .status(500)
      .json({ error: 'Failed to update email domain restriction' });
  }
});

// --- NEW: Send Registration Emails Setting ---

// PUT: Update send registration emails setting (DEBUG VERSION)
router.put('/send-registration-emails', authenticateToken, requireAdmin, async (req, res) => {
  const { value } = req.body;

  console.log('--- DEBUG: Received Request ---');
  console.log('Value:', value, 'Type:', typeof value);

  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Value must be a boolean' });
  }

  try {
    const checkQuery = `SELECT * FROM system_settings WHERE setting_key = 'send_registration_emails'`;

    db.query(checkQuery, (err, results) => {
      if (err) {
        console.error('DEBUG: Check Query Failed:', err);
        return res.status(500).json({
          error: 'Failed to check email send setting',
          details: err.message,
        });
      }

      console.log('DEBUG: Existing Records Found:', results.length);

      const query =
        results.length > 0
          ? `UPDATE system_settings SET setting_value = ? WHERE setting_key = 'send_registration_emails'`
          : `INSERT INTO system_settings (setting_key, setting_value) VALUES ('send_registration_emails', ?)`;

      const params = [value.toString()];

      console.log('DEBUG: Executing Query:', query);
      console.log('DEBUG: Params:', params);

      db.query(query, params, (updateErr) => {
        if (updateErr) {
          console.error('!!! DEBUG: Update/Insert Query FAILED !!!');
          console.error('SQL Error:', updateErr.message);
          console.error('SQL Code:', updateErr.code);

          // Send the actual error back to the frontend
          return res.status(500).json({
            error: 'Failed to update email send setting',
            details: updateErr.message,
            code: updateErr.code,
          });
        }

        console.log('DEBUG: Query Successful');
        res.status(200).json({
          message: value
            ? 'Registration emails enabled'
            : 'Registration emails disabled',
          setting_value: value,
        });
      });
    });
  } catch (err) {
    console.error('!!! DEBUG: Server Exception !!!');
    console.error(err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST: Broadcast Login Info ONLY to users with Default Password (Last Name)
router.post('/broadcast-login-info', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Fetch all users. We need their password hash and last name to compare.
    const query = `
      SELECT 
        u.employeeNumber,
        u.email,
        u.password,
        u.username,
        u.role,
        p.firstName,
        p.middleName,
        p.lastName
      FROM users u
      LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
      WHERE u.email IS NOT NULL 
      AND u.email != '' 
      AND u.role != 'superadmin'
    `;

    db.query(query, async (err, users) => {
      if (err) {
        console.error('Error fetching users for broadcast:', err);
        return res.status(500).json({ error: 'Failed to fetch users' });
      }

      if (users.length === 0) {
        return res.status(404).json({ message: 'No users found to email' });
      }

      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0; // Users who changed their password
      const errors = [];

      // Process users
      const promises = users.map(async (user) => {
        const firstName = user.firstName || '';
        const lastName = user.lastName || '';
        const fullName = [firstName, user.middleName, lastName]
          .filter(Boolean)
          .join(' ');

        // 1. Generate the DEFAULT password based on your business logic
        // Last Name, Uppercase, No Spaces
        const defaultPassword = lastName
          .trim()
          .toUpperCase()
          .replace(/\s+/g, '');

        // 2. Check if the user's CURRENT password matches the DEFAULT password
        // If yes, they haven't changed it yet.
        let isDefaultPasswordUser = false;

        try {
          if (defaultPassword) {
            isDefaultPasswordUser = await bcrypt.compare(
              defaultPassword,
              user.password,
            );
          }
        } catch (bcryptErr) {
          console.error(`Bcrypt error for ${user.employeeNumber}:`, bcryptErr);
        }

        // 3. Filter: ONLY email if they still have the default password
        if (isDefaultPasswordUser) {
          try {
            await transporter.sendMail({
              from: `"HRIS System" <${process.env.GMAIL_USER}>`,
              to: user.email,
              subject: 'Your Account Information (Default Password)',
              html: `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>Account Information</title>
                  <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; background-color: #f4f4f4; margin: 0; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                    .header { background: #6d2323; color: #fff; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; margin: -30px -30px 20px -30px; }
                    .details { background: #f9f9f9; padding: 15px; border-left: 4px solid #6d2323; margin: 20px 0; }
                    .label { font-weight: bold; color: #6d2323; }
                    .password-box { background: #fff8e1; border: 2px solid #ffc107; padding: 10px; margin-top: 5px; font-weight: bold; font-family: monospace; font-size: 1.1em; color: #856404; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="header">
                      <h2 style="margin:0;">Your Login Credentials</h2>
                    </div>
                    <p>Hello <strong>${fullName}</strong>,</p>
                    <p>Here are your login details for the HRIS System.</p>
                    
                    <div class="details">
                      <p><span class="label">Employee Number:</span> ${user.employeeNumber}</p>
                      <p><span class="label">Email:</span> ${user.email}</p>
                      <p><span class="label">Temporary Password:</span></p>
                      <div class="password-box">${defaultPassword}</div>
                    </div>
                    
                    <p><strong>Important Action Required:</strong></p>
                    <p>You are currently using the default password. For your account security, please log in immediately and <strong>change your password</strong> in the settings page.</p>
                    
                    <p style="text-align: center; margin-top: 30px;">
                      <a href="${process.env.FRONTEND_URL || 'http://localhost:5137'}" style="background: #6d2323; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Login Now</a>
                    </p>
                  </div>
                </body>
                </html>
              `,
            });
            successCount++;
          } catch (emailErr) {
            console.error(`Failed to send to ${user.email}:`, emailErr);
            failCount++;
            errors.push(user.email);
          }
        } else {
          // User has changed their password, skip them
          skippedCount++;
        }
      });

      await Promise.all(promises);

      res.status(200).json({
        message: 'Broadcast completed',
        total_users_checked: users.length,
        sent_to_default_users: successCount,
        skipped_password_changed: skippedCount,
        failed: failCount,
        errors: errors,
      });
    });
  } catch (error) {
    console.error('Error during broadcast:', error);
    res.status(500).json({ error: 'Server error during broadcast' });
  }
});

// PUT: Update send registration emails setting
router.put('/send-registration-emails', authenticateToken, requireAdmin, async (req, res) => {
  const { value } = req.body;

  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Value must be a boolean' });
  }

  try {
    const checkQuery = `SELECT * FROM system_settings WHERE setting_key = 'send_registration_emails'`;

    db.query(checkQuery, (err, results) => {
      if (err) {
        console.error('Error checking email send setting:', err);
        return res
          .status(500)
          .json({ error: 'Failed to update email send setting' });
      }

      const query =
        results.length > 0
          ? `UPDATE system_settings SET setting_value = ? WHERE setting_key = 'send_registration_emails'`
          : `INSERT INTO system_settings (setting_key, setting_value) VALUES ('send-registration-emails', ?)`;

      db.query(query, [value.toString()], (updateErr) => {
        if (updateErr) {
          console.error('Error updating email send setting:', updateErr);
          return res
            .status(500)
            .json({ error: 'Failed to update email send setting' });
        }

        res.status(200).json({
          message: value
            ? 'Registration emails enabled'
            : 'Registration emails disabled',
          setting_value: value,
        });
      });
    });
  } catch (err) {
    console.error('Error updating email send setting:', err);
    res.status(500).json({ error: 'Failed to update email send setting' });
  }
});

// --- END NEW SETTING ---

// REGISTER - Updated with email notification and 5 categories and email domain validation
router.post('/register', async (req, res) => {
  const {
    firstName,
    middleName,
    lastName,
    nameExtension,
    email,
    password,
    employeeNumber,
    employmentCategory,
    customCategory, // ✅ added
    department,
  } = req.body;

  // ✅ Normalize employmentCategory: ''/undefined/null -> NULL, else Number
  const normalizeEmploymentCategory = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;

    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  };

  const empCatValue = normalizeEmploymentCategory(employmentCategory);
  const customCatValue = empCatValue === 5 ? customCategory || null : null;

  try {
    const hashedPass = await bcrypt.hash(password, 10);
    const fullName = [
      firstName,
      middleName || '',
      lastName,
      nameExtension || '',
    ]
      .filter(Boolean)
      .join(' ');

    // Helper for Category Label
    const getCategoryLabel = (cat) => {
      // ✅ Handle NULL properly
      if (cat === null || cat === undefined) return 'Not Set';

      switch (parseInt(cat)) {
        case 0:
          return 'Job Order - Graduate';
        case 1:
          return 'Job Order - UnderGrad';
        case 2:
          return 'Regular - Non-Teaching';
        case 3:
          return 'Regular - Teaching (Designated)';
        case 4:
          return 'Regular - 30Hrs';
        case 5:
          return `Other${customCatValue ? ` (${customCatValue})` : ''}`;
        default:
          return 'Not Set';
      }
    };

    // Fetch email domain restriction
    let emailRestricted = false;
    try {
      const restrictionQuery = `SELECT setting_value FROM system_settings WHERE setting_key = 'email_domain_restriction'`;
      await new Promise((resolve) => {
        db.query(restrictionQuery, (err, rows) => {
          if (err) {
            console.error('Error fetching email restriction:', err);
            return resolve();
          }
          if (rows.length > 0) {
            emailRestricted = rows[0].setting_value === 'true';
          }
          resolve();
        });
      });
    } catch (restrictionErr) {
      console.error(
        'Error loading email restriction, using defaults:',
        restrictionErr,
      );
    }

    // Email domain validation
    if (email && !validateEmail(email, emailRestricted)) {
      if (emailRestricted) {
        return res.status(400).send({
          error: 'Email must use @earist.edu.ph domain',
        });
      } else {
        return res.status(400).send({
          error: 'Invalid email format',
        });
      }
    }

    const checkQuery = `
      SELECT employeeNumber FROM users WHERE employeeNumber = ? 
      UNION 
      SELECT agencyEmployeeNum FROM person_table WHERE agencyEmployeeNum = ?
    `;

    db.query(
      checkQuery,
      [employeeNumber, employeeNumber],
      (err, existingRecords) => {
        if (err) {
          console.error('Error checking existing records:', err);
          return res
            .status(500)
            .send({ error: 'Failed to check existing records' });
        }

        if (existingRecords.length > 0) {
          return res
            .status(400)
            .send({ error: 'Employee number already exists' });
        }

        // Insert into users table
        const userQuery = `
          INSERT INTO users (
            email,
            role,
            password,
            employeeNumber,
            employmentCategory,
            access_level,
            username
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(
          userQuery,
          [
            email,
            'staff',
            hashedPass,
            employeeNumber,
            empCatValue, // ✅ NO DEFAULT TO 0
            'user',
            fullName,
          ],
          (err) => {
            if (err) {
              console.error('Error inserting into users table:', err);
              return res
                .status(500)
                .send({ error: 'Failed to create user record' });
            }

            // Insert into person_table
            const personQuery = `
              INSERT INTO person_table (
                firstName,
                middleName,
                lastName,
                nameExtension,
                agencyEmployeeNum
              ) VALUES (?, ?, ?, ?, ?)
            `;

            db.query(
              personQuery,
              [
                firstName,
                middleName || null,
                lastName,
                nameExtension || null,
                employeeNumber,
              ],
              (err) => {
                if (err) {
                  console.error('Error inserting into person_table:', err);
                  const cleanupQuery =
                    'DELETE FROM users WHERE employeeNumber = ?';
                  db.query(cleanupQuery, [employeeNumber], logQueryError);
                  return res
                    .status(500)
                    .send({ error: 'Failed to create person record' });
                }

                // ✅ INSERT/UPDATE employment_category table (with customCategory)
                const empCatQuery = `
                  INSERT INTO employment_category (employeeNumber, employmentCategory, customCategory)
                  VALUES (?, ?, ?)
                  ON DUPLICATE KEY UPDATE
                    employmentCategory = VALUES(employmentCategory),
                    customCategory = VALUES(customCategory)
                `;

                db.query(
                  empCatQuery,
                  [employeeNumber, empCatValue, customCatValue], // ✅ NO DEFAULT TO 0
                  async (catErr) => {
                    if (catErr) {
                      console.error(
                        'Error inserting into employment_category:',
                        catErr,
                      );
                      db.query(
                        'DELETE FROM person_table WHERE agencyEmployeeNum = ?',
                        [employeeNumber],
                        logQueryError,
                      );
                      db.query('DELETE FROM users WHERE employeeNumber = ?', [
                        employeeNumber,
                      ], logQueryError);
                      return res.status(500).send({
                        error: 'Failed to create employment category record',
                      });
                    }

                    // Grant default page access for staff role
                    const grantDefaultAccessQuery = `
  SELECT id FROM pages WHERE FIND_IN_SET('staff', REPLACE(page_group, ' ', ''))
`;
                    db.query(
                      grantDefaultAccessQuery,
                      (pagesErr, pagesResult) => {
                        if (!pagesErr && pagesResult.length > 0) {
                          pagesResult.forEach((page) => {
                            const insertAccessQuery = `
                              INSERT INTO page_access (employeeNumber, page_id, page_privilege)
                              VALUES (?, ?, '1')
                              ON DUPLICATE KEY UPDATE page_privilege = '1'
                            `;
                            db.query(
                              insertAccessQuery,
                              [employeeNumber, page.id],
                              (insertErr) => {
                                if (insertErr) {
                                  console.error(
                                    'Error granting default page access:',
                                    insertErr,
                                  );
                                }
                              },
                            );
                          });
                        }
                      },
                    );

                    // ✅ SEND EMAIL WITH CREDENTIALS

                    try {
                      await transporter.sendMail({
                        from: `"HRIS System" <${process.env.GMAIL_USER}>`,
                        to: email,
                        subject: 'Welcome to EARIST - Your Login Information',
                        html: `
                          <!DOCTYPE html>
                          <html lang="en">
                          <head>
                          <meta charset="UTF-8">
                          <meta name="viewport" content="width=device-width, initial-scale=1.0">
                          <title>Login Information</title>
                          <style>
                            * { margin: 0; padding: 0; box-sizing: border-box; }
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f4; color: #333333; line-height: 1.6; }
                            .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 30px 15px; }
                            .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
                            .email-header { background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); padding: 30px; text-align: center; }
                            .email-header h1 { color: #ffffff; font-size: 24px; font-weight: 600; margin: 0; }
                            .email-body { padding: 35px 30px; }
                            .greeting { font-size: 15px; color: #333333; margin-bottom: 15px; }
                            .greeting strong { color: #6d2323; }
                            .intro-text { font-size: 14px; color: #555555; margin-bottom: 25px; line-height: 1.7; }
                            .credentials-box { background: #fafafa; border: 2px solid #f5e6e6; border-radius: 6px; padding: 25px; margin: 25px 0; }
                            .credential-row { margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #eeeeee; }
                            .credential-row:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
                            .credential-label { font-size: 12px; color: #6d2323; font-weight: 600; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.5px; }
                            .credential-value { font-size: 15px; color: #2c3e50; font-weight: 500; }
                            .credential-value.highlight { background: #fff8e1; padding: 10px 15px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; font-size: 16px; letter-spacing: 1px; color: #856404; border: 2px solid #ffc107; display: inline-block; margin-top: 5px; font-weight: 700; }
                            .credential-value.empnum { font-family: 'Courier New', Courier, monospace; font-size: 16px; color: #6d2323; font-weight: 700; }
                            .note-box { background: #fff8e1; border-left: 4px solid #6d2323; padding: 15px 20px; margin: 25px 0; border-radius: 4px; }
                            .note-box p { font-size: 13px; color: #555555; margin: 0; line-height: 1.6; }
                            .note-box strong { color: #6d2323; }
                            .action-section { text-align: center; margin: 30px 0 25px; }
                            .action-button { display: inline-block; background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); color: #ffffff !important; padding: 14px 40px; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 12px rgba(109, 35, 35, 0.25); }
                            .support-text { font-size: 13px; color: #777777; text-align: center; margin-top: 25px; padding-top: 20px; border-top: 1px solid #eeeeee; }
                            .email-footer { background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); padding: 25px; text-align: center; }
                            .footer-text { font-size: 12px; color: #f5e6e6; margin: 5px 0; }
                            @media only screen and (max-width: 600px) { .email-wrapper { padding: 20px 10px; } .email-body { padding: 25px 20px; } .email-header h1 { font-size: 22px; } .credentials-box { padding: 20px; } }
                          </style>
                          </head>
                          <body style="margin: 0; padding: 0; background-color: #f4f4f4; color: #333333; line-height: 1.6;">
                            <div class="email-wrapper" style="width: 100%; background-color: #f4f4f4; padding: 30px 15px;">
                              <div class="email-container" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                                <div class="email-header" style="background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); padding: 30px; text-align: center;">
                                  <h1 style="color: #ffffff; font-size: 24px; font-weight: 600; margin: 0;">Welcome to EARIST HRIS</h1>
                                </div>
                                <div class="email-body" style="padding: 35px 30px;">
                                  <p class="greeting" style="font-size: 15px; color: #333333; margin-bottom: 15px;">Hello <strong style="color: #6d2323;">${fullName}</strong>,</p>
                                  <p class="intro-text" style="font-size: 14px; color: #555555; margin-bottom: 25px; line-height: 1.7;">
                                    Your account has been created. Below are your login credentials.
                                  </p>

                                  <div class="credentials-box" style="background: #fafafa; border: 2px solid #f5e6e6; border-radius: 6px; padding: 25px; margin: 25px 0;">
                                    <div class="credential-row" style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #eeeeee;">
                                      <div class="credential-label" style="font-size: 12px; color: #6d2323; font-weight: 600; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.5px;">Employee Number</div>
                                      <div class="credential-value empnum" style="font-family: 'Courier New', Courier, monospace; font-size: 16px; color: #6d2323; font-weight: 700;">${employeeNumber}</div>
                                    </div>
                                    <div class="credential-row" style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #eeeeee;">
                                      <div class="credential-label" style="font-size: 12px; color: #6d2323; font-weight: 600; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.5px;">Password</div>
                                      <div class="credential-value highlight" style="background: #fff8e1; padding: 10px 15px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; font-size: 16px; letter-spacing: 1px; color: #856404; border: 2px solid #ffc107; display: inline-block; margin-top: 5px; font-weight: 700;">${password}</div>
                                      <div style="font-size: 12px; color: #6b7280; margin-top: 8px; line-height: 1.5;">
                                        
                                      </div>
                                    </div>
                                  </div>

                                  <div class="note-box" style="background: #fff8e1; border-left: 4px solid #6d2323; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
                                    <p style="font-size: 13px; color: #555555; margin: 0; line-height: 1.6;">
                                      <strong>Important:</strong> Change your password after signing in.
                                      Never share your login details with anyone.
                                    </p>
                                  </div>

                                  <div class="action-section" style="text-align: center; margin: 30px 0 25px;">
                                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5137'}" class="action-button" style="display: inline-block; background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); color: #ffffff !important; padding: 14px 40px; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 12px rgba(109, 35, 35, 0.25);">
                                      LOGIN NOW
                                    </a>
                                  </div>

                                  <p class="support-text" style="font-size: 13px; color: #777777; text-align: center; margin-top: 25px; padding-top: 20px; border-top: 1px solid #eeeeee;">
                                    Need help? Contact HR Department during office hours or send a message to earisthrmstesting@gmail.com
                                  </p>
                                </div>

                                <div class="email-footer" style="background: linear-gradient(135deg, #6d2323 0%, #8a4747 100%); padding: 25px; text-align: center;">
                                  <p class="footer-text" style="font-size: 12px; color: #f5e6e6; margin: 5px 0;">Human Resources Information System</p>
                                  <p class="footer-text" style="font-size: 12px; color: #f5e6e6; margin: 5px 0;">© ${new Date().getFullYear()} Eulogio "Amang" Rodriguez Institute of Science and Technology. All rights reserved.</p>
                                </div>
                              </div>
                            </div>
                      </body>
                      </html>
                    `,
                      });
                    } catch (mailErr) {
                      console.error(
                        'Error sending registration email:',
                        mailErr,
                      );
                      // Do not fail registration just because email failed
                    }

                    return res.status(200).send({
                      message: 'User registered successfully',
                    });
                  },
                );
              },
            );
          },
        );
      },
    );
  } catch (err) {
    console.error('Error registering user:', err);
    return res.status(500).send({ error: 'Failed to register user' });
  }
});

// BULK REGISTER WITH EMAIL (Updated logic with email domain validation and EMAIL SENDING TOGGLE)
router.post('/excel-register', authenticateToken, requireAdmin, async (req, res) => {
  const { users } = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ message: 'No users data provided' });
  }

  const results = [];
  const errors = [];

  try {
    // Fetch field requirements from system settings
    let fieldRequirements = {
      firstName: true,
      lastName: true,
      email: true,
      employeeNumber: true,
      employmentCategory: true,
      password: true,
      middleName: false,
      nameExtension: false,
      department: false,
    };

    try {
      const settingsQuery = `SELECT setting_value FROM system_settings WHERE setting_key = 'registration_field_requirements'`;
      await new Promise((resolve) => {
        db.query(settingsQuery, (err, rows) => {
          if (err) {
            console.error('Error fetching field requirements:', err);
            return resolve();
          }
          if (rows.length > 0 && rows[0].setting_value) {
            try {
              fieldRequirements = JSON.parse(rows[0].setting_value);
            } catch (parseErr) {
              console.error('Error parsing field requirements:', parseErr);
            }
          }
          resolve();
        });
      });
    } catch (settingsErr) {
      console.error(
        'Error loading field requirements, using defaults:',
        settingsErr,
      );
    }

      // Helper for Category Label (kept, in case you use it elsewhere)
    const getCategoryLabel = (cat) => {
      switch (parseInt(cat)) {
        case 0:
          return 'Job Order - Graduate';
        case 1:
          return 'Job Order - UnderGrad';
        case 2:
          return 'Regular - Non-Teaching';
        case 3:
          return 'Regular - Teaching (Designated)';
        case 4:
          return 'Regular - 30Hrs';
        default:
          return 'Job Order - Graduated';
      }
    };

    // FIX: validate against the real, live employment_type_config table
    // instead of a hardcoded 0-4 legacy range. Fetched once for the whole
    // batch to avoid an N+1 query per uploaded row.
    const activeTypeRows = await new Promise((resolve, reject) => {
      db.query('SELECT id FROM employment_type_config WHERE isActive = 1', (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
    const activeTypeIds = new Set(activeTypeRows.map((r) => String(r.id)));

    // Bounded concurrency: registering every row at once (Promise.all) fired
    // thousands of parallel queries, overflowing the DB pool queue and
    // stalling every other user until the upload finished.
    await mapWithConcurrency(
      users,
      BULK_REGISTER_CONCURRENCY,
      async (user) => {
        // Async hash: hashSync (pure-JS bcryptjs) blocked the event loop for
        // every row, freezing the whole server during large uploads.
        let hashedPassword;
        try {
          hashedPassword = await bcrypt.hash(user.password, 10);
        } catch (hashErr) {
          errors.push(
            `Invalid password for ${user.employeeNumber}: ${hashErr.message}`,
          );
          return;
        }

        return new Promise((resolve) => {
            const fullName = [
              user.firstName,
              user.middleName || '',
              user.lastName,
              user.nameExtension || '',
            ]
              .filter(Boolean)
              .join(' ');

            // FIX: Normalize employmentCategory input
            const rawEmpCat =
              user.employmentCategory === undefined ||
              user.employmentCategory === null
                ? ''
                : String(user.employmentCategory).trim();

            // FIX: validate against the live employment_type_config table
            // (source of truth) instead of a hardcoded legacy 0-4 range.
            // Any active, configured employment type id is accepted — the
            // id space is not fixed to 0-4, it is whatever Manage Types has
            // created (auto-increment, currently well past 100).
            if (fieldRequirements.employmentCategory) {
              // Field is required — must resolve to a real, active type
              if (!activeTypeIds.has(rawEmpCat)) {
                errors.push(
                  `Invalid employmentCategory for ${user.employeeNumber}: "${rawEmpCat || '(blank)'}" is not a valid, active employment type ID. Configure it in Manage Types first.`,
                );
                return resolve();
              }
              user.employmentCategory = rawEmpCat;
            } else {
              // Field is NOT required:
              // Blank stays NULL (unassigned) — registration still proceeds.
              if (rawEmpCat === '') {
                user.employmentCategory = null;
              } else if (activeTypeIds.has(rawEmpCat)) {
                user.employmentCategory = rawEmpCat;
              } else {
                errors.push(
                  `Invalid employmentCategory for ${user.employeeNumber}: "${rawEmpCat}" is not a valid, active employment type ID.`,
                );
                return resolve();
              }
            }

            // Check if employee number already exists
            const queryCheck = `
              SELECT employeeNumber FROM users WHERE employeeNumber = ? 
              UNION 
              SELECT agencyEmployeeNum FROM person_table WHERE agencyEmployeeNum = ?
            `;

            db.query(
              queryCheck,
              [user.employeeNumber, user.employeeNumber],
              (err, existingRecords) => {
                if (err) {
                  errors.push(
                    `Error checking user ${user.employeeNumber}: ${err.message}`,
                  );
                  return resolve();
                }

                if (existingRecords.length > 0) {
                  errors.push(
                    `Employee number ${user.employeeNumber} already exists`,
                  );
                  return resolve();
                }

                // Insert into users
                const userQuery = `
                  INSERT INTO users (
                    email,
                    role,
                    password,
                    employeeNumber,
                    employmentCategory,
                    access_level,
                    username
                  ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `;

                db.query(
                  userQuery,
                  [
                    user.email,
                    'staff',
                    hashedPassword,
                    user.employeeNumber,
                    user.employmentCategory, // ✅ can be NULL now
                    'user',
                    fullName,
                  ],
                  (err) => {
                    if (err) {
                      errors.push(
                        `Error inserting user ${user.employeeNumber}: ${err.message}`,
                      );
                      return resolve();
                    }

                    // Insert into person_table
                    const personQuery = `
                      INSERT INTO person_table (
                        firstName,
                        middleName,
                        lastName,
                        nameExtension,
                        agencyEmployeeNum
                      ) VALUES (?, ?, ?, ?, ?)
                    `;

                    db.query(
                      personQuery,
                      [
                        user.firstName,
                        user.middleName || null,
                        user.lastName,
                        user.nameExtension || null,
                        user.employeeNumber,
                      ],
                      (err) => {
                        if (err) {
                          errors.push(
                            `Error inserting person ${user.employeeNumber}: ${err.message}`,
                          );
                          db.query(
                            'DELETE FROM users WHERE employeeNumber = ?',
                            [user.employeeNumber],
                            logQueryError,
                          );
                          return resolve();
                        }

                        // ✅ If employmentCategory is NULL, skip writing to employment_category table
                        const handleEmploymentCategoryTable = (done) => {
                          if (user.employmentCategory === null) return done();

                          const checkEmpCatQuery = `
                            SELECT employeeNumber FROM employment_category WHERE employeeNumber = ?
                          `;

                          db.query(
                            checkEmpCatQuery,
                            [user.employeeNumber],
                            (checkErr, existingEmpCat) => {
                              if (checkErr) {
                                errors.push(
                                  `Error checking employment category ${user.employeeNumber}: ${checkErr.message}`,
                                );
                                db.query(
                                  'DELETE FROM person_table WHERE agencyEmployeeNum = ?',
                                  [user.employeeNumber],
                                  logQueryError,
                                );
                                db.query(
                                  'DELETE FROM users WHERE employeeNumber = ?',
                                  [user.employeeNumber],
                                  logQueryError,
                                );
                                return done();
                              }

                              let empCatQuery;
                              if (existingEmpCat.length > 0) {
                                empCatQuery = `
                                  UPDATE employment_category 
                                  SET employmentCategory = ?
                                  WHERE employeeNumber = ?
                                `;
                              } else {
                                empCatQuery = `
                                  INSERT INTO employment_category (employeeNumber, employmentCategory)
                                  VALUES (?, ?)
                                `;
                              }

                              const empCatParams =
                                existingEmpCat.length > 0
                                  ? [
                                      user.employmentCategory,
                                      user.employeeNumber,
                                    ]
                                  : [
                                      user.employeeNumber,
                                      user.employmentCategory,
                                    ];

                              db.query(empCatQuery, empCatParams, (catErr) => {
                                if (catErr) {
                                  errors.push(
                                    `Error ${existingEmpCat.length > 0 ? 'updating' : 'inserting'} employment category ${user.employeeNumber}: ${catErr.message}`,
                                  );
                                  db.query(
                                    'DELETE FROM person_table WHERE agencyEmployeeNum = ?',
                                    [user.employeeNumber],
                                    logQueryError,
                                  );
                                  db.query(
                                    'DELETE FROM users WHERE employeeNumber = ?',
                                    [user.employeeNumber],
                                    logQueryError,
                                  );
                                }
                                done();
                              });
                            },
                          );
                        };

                        handleEmploymentCategoryTable(() => {
                          // Grant default page access for staff role
                          const grantDefaultAccessQuery = `
  SELECT id FROM pages WHERE FIND_IN_SET('staff', REPLACE(page_group, ' ', ''))
`;

                          db.query(
                            grantDefaultAccessQuery,
                            (pagesErr, pagesResult) => {
                              if (!pagesErr && pagesResult.length > 0) {
                                // One multi-row insert per user, with a callback:
                                // callback-less queries emit an unhandled 'error'
                                // event on failure, which crashes the server.
                                const insertAccessQuery = `
                                  INSERT INTO page_access (employeeNumber, page_id, page_privilege)
                                  VALUES ?
                                  ON DUPLICATE KEY UPDATE page_privilege = '1'
                                `;
                                db.query(
                                  insertAccessQuery,
                                  [pagesResult.map((page) => [user.employeeNumber, page.id, '1'])],
                                  (accessErr) => {
                                    if (accessErr) {
                                      console.error(
                                        `Error granting default page access for ${user.employeeNumber}:`,
                                        accessErr.message,
                                      );
                                    }
                                  },
                                );
                              }
                            },
                          );

                          // ✅ REMOVED: SEND EMAIL WITH CREDENTIALS
                          // We keep only a log for auditing.
                          console.log(
                            `[BULK REGISTER] Created user ${user.employeeNumber} (${user.email}) — email credentials NOT sent.`,
                          );

                          // Create department assignment if department is provided
                          if (
                            user.department &&
                            user.department.trim() !== ''
                          ) {
                            const deptAssignmentQuery = `
                              INSERT INTO department_assignment (code, name, employeeNumber)
                              VALUES (?, ?, ?)
                            `;
                            db.query(
                              deptAssignmentQuery,
                              [
                                user.department.trim(),
                                null,
                                user.employeeNumber,
                              ],
                              (deptErr, deptResult) => {
                                if (deptErr) {
                                  console.error(
                                    `Error creating department assignment for ${user.employeeNumber}:`,
                                    deptErr,
                                  );
                                } else {
                                  try {
                                    notifyPayrollChanged('created', {
                                      module: 'department-assignment',
                                      id: deptResult.insertId,
                                      employeeNumber: user.employeeNumber,
                                      code: user.department.trim(),
                                    });
                                  } catch (notifyErr) {
                                    console.error(
                                      'Error notifying payroll change:',
                                      notifyErr,
                                    );
                                  }
                                }
                              },
                            );
                          }

                          results.push({
                            employeeNumber: user.employeeNumber,
                            name: fullName,
                            status: 'success',
                          });
                          resolve();
                        });
                      },
                    );
                  },
                );
              },
            );
        });
      },
    );

    res.json({
      message: 'Bulk registration completed',
      successful: results,
      errors: errors,
    });
  } catch (error) {
    console.error('Error during bulk registration:', error);
    res.status(500).json({ error: 'Failed to process bulk registration' });
  }
});

// GET ALL REGISTERED USERS (lean list — page access fetched per-user on demand)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Statuses that are considered "manually set" — once a user has one of
    // these, attendance-based auto-update never touches their status again.
    const LOCKED_STATUSES = [
      'Active',
      'Inactive',
      'Resigned',
      'Terminated',
      'Retired',
    ];

    // One row per user: no page_access join (was exploding payload), latest
    // department only, employment category labels joined for the list UI.
    const baseQuery = `
      SELECT 
        u.employeeNumber,
        u.email,
        u.role,
        COALESCE(ec.employmentCategory, u.employmentCategory) AS employmentCategory,
        ec.customCategory,
        etc.parentGroup,
        etc.typeName,
        etc.colorHex,
        CASE
          WHEN etc.id IS NOT NULL THEN CONCAT(etc.parentGroup, ' | ', etc.typeName)
          WHEN ec.customCategory IS NOT NULL AND ec.customCategory != '' THEN CONCAT('Other (', ec.customCategory, ')')
          ELSE NULL
        END AS categoryLabel,
        u.access_level,
        u.branch,
        p.firstName,
        p.middleName,
        p.lastName,
        p.nameExtension,
        p.profile_picture AS profilePicture,
        u.created_at,
        u.status AS dbStatus,
        da.code AS departmentCode,
        dt.description AS departmentDescription
      FROM users u
      LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
      LEFT JOIN employment_category ec ON ec.employeeNumber = u.employeeNumber
      LEFT JOIN employment_type_config etc
        ON etc.id = COALESCE(ec.employmentCategory, u.employmentCategory)
      LEFT JOIN (
        SELECT employeeNumber, MAX(id) AS max_id
        FROM department_assignment
        GROUP BY employeeNumber
      ) da_max ON da_max.employeeNumber = u.employeeNumber
      LEFT JOIN department_assignment da
        ON da.employeeNumber = da_max.employeeNumber AND da.id = da_max.max_id
      LEFT JOIN department_table dt ON da.code = dt.code
      ORDER BY
        CASE WHEN p.lastName IS NULL OR TRIM(p.lastName) = '' THEN 1 ELSE 0 END,
        p.lastName ASC,
        p.firstName ASC,
        u.employeeNumber ASC
    `;

    const [baseRows] = await db.promise().query(baseQuery);

    const users = (baseRows || []).map((row) => {
      const currentStatus = row.dbStatus || 'Default';
      return {
        employeeNumber: row.employeeNumber,
        fullName: formatSurnameFirstName(row),
        firstName: row.firstName,
        middleName: row.middleName,
        lastName: row.lastName,
        nameExtension: row.nameExtension,
        profilePicture: row.profilePicture || null,
        email: row.email,
        role: row.role,
        status: currentStatus,
        employmentCategory: row.employmentCategory,
        customCategory: row.customCategory || null,
        parentGroup: row.parentGroup || null,
        typeName: row.typeName || null,
        colorHex: row.colorHex || null,
        categoryLabel: row.categoryLabel || null,
        branch:
          row.branch !== null && row.branch !== undefined
            ? Number(row.branch)
            : null,
        accessLevel: row.access_level,
        createdAt: row.created_at,
        pageAccess: [],
        departmentCode: row.departmentCode || null,
        departmentDescription: row.departmentDescription || null,
      };
    });

    // Respond with stored status first — attendance reconcile runs after.
    res.status(200).json(users);

    // Background: reconcile Default (unlocked) statuses from attendance.
    setImmediate(async () => {
      try {
        const defaultEmpNos = users
          .filter((u) => !LOCKED_STATUSES.includes(u.status || 'Default'))
          .map((u) => u.employeeNumber);
        if (defaultEmpNos.length === 0) return;

        const currentYear = new Date().getFullYear();
        const yearStartMs = Date.UTC(currentYear, 0, 1);
        const yearEndMs = Date.UTC(currentYear + 1, 0, 1);
        const placeholders = defaultEmpNos.map(() => '?').join(', ');

        const arQuery = `
          SELECT personID,
            MAX(CASE WHEN LEFT(date, 4) = ? THEN 1 ELSE 0 END) AS hasCurrentYear
          FROM attendancerecord
          WHERE personID IN (${placeholders})
            AND date IS NOT NULL AND date != ''
          GROUP BY personID
        `;
        const ariQuery = `
          SELECT PersonID,
            MAX(CASE WHEN AttendanceDateTime >= ? AND AttendanceDateTime < ? THEN 1 ELSE 0 END) AS hasCurrentYear
          FROM attendancerecordinfo
          WHERE PersonID IN (${placeholders})
            AND AttendanceDateTime IS NOT NULL
          GROUP BY PersonID
        `;

        const [[arRows], [ariRows]] = await Promise.all([
          db.promise().query(arQuery, [String(currentYear), ...defaultEmpNos]),
          db
            .promise()
            .query(ariQuery, [yearStartMs, yearEndMs, ...defaultEmpNos]),
        ]);

        const currentYearEmpNumbers = new Set();
        const anyYearEmpNumbers = new Set();
        (arRows || []).forEach((row) => {
          const key = String(row.personID);
          anyYearEmpNumbers.add(key);
          if (Number(row.hasCurrentYear) === 1) currentYearEmpNumbers.add(key);
        });
        (ariRows || []).forEach((row) => {
          const key = String(row.PersonID);
          anyYearEmpNumbers.add(key);
          if (Number(row.hasCurrentYear) === 1) currentYearEmpNumbers.add(key);
        });

        const statusUpdates = {};
        for (const u of users) {
          const currentStatus = u.status || 'Default';
          if (LOCKED_STATUSES.includes(currentStatus)) continue;
          const empKey = u.employeeNumber != null ? String(u.employeeNumber) : null;
          let next = 'Default';
          if (empKey && currentYearEmpNumbers.has(empKey)) next = 'Active';
          else if (empKey && anyYearEmpNumbers.has(empKey)) next = 'Inactive';
          if (next !== currentStatus) statusUpdates[u.employeeNumber] = next;
        }

        const employeeNumbers = Object.keys(statusUpdates);
        if (employeeNumbers.length === 0) return;

        const caseClauses = employeeNumbers.map(() => 'WHEN ? THEN ?').join(' ');
        const caseParams = employeeNumbers.flatMap((empNo) => [
          empNo,
          statusUpdates[empNo],
        ]);
        const inPlaceholders = employeeNumbers.map(() => '?').join(', ');
        await db.promise().query(
          `
          UPDATE users
          SET status = CASE employeeNumber
            ${caseClauses}
            ELSE status
          END
          WHERE employeeNumber IN (${inPlaceholders})
        `,
          [...caseParams, ...employeeNumbers],
        );
      } catch (bgErr) {
        console.error('Error reconciling user statuses (background):', bgErr);
      }
    });
  } catch (err) {
    console.error('Error during user fetch:', err);
    console.error('Error stack:', err.stack);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to fetch users',
        details: err.message || 'Unknown error occurred',
      });
    }
  }
});


// GET: Search users for password reset (with filtering)
// NOTE: This route must come BEFORE /users/:employeeNumber to avoid route conflicts
router.get('/users/search', authenticateToken, requireAdmin, (req, res) => {
  const { q } = req.query; // Search query parameter

  try {
    let query = `
      SELECT
        u.employeeNumber,
        u.email,
        u.role,
        u.branch,
        p.firstName,
        p.middleName,
        p.lastName,
        p.nameExtension,
        CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) as fullName
      FROM users u
      LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
      WHERE 1=1
    `;

    let queryParams = [];

    // If search query is provided, filter by name, email, or employee number
    if (q && q.trim() !== '') {
      query += ` AND (
        CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) LIKE ?
        OR p.firstName LIKE ?
        OR p.lastName LIKE ?
        OR u.employeeNumber LIKE ?
        OR u.email LIKE ?
      )`;
      const searchTerm = `%${q.trim()}%`;
      queryParams = [
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
      ];
    }

    query += ` ORDER BY p.lastName, p.firstName ASC`;

    db.query(query, queryParams, (err, results) => {
      if (err) {
        console.error('Error searching users:', err);
        return res.status(500).json({ error: 'Failed to search users' });
      }

      const users = (results || []).map((row) => ({
        ...row,
        fullName: formatSurnameFirstName(row),
      }));
      res.status(200).json(users);
    });
  } catch (err) {
    console.error('Error during user search:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// POST: Module-scoped employee search audit (on select, not autocomplete typing)
router.post(
  '/users/module-employee-search-audit',
  authenticateToken,
  (req, res) => {
    const {
      module,
      action = 'Select employee',
      targetEmployeeNumber,
      targetName,
      searchQuery,
      periodLabel,
    } = req.body || {};

    if (!module || !targetEmployeeNumber) {
      return res
        .status(400)
        .json({ error: 'module and targetEmployeeNumber are required' });
    }

    try {
      const details = {
        button: action,
        actor_employeeNumber: req.user?.employeeNumber ?? null,
        target_employeeNumber: String(targetEmployeeNumber),
        target_name: targetName || null,
        search_query: searchQuery || null,
        month_label: periodLabel || null,
        when: new Date().toISOString(),
      };

      logAudit(
        req.user,
        action,
        String(module),
        searchQuery || null,
        String(targetEmployeeNumber),
        details,
      );
    } catch (e) {
      console.error('Module employee search audit error:', e);
    }

    res.json({ ok: true });
  },
);

// GET SINGLE USER WITH PAGE ACCESS
router.get('/users/:employeeNumber', authenticateToken, requireSelfOrAdmin('employeeNumber'), async (req, res) => {
  const { employeeNumber } = req.params;

  try {
    const query = `
      SELECT 
        u.employeeNumber,
        u.email,
        u.role,
        u.employmentCategory,
        u.branch,
        u.access_level,
        p.firstName,
        p.middleName,
        p.lastName,
        p.nameExtension,
        u.created_at,
        pa.page_id,
        pa.page_privilege,
        da.code AS departmentCode,
        dt.description AS departmentDescription
      FROM users u
      LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
      LEFT JOIN page_access pa ON u.employeeNumber = pa.employeeNumber
      LEFT JOIN department_assignment da ON u.employeeNumber = da.employeeNumber
      LEFT JOIN department_table dt ON da.code = dt.code
      WHERE u.employeeNumber = ?
    `;

    db.query(query, [employeeNumber], (err, results) => {
      if (err) {
        console.error('Error fetching user:', err);
        return res.status(500).json({ error: 'Failed to fetch user' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const base = results[0];
      const user = {
        employeeNumber: base.employeeNumber,
        fullName: formatSurnameFirstName(base),
        firstName: base.firstName,
        middleName: base.middleName,
        lastName: base.lastName,
        nameExtension: base.nameExtension,
        email: base.email,
        role: base.role,
        employmentCategory: base.employmentCategory,
        departmentCode: base.departmentCode || null,
        departmentDescription: base.departmentDescription || null,
        branch: base.branch !== null && base.branch !== undefined ? Number(base.branch) : null,
        accessLevel: base.access_level,
        createdAt: base.created_at,
        pageAccess: results
          .filter((r) => r.page_id)
          .map((r) => ({
            page_id: r.page_id,
            page_privilege: r.page_privilege,
          })),
      };

      res.status(200).json({
        message: 'User fetched successfully',
        user,
      });
    });
  } catch (err) {
    console.error('Error during user fetch:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT: Update user role
router.put('/users/:employeeNumber/role', authenticateToken, requireSuperAdmin, (req, res) => {
  const { employeeNumber } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'Role is required' });
  }

  const validRoles = ['superadmin', 'administrator', 'technical', 'staff'];
  if (!validRoles.includes(role.toLowerCase())) {
    return res.status(400).json({
      error:
        'Invalid role. Must be one of: superadmin, administrator, technical, staff',
    });
  }

  // First, get the current role for audit logging
  const getCurrentRoleQuery = 'SELECT role FROM users WHERE employeeNumber = ?';
  db.query(getCurrentRoleQuery, [employeeNumber], (err, results) => {
    if (err) {
      console.error('Error fetching current role:', err);
      return res.status(500).json({ error: 'Failed to fetch current role' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentRole = results[0].role;
    const newRole = role.toLowerCase();

    // If role hasn't changed, return early
    if (currentRole === newRole) {
      return res.status(200).json({ message: 'Role unchanged', role: newRole });
    }

    // Update the role
    const updateQuery = 'UPDATE users SET role = ? WHERE employeeNumber = ?';
    db.query(updateQuery, [newRole, employeeNumber], (err, result) => {
      if (err) {
        console.error('Error updating user role:', err);
        return res.status(500).json({ error: 'Failed to update user role' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // If role is changed to 'staff', grant default page access
      if (newRole === 'staff') {
        // Get default pages for staff (Home, Attendance, DTR, Payslip, PDS, Settings)
        const getDefaultPagesQuery = `
  SELECT id FROM pages WHERE FIND_IN_SET('staff', REPLACE(page_group, ' ', ''))
`;

        db.query(getDefaultPagesQuery, (pagesErr, pagesResult) => {
          if (!pagesErr && pagesResult.length > 0) {
            // Grant access to default pages for staff
            pagesResult.forEach((page) => {
              const upsertAccessQuery = `
                INSERT INTO page_access (employeeNumber, page_id, page_privilege)
                VALUES (?, ?, '1')
                ON DUPLICATE KEY UPDATE page_privilege = '1'
              `;

              db.query(
                upsertAccessQuery,
                [employeeNumber, page.id],
                (accessErr) => {
                  if (accessErr) {
                    console.error(
                      'Error granting default page access:',
                      accessErr,
                    );
                  } else {
                    console.log(
                      `Granted access to page ${page.id} for staff user ${employeeNumber}`,
                    );
                  }
                },
              );
            });
          }
        });
      }

      // Log audit
      try {
        logAudit(req.user, 'Update', 'users', employeeNumber, employeeNumber);
      } catch (e) {
        console.error('Audit log error:', e);
      }

      res.status(200).json({
        message: 'User role updated successfully',
        employeeNumber,
        previousRole: currentRole,
        newRole: newRole,
      });
    });
  });
});

router.put('/users/:employeeNumber/status', authenticateToken, requireSuperAdmin, (req, res) => {
  const { employeeNumber } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }

  const validStatuses = ['Default', 'Active', 'Inactive', 'Resigned', 'Terminated', 'Retired'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error:
        'Invalid status. Must be one of: Default, Active, Inactive, Resigned, Terminated, Retired',
    });
  }

  // First, get the current status for audit logging
  const getCurrentStatusQuery = 'SELECT status FROM users WHERE employeeNumber = ?';
  db.query(getCurrentStatusQuery, [employeeNumber], (err, results) => {
    if (err) {
      console.error('Error fetching current status:', err);
      return res.status(500).json({ error: 'Failed to fetch current status' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentStatus = results[0].status;
    const newStatus = status;

    // If status hasn't changed, return early
    if (currentStatus === newStatus) {
      return res.status(200).json({ message: 'Status unchanged', status: newStatus });
    }

    // Update the status
    const updateQuery = 'UPDATE users SET status = ? WHERE employeeNumber = ?';
    db.query(updateQuery, [newStatus, employeeNumber], (err, result) => {
      if (err) {
        console.error('Error updating user status:', err);
        return res.status(500).json({ error: 'Failed to update user status' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Log audit
      try {
        logAudit(req.user, 'Update', 'users', employeeNumber, employeeNumber);
      } catch (e) {
        console.error('Audit log error:', e);
      }

      res.status(200).json({
        message: 'User status updated successfully',
        employeeNumber,
        previousStatus: currentStatus,
        newStatus: newStatus,
      });
    });
  });
});

router.put('/users/:employeeNumber/branch', authenticateToken, requireSuperAdmin, (req, res) => {
  const { employeeNumber } = req.params;
  const { branch } = req.body;

  if (employeeNumber === undefined || employeeNumber === null || employeeNumber === '') {
    return res.status(400).json({ error: 'Parameters not found' });
  }

  // Normalize: accept numbers or numeric strings ("0", "1"), reject everything else
  const branchCode = typeof branch === 'string' ? Number(branch) : branch;

  if (
    branch === undefined ||
    branch === null ||
    branch === '' ||
    !Number.isInteger(branchCode) ||
    !VALID_BRANCH_CODES.includes(branchCode)
  ) {
    return res.status(400).json({
      error: 'Invalid branch. Must be 0 (Manila) or 1 (Cavite)',
    });
  }

  // First, get the current branch for no-op check / audit context
  const getCurrentBranchQuery = 'SELECT branch FROM users WHERE employeeNumber = ?';
  db.query(getCurrentBranchQuery, [employeeNumber], (err, results) => {
    if (err) {
      console.error('Error fetching user current branch:', err);
      return res.status(500).json({ error: 'Failed to fetch user current branch' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentBranch = results[0].branch; // 0, 1, or null

    if (currentBranch === branchCode) {
      return res.status(200).json({ message: 'Branch unchanged', branch: branchCode });
    }

    const branchUpdateQuery = 'UPDATE users SET branch = ? WHERE employeeNumber = ?';
    db.query(branchUpdateQuery, [branchCode, employeeNumber], (updateErr, result) => {
      if (updateErr) {
        console.error('Error updating user branch:', updateErr);
        return res.status(500).json({ error: 'Failed to update user branch' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      try {
        logAudit(req.user, 'Update', 'users', employeeNumber, employeeNumber);
      } catch (e) {
        console.error('Audit log error:', e);
      }

      res.status(200).json({
        message: 'User branch updated successfully',
        employeeNumber,
        previousBranch: currentBranch,
        newBranch: branchCode,
      });
    });
  });
});

// POST: Reset password to surname and send email notification
router.post('/users/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const { employeeNumber } = req.body;

  if (!employeeNumber) {
    return res.status(400).json({ error: 'Employee number is required' });
  }

  try {
    // First, get user info and surname
    const userQuery = `
      SELECT 
        u.employeeNumber,
        u.email,
        u.username,
        p.firstName,
        p.middleName,
        p.lastName,
        p.nameExtension,
        CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) as fullName
      FROM users u
      LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
      WHERE u.employeeNumber = ?
    `;

    db.query(userQuery, [employeeNumber], async (err, results) => {
      if (err) {
        console.error('Error fetching user:', err);
        return res.status(500).json({ error: 'Failed to fetch user' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = results[0];
      const surname = user.lastName;

      if (!surname) {
        return res.status(400).json({
          error: 'User does not have a surname (lastName) in the system',
        });
      }

      if (!user.email) {
        return res
          .status(400)
          .json({ error: 'User does not have an email address' });
      }

      // Convert surname to ALL CAPS and remove ALL spaces for the password
      const surnameUpperCase = surname.toUpperCase().replace(/\s+/g, '');

      // Hash the surname (in uppercase with no spaces) as the new password
      const hashedPassword = await bcrypt.hash(surnameUpperCase, 10);

      // Update password in database
      const updateQuery =
        'UPDATE users SET password = ? WHERE employeeNumber = ?';
      db.query(
        updateQuery,
        [hashedPassword, employeeNumber],
        async (updateErr) => {
          if (updateErr) {
            console.error('Error updating password:', updateErr);
            return res.status(500).json({ error: 'Failed to update password' });
          }

          // Send email notification
          try {
            const mailOptions = {
              from: `"HRIS System" <${process.env.GMAIL_USER}>`,
              to: user.email,
              subject: 'Password Reset Notification - HRIS System',
              html: `
              <!DOCTYPE html>
              <html lang="en">
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Password Reset Notification</title>
                <style>
                  * { margin: 0; padding: 0; box-sizing: border-box; }
                  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f4; color: #333333; line-height: 1.6; }
                  .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 30px 15px; }
                  .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
                  .email-header { background: linear-gradient(135deg, #A31D1D 0%, #8a4747 100%); padding: 30px; text-align: center; }
                  .email-header h1 { color: #ffffff; font-size: 24px; font-weight: 600; margin: 0; }
                  .email-body { padding: 35px 30px; }
                  .greeting { font-size: 15px; color: #333333; margin-bottom: 15px; }
                  .greeting strong { color: #A31D1D; }
                  .intro-text { font-size: 14px; color: #555555; margin-bottom: 25px; line-height: 1.7; }
                  .credentials-box { background: #fafafa; border: 2px solid #f5e6e6; border-radius: 6px; padding: 25px; margin: 25px 0; }
                  .credential-row { margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #eeeeee; }
                  .credential-row:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
                  .credential-label { font-size: 12px; color: #A31D1D; font-weight: 600; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.5px; }
                  .credential-value { font-size: 15px; color: #2c3e50; font-weight: 500; }
                  .credential-value.highlight { background: #fff8e1; padding: 10px 15px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; font-size: 16px; letter-spacing: 1px; color: #856404; border: 2px solid #ffc107; display: inline-block; margin-top: 5px; font-weight: 700; }
                  .credential-value.empnum { font-family: 'Courier New', Courier, monospace; font-size: 16px; color: #A31D1D; font-weight: 700; }
                  .note-box { background: #fff8e1; border-left: 4px solid #A31D1D; padding: 15px 20px; margin: 25px 0; border-radius: 4px; }
                  .note-box p { font-size: 13px; color: #555555; margin: 0; line-height: 1.6; }
                  .note-box strong { color: #A31D1D; }
                  .action-section { text-align: center; margin: 30px 0 25px; }
                  .action-button { display: inline-block; background: linear-gradient(135deg, #A31D1D 0%, #8a4747 100%); color: #ffffff !important; padding: 14px 40px; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 12px rgba(163, 29, 29, 0.25); transition: all 0.3s ease; }
                  .action-button:hover { background: linear-gradient(135deg, #8a1a1a 0%, #6d2323 100%); transform: translateY(-2px); }
                  .support-text { font-size: 13px; color: #777777; text-align: center; margin-top: 25px; padding-top: 20px; border-top: 1px solid #eeeeee; }
                  .email-footer { background: linear-gradient(135deg, #A31D1D 0%, #8a4747 100%); padding: 25px; text-align: center; }
                  .footer-text { font-size: 12px; color: #f5e6e6; margin: 5px 0; }
                  @media only screen and (max-width: 600px) { .email-wrapper { padding: 20px 10px; } .email-body { padding: 25px 20px; } .email-header h1 { font-size: 22px; } .credentials-box { padding: 20px; } }
                </style>
              </head>
              <body>
                <div class="email-wrapper">
                  <div class="email-container">
                    <div class="email-header">
                      <h1>Password Reset Notification</h1>
                    </div>
                    <div class="email-body">
                      <p class="greeting">Hello <strong>${user.fullName || user.username}</strong>,</p>
                      <p class="intro-text">
                        Your password has been reset by an administrator. Your account password has been set to your surname (last name) in ALL CAPS with no spaces.
                      </p>
                      <div class="credentials-box">
                        <div class="credential-row">
                          <div class="credential-label">Employee Number</div>
                          <div class="credential-value empnum">${user.employeeNumber}</div>
                        </div>
                        <div class="credential-row">
                          <div class="credential-label">New Password</div>
                          <div class="credential-value highlight">${surnameUpperCase}</div>
                        </div>
                      </div>
                      <div class="note-box">
                        <p>
                          <strong>Important:</strong> For security reasons, please change your password after logging in. 
                          This is a temporary password set to your surname in ALL CAPS with no spaces.
                        </p>
                      </div>
                      <div class="action-section">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:5137'}" class="action-button">Login to HRIS</a>
                      </div>
                      <p class="support-text">
                        If you did not request this password reset, please contact your system administrator immediately.
                      </p>
                    </div>
                    <div class="email-footer">
                      <p class="footer-text">This is an automated message from the HRIS System.</p>
                      <p class="footer-text">Please do not reply to this email.</p>
                    </div>
                  </div>
                </div>
              </body>
              </html>
            `,
            };

            await transporter.sendMail(mailOptions);

            // Log audit
            try {
              logAudit(
                req.user,
                'Update',
                'users',
                employeeNumber,
                employeeNumber,
              );
            } catch (e) {
              console.error('Audit log error:', e);
            }

            res.status(200).json({
              message:
                'Password reset successfully and email notification sent',
              employeeNumber: user.employeeNumber,
              email: user.email,
            });
          } catch (emailErr) {
            console.error('Error sending email:', emailErr);
            // Password was updated but email failed - still return success but with warning
            res.status(200).json({
              message:
                'Password reset successfully but email notification failed',
              employeeNumber: user.employeeNumber,
              warning:
                'Email could not be sent. Please notify the user manually.',
            });
          }
        },
      );
    });
  } catch (err) {
    console.error('Error during password reset:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// PUT: Update employee number
router.put(
  '/users/:employeeNumber/employee-number',
  authenticateToken,
  requireSuperAdmin,
  (req, res) => {
    const { employeeNumber } = req.params;
    const { newEmployeeNumber } = req.body;

    if (!newEmployeeNumber) {
      return res.status(400).json({ error: 'New employee number is required' });
    }

    if (newEmployeeNumber === employeeNumber) {
      return res.status(200).json({ message: 'Employee number unchanged' });
    }

    // Check if new employee number already exists
    const checkQuery = `
    SELECT employeeNumber FROM users WHERE employeeNumber = ? 
    UNION 
    SELECT agencyEmployeeNum FROM person_table WHERE agencyEmployeeNum = ?
  `;

    db.query(
      checkQuery,
      [newEmployeeNumber, newEmployeeNumber],
      (err, existingRecords) => {
        if (err) {
          console.error('Error checking employee number:', err);
          return res
            .status(500)
            .json({ error: 'Failed to check employee number' });
        }

        if (existingRecords.length > 0) {
          return res
            .status(400)
            .json({ error: 'Employee number already exists' });
        }

        // Get connection from pool for transaction
        db.getConnection((err, connection) => {
          if (err) {
            console.error('Error getting connection:', err);
            return res
              .status(500)
              .json({ error: 'Failed to get database connection' });
          }

          // Begin transaction
          connection.beginTransaction((err) => {
            if (err) {
              connection.release();
              console.error('Error starting transaction:', err);
              return res
                .status(500)
                .json({ error: 'Failed to start transaction' });
            }

            // Update users table
            const updateUserQuery =
              'UPDATE users SET employeeNumber = ? WHERE employeeNumber = ?';
            connection.query(
              updateUserQuery,
              [newEmployeeNumber, employeeNumber],
              (err) => {
                if (err) {
                  return connection.rollback(() => {
                    connection.release();
                    console.error('Error updating users table:', err);
                    res.status(500).json({
                      error: 'Failed to update employee number in users table',
                    });
                  });
                }

                // Update person_table
                const updatePersonQuery =
                  'UPDATE person_table SET agencyEmployeeNum = ? WHERE agencyEmployeeNum = ?';
                connection.query(
                  updatePersonQuery,
                  [newEmployeeNumber, employeeNumber],
                  (err) => {
                    if (err) {
                      return connection.rollback(() => {
                        connection.release();
                        console.error('Error updating person_table:', err);
                        res.status(500).json({
                          error:
                            'Failed to update employee number in person table',
                        });
                      });
                    }

                    // Update employment_category
                    const updateEmpCatQuery =
                      'UPDATE employment_category SET employeeNumber = ? WHERE employeeNumber = ?';
                    connection.query(
                      updateEmpCatQuery,
                      [newEmployeeNumber, employeeNumber],
                      (err) => {
                        if (err) {
                          return connection.rollback(() => {
                            connection.release();
                            console.error(
                              'Error updating employment_category:',
                              err,
                            );
                            res.status(500).json({
                              error:
                                'Failed to update employee number in employment category',
                            });
                          });
                        }

                        // Clear orphaned page_access for the new number that would
                        // collide on unique_user_page (employeeNumber + page_id)
                        // when renaming. New number is not a live user (checked above).
                        const deleteConflictPageAccessQuery = `
                          DELETE pa_conflict
                          FROM page_access pa_conflict
                          INNER JOIN page_access pa_old
                            ON pa_conflict.page_id = pa_old.page_id
                          WHERE pa_conflict.employeeNumber = ?
                            AND pa_old.employeeNumber = ?
                        `;
                        connection.query(
                          deleteConflictPageAccessQuery,
                          [newEmployeeNumber, employeeNumber],
                          (err) => {
                            if (err) {
                              return connection.rollback(() => {
                                connection.release();
                                console.error(
                                  'Error clearing conflicting page_access:',
                                  err,
                                );
                                res.status(500).json({
                                  error:
                                    'Failed to update employee number in page access',
                                });
                              });
                            }

                            // Update page_access
                            const updatePageAccessQuery =
                              'UPDATE page_access SET employeeNumber = ? WHERE employeeNumber = ?';
                            connection.query(
                              updatePageAccessQuery,
                              [newEmployeeNumber, employeeNumber],
                              (err) => {
                                if (err) {
                                  return connection.rollback(() => {
                                    connection.release();
                                    console.error(
                                      'Error updating page_access:',
                                      err,
                                    );
                                    res.status(500).json({
                                      error:
                                        'Failed to update employee number in page access',
                                    });
                                  });
                                }

                                // Commit transaction
                                connection.commit((err) => {
                                  if (err) {
                                    return connection.rollback(() => {
                                      connection.release();
                                      console.error(
                                        'Error committing transaction:',
                                        err,
                                      );
                                      res.status(500).json({
                                        error: 'Failed to commit transaction',
                                      });
                                    });
                                  }

                                  connection.release();

                                  // Log audit
                                  try {
                                    logAudit(
                                      req.user,
                                      'Update',
                                      'users',
                                      newEmployeeNumber,
                                      newEmployeeNumber,
                                    );
                                  } catch (e) {
                                    console.error('Audit log error:', e);
                                  }

                                  res.status(200).json({
                                    message:
                                      'Employee number updated successfully',
                                    oldEmployeeNumber: employeeNumber,
                                    newEmployeeNumber: newEmployeeNumber,
                                  });
                                });
                              },
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          });
        });
      },
    );
  },
);

// PUT: Update user email (admin)
router.put('/users/:employeeNumber/email', authenticateToken, requireAdmin, (req, res) => {
  const { employeeNumber } = req.params;
  const { email } = req.body;

  // Allow empty string to clear/remove email (users.email is NOT NULL, use '' for removed)
  const newEmail =
    email == null
      ? ''
      : typeof email === 'string'
        ? email.trim()
        : String(email);

  const updateUserQuery = 'UPDATE users SET email = ? WHERE employeeNumber = ?';
  db.query(
    updateUserQuery,
    [newEmail || '', employeeNumber],
    (err, userResult) => {
      if (err) {
        console.error('Error updating user email:', err);
        return res.status(500).json({ error: 'Failed to update user email' });
      }
      if (userResult.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const updatePersonQuery =
        'UPDATE person_table SET emailAddress = ? WHERE agencyEmployeeNum = ?';
      db.query(
        updatePersonQuery,
        [newEmail || '', employeeNumber],
        (errPerson) => {
          if (errPerson) {
            console.error('Error updating person_table email:', errPerson);
            // User email was updated; still return success
          }
          res.status(200).json({
            message: 'Email updated successfully',
            employeeNumber,
          });
        },
      );
    },
  );
});

// DELETE: Delete user
router.delete('/users/:employeeNumber', authenticateToken, requireSuperAdmin, (req, res) => {
  const { employeeNumber } = req.params;

  if (!employeeNumber) {
    return res.status(400).json({ error: 'Employee number is required' });
  }

  // Check if user exists
  const checkQuery =
    'SELECT employeeNumber FROM users WHERE employeeNumber = ?';
  db.query(checkQuery, [employeeNumber], (err, results) => {
    if (err) {
      console.error('Error checking user:', err);
      return res.status(500).json({ error: 'Failed to check user' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get connection from pool for transaction
    db.getConnection((err, connection) => {
      if (err) {
        console.error('Error getting connection:', err);
        return res
          .status(500)
          .json({ error: 'Failed to get database connection' });
      }

      // Begin transaction
      connection.beginTransaction((err) => {
        if (err) {
          connection.release();
          console.error('Error starting transaction:', err);
          return res.status(500).json({ error: 'Failed to start transaction' });
        }

        // Delete from page_access
        const deletePageAccessQuery =
          'DELETE FROM page_access WHERE employeeNumber = ?';
        connection.query(deletePageAccessQuery, [employeeNumber], (err) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error deleting from page_access:', err);
              res
                .status(500)
                .json({ error: 'Failed to delete page access records' });
            });
          }

          // Delete from employment_category
          const deleteEmpCatQuery =
            'DELETE FROM employment_category WHERE employeeNumber = ?';
          connection.query(deleteEmpCatQuery, [employeeNumber], (err) => {
            if (err) {
              return connection.rollback(() => {
                connection.release();
                console.error('Error deleting from employment_category:', err);
                res.status(500).json({
                  error: 'Failed to delete employment category record',
                });
              });
            }

            // Delete from person_table
            const deletePersonQuery =
              'DELETE FROM person_table WHERE agencyEmployeeNum = ?';
            connection.query(deletePersonQuery, [employeeNumber], (err) => {
              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Error deleting from person_table:', err);
                  res
                    .status(500)
                    .json({ error: 'Failed to delete person record' });
                });
              }

              // Delete from users
              const deleteUserQuery =
                'DELETE FROM users WHERE employeeNumber = ?';
              connection.query(deleteUserQuery, [employeeNumber], (err) => {
                if (err) {
                  return connection.rollback(() => {
                    connection.release();
                    console.error('Error deleting from users:', err);
                    res
                      .status(500)
                      .json({ error: 'Failed to delete user record' });
                  });
                }

                // Commit transaction
                connection.commit((err) => {
                  if (err) {
                    return connection.rollback(() => {
                      connection.release();
                      console.error('Error committing transaction:', err);
                      res
                        .status(500)
                        .json({ error: 'Failed to commit transaction' });
                    });
                  }

                  connection.release();

                  // Log audit
                  try {
                    logAudit(
                      req.user,
                      'Delete',
                      'users',
                      employeeNumber,
                      employeeNumber,
                    );
                  } catch (e) {
                    console.error('Audit log error:', e);
                  }

                  res.status(200).json({
                    message: 'User deleted successfully',
                    employeeNumber: employeeNumber,
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// POST: Grant default page access to all existing staff users
router.post(
  '/users/grant-default-access',
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      // Get all staff users
      const getStaffQuery = 'SELECT employeeNumber FROM users WHERE role = ?';

      db.query(getStaffQuery, ['staff'], (err, staffUsers) => {
        if (err) {
          console.error('Error fetching staff users:', err);
          return res.status(500).json({ error: 'Failed to fetch staff users' });
        }

        if (staffUsers.length === 0) {
          return res.status(200).json({
            message: 'No staff users found',
            usersProcessed: 0,
          });
        }

        // Get default pages for staff
        const getDefaultPagesQuery = `
  SELECT id FROM pages 
  WHERE page_url IN ('home', 'admin-home', 'attendance-user-state', 'daily-time-record', 'payslip', 'pds1', 'pds2', 'pds3', 'pds4', 'settings') 
  OR component_identifier IN ('HomeEmployee', 'HomeAdmin', 'AttendanceUserState', 'DailyTimeRecord', 'Payslip', 'PDS1', 'PDS2', 'PDS3', 'PDS4', 'Settings', 'attendance-user-state', 'daily-time-record', 'daily-time-record-honorarium', 'daily-time-record-service-credits', 'daily-time-record-overtime')
`;

        db.query(getDefaultPagesQuery, (pagesErr, pages) => {
          if (pagesErr) {
            console.error('Error fetching pages:', pagesErr);
            return res.status(500).json({ error: 'Failed to fetch pages' });
          }

          if (pages.length === 0) {
            return res
              .status(404)
              .json({ error: 'No default pages found in database' });
          }

          let processedCount = 0;
          let errorCount = 0;
          const totalOperations = staffUsers.length * pages.length;

          // Grant access to each staff user for each default page
          staffUsers.forEach((user) => {
            pages.forEach((page) => {
              const upsertAccessQuery = `
              INSERT INTO page_access (employeeNumber, page_id, page_privilege)
              VALUES (?, ?, '1')
              ON DUPLICATE KEY UPDATE page_privilege = '1'
            `;

              db.query(
                upsertAccessQuery,
                [user.employeeNumber, page.id],
                (accessErr) => {
                  if (accessErr) {
                    console.error(
                      `Error granting access to ${user.employeeNumber} for page ${page.id}:`,
                      accessErr,
                    );
                    errorCount++;
                  } else {
                    processedCount++;
                  }

                  // Check if all operations are complete
                  if (processedCount + errorCount === totalOperations) {
                    res.status(200).json({
                      message: 'Default access granted to all staff users',
                      usersProcessed: staffUsers.length,
                      pagesGranted: pages.length,
                      successfulOperations: processedCount,
                      failedOperations: errorCount,
                    });
                  }
                },
              );
            });
          });
        });
      });
    } catch (err) {
      console.error('Error granting default access:', err);
      res.status(500).json({ error: 'Failed to grant default access' });
    }
  },
);

// POST: Grant default page access to all existing administrator users (excluding User Management, Payroll Formulas, Admin Security)
router.post(
  '/users/grant-default-access-administrator',
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      // Get all administrator users
      const getAdminQuery = 'SELECT employeeNumber FROM users WHERE role = ?';

      db.query(getAdminQuery, ['administrator'], (err, adminUsers) => {
        if (err) {
          console.error('Error fetching administrator users:', err);
          return res
            .status(500)
            .json({ error: 'Failed to fetch administrator users' });
        }

        if (adminUsers.length === 0) {
          return res.status(200).json({
            message: 'No administrator users found',
            usersProcessed: 0,
          });
        }

        // Get all pages EXCEPT User Management, Payroll Formulas, and Admin Security
        // Exclude by page_url or component_identifier
        const getDefaultPagesQuery = `
        SELECT id FROM pages 
        WHERE (page_url NOT LIKE '%users-list%' 
          AND page_url NOT LIKE '%user-management%'
          AND page_url NOT LIKE '%payroll-formulas%'
          AND page_url NOT LIKE '%admin-security%'
          AND component_identifier NOT IN ('users-list', 'UsersList', 'UserManagement', 'payroll-formulas', 'PayrollFormulas', 'admin-security', 'AdminSecurity'))
      `;

        db.query(getDefaultPagesQuery, (pagesErr, pages) => {
          if (pagesErr) {
            console.error('Error fetching pages:', pagesErr);
            return res.status(500).json({ error: 'Failed to fetch pages' });
          }

          if (pages.length === 0) {
            return res
              .status(404)
              .json({ error: 'No default pages found in database' });
          }

          let processedCount = 0;
          let errorCount = 0;
          const totalOperations = adminUsers.length * pages.length;

          // Grant access to each administrator user for each default page
          adminUsers.forEach((user) => {
            pages.forEach((page) => {
              const upsertAccessQuery = `
              INSERT INTO page_access (employeeNumber, page_id, page_privilege)
              VALUES (?, ?, '1')
              ON DUPLICATE KEY UPDATE page_privilege = '1'
            `;

              db.query(
                upsertAccessQuery,
                [user.employeeNumber, page.id],
                (accessErr) => {
                  if (accessErr) {
                    console.error(
                      `Error granting access to ${user.employeeNumber} for page ${page.id}:`,
                      accessErr,
                    );
                    errorCount++;
                  } else {
                    processedCount++;
                  }

                  // Check if all operations are complete
                  if (processedCount + errorCount === totalOperations) {
                    res.status(200).json({
                      message:
                        'Default access granted to all administrator users (excluding User Management, Payroll Formulas, Admin Security)',
                      usersProcessed: adminUsers.length,
                      pagesGranted: pages.length,
                      successfulOperations: processedCount,
                      failedOperations: errorCount,
                    });
                  }
                },
              );
            });
          });
        });
      });
    } catch (err) {
      console.error('Error granting default access to administrators:', err);
      res
        .status(500)
        .json({ error: 'Failed to grant default access to administrators' });
    }
  },
);

//UNIFIED GRANT END POINTS
router.post(
  '/users/grant-role-access/:role',
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    const { role } = req.params;

    const validRoles = ['staff', 'administrator', 'superadmin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    try {
      db.query(
        'SELECT employeeNumber FROM users WHERE role = ?',
        [role],
        (err, users) => {
          if (err)
            return res.status(500).json({ error: 'Failed to fetch users' });

          if (users.length === 0) {
            return res
              .status(200)
              .json({
                message: `No ${role} users found`,
                usersProcessed: 0,
                pagesGranted: 0,
              });
          }

          // Read directly from pages table using page_group — driven by Page Management
          db.query(
            `SELECT id FROM pages WHERE FIND_IN_SET(?, REPLACE(page_group, ' ', ''))`,
            [role],
            (pagesErr, pages) => {
              if (pagesErr)
                return res.status(500).json({ error: 'Failed to fetch pages' });

              if (pages.length === 0) {
                return res.status(404).json({
                  error: `No pages configured for role "${role}". Go to Page Management and set the Access Groups on each page.`,
                });
              }

              let processed = 0;
              let failed = 0;
              const total = users.length * pages.length;

              users.forEach((user) => {
                pages.forEach((page) => {
                  db.query(
                    `INSERT INTO page_access (employeeNumber, page_id, page_privilege)
                 VALUES (?, ?, '1')
                 ON DUPLICATE KEY UPDATE page_privilege = '1'`,
                    [user.employeeNumber, page.id],
                    (err) => {
                      if (err) {
                        failed++;
                      } else {
                        processed++;
                      }
                      if (processed + failed === total) {
                        res.status(200).json({
                          message: `Access granted for ${role}`,
                          usersProcessed: users.length,
                          pagesGranted: pages.length,
                          success: processed,
                          failed,
                        });
                      }
                    },
                  );
                });
              });
            },
          );
        },
      );
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  },
);

module.exports = router;
