const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const transporter = require('../config/email');
const { twoFACodes } = require('../utils/verificationCodes');
const { JWT_SECRET } = require('../middleware/auth');

// LOGIN
router.post('/login', (req, res) => {
  const { employeeNumber, password } = req.body;

  const query = `
    SELECT u.*, 
           p.firstName, 
           p.middleName, 
           p.lastName, 
           p.nameExtension,
           CONCAT(p.firstName, 
                  CASE WHEN p.middleName IS NOT NULL THEN CONCAT(' ', p.middleName) ELSE '' END,
                  ' ', p.lastName,
                  CASE WHEN p.nameExtension IS NOT NULL THEN CONCAT(' ', p.nameExtension) ELSE '' END
           ) as fullName
    FROM users u 
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum 
    WHERE u.employeeNumber = ?
  `;

  db.query(query, [employeeNumber], async (err, result) => {
    if (err) return res.status(500).send(err);
    if (result.length === 0)
      return res.status(400).send({ message: 'User not found' });

    const user = result[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).send({ message: 'Invalid credentials' });

    res.status(200).send({
      email: user.email,
      employeeNumber: user.employeeNumber,
      fullName: user.fullName,
    });
  });
});

// Send 2FA code
router.post('/send-2fa-code', async (req, res) => {
  const { email, employeeNumber } = req.body;
  if (!email || !employeeNumber) {
    return res
      .status(400)
      .json({ error: 'Email and employee number required' });
  }

  // Check global MFA setting first
  db.query(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'global_mfa_enabled'",
    async (err, globalMfaResult) => {
      if (err) {
        console.error('Error checking global MFA setting:', err);
        return res.status(500).json({ error: 'Error checking MFA settings' });
      }

      // Check if global MFA is enabled
      const globalMfaRaw = globalMfaResult.length > 0 ? globalMfaResult[0].setting_value : null;
      // Default to enabled when the setting has not been initialized yet.
      const globalMfaEnabled =
        globalMfaRaw === null ||
        globalMfaRaw === undefined ||
        globalMfaRaw === 'true' ||
        globalMfaRaw === true ||
        globalMfaRaw === '1' ||
        globalMfaRaw === 1;

      // If global MFA is disabled, reject immediately (no MFA for anyone)
      if (!globalMfaEnabled) {
        console.log('Global MFA is disabled, rejecting code request');
        return res.status(400).json({ error: 'MFA is disabled globally. Please contact administrator.' });
      }

      // Global MFA is enabled, check individual user preference
      db.query(
        'SELECT enable_mfa FROM user_preferences WHERE employee_number = ?',
        [employeeNumber],
        async (err, prefResult) => {
          if (err) {
            console.error('Error checking MFA preference:', err);
            // If error checking preference, default to enabled (require MFA)
          } else {
            // If user has explicitly disabled MFA, reject
            if (prefResult.length > 0 && (prefResult[0].enable_mfa === 0 || prefResult[0].enable_mfa === false)) {
              console.log('User has MFA disabled individually');
              return res.status(400).json({ error: 'MFA is disabled for this account' });
            }
          }
          // User has MFA enabled or no preference (default to enabled), send code
          sendCode();
        }
      );

      // Function to send the verification code
      async function sendCode() {
        const query = `
          SELECT p.firstName, 
                 p.middleName, 
                 p.lastName, 
                 p.nameExtension,
                 CONCAT(p.firstName, 
                        CASE WHEN p.middleName IS NOT NULL THEN CONCAT(' ', p.middleName) ELSE '' END,
                        ' ', p.lastName,
                        CASE WHEN p.nameExtension IS NOT NULL THEN CONCAT(' ', p.nameExtension) ELSE '' END
                 ) as fullName
          FROM users u 
          LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum 
          WHERE u.email = ? AND u.employeeNumber = ?
        `;

        db.query(query, [email, employeeNumber], async (err, result) => {
          if (err) {
            console.error('DB error:', err);
            return res.status(500).json({ error: 'Database error' });
          }
          if (result.length === 0) {
            return res.status(404).json({ error: 'User not found' });
          }

          const user = result[0];
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          const expiresAt = Date.now() + 15 * 60 * 1000;

          twoFACodes[email] = { code, expiresAt };

          try {
            const fromEmail = process.env.GMAIL_USER;
            await transporter.sendMail({
              from: fromEmail
                ? `"EARIST HR Testing" <${fromEmail}>`
                : '"EARIST HR Testing" <no-reply@example.com>',
              to: email,
              subject: 'Login Verification Code',
              html: `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f4f4f4; padding: 20px;">
                  <div style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <div style="background: linear-gradient(135deg, #8b3a3a 0%, #6d2323 100%); color: #ffffff; text-align: center; padding: 20px 20px;">
                      <p style="margin: 0; font-size: 15px; opacity: 0.95; font-weight: 300;">Login Verification</p>
                    </div>
                    <div style="padding: 40px 30px; background-color: #ffffff;">
                      <p style="color: #333333; margin: 0 0 12px 0; font-size: 16px;">Hello <strong>${user.fullName}</strong>,</p>
                      <p style="color: #555555; margin: 0 0 25px 0; font-size: 15px; line-height: 1.6;">We detected a login attempt to your account. For your security, please verify your identity by entering the verification code below:</p>
                      <div style="background: linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%); padding: 30px; text-align: center; margin: 30px 0; border-radius: 10px; border: 2px dashed #d0d0d0;">
                        <p style="color: #888888; margin: 0 0 10px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; font-weight: 500;">Your Verification Code</p>
                        <h1 style="color: #000000; font-size: 25px; margin: 0; letter-spacing: 7px; font-weight: 800; text-decoration: none;">${code}</h1>
                      </div>
                      <div style="background-color: #fff8e1; border-left: 4px solid #ffc107; padding: 15px 20px; margin: 25px 0; border-radius: 5px;">
                        <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">⏱️ This code will expire in <strong>15 minutes</strong>. Do not share it with anyone.</p>
                      </div>
                      <p style="color: #555555; margin: 0; font-size: 14px; line-height: 1.6;">If this login attempt wasn't made by you, we recommend securing your account immediately.</p>
                    </div>
                  </div>
                  <div style="text-align: center; padding: 15px 0; color: #999999; font-size: 12px;">
                    <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
                  </div>
                </div>
              `,
            });
            res.json({ message: 'Verification code sent' });
          } catch (err) {
            console.error('Email send error:', err);
            res.status(500).json({ error: 'Failed to send email' });
          }
        });
      }
    }
  );
});

// Verify 2FA code
router.post('/verify-2fa-code', (req, res) => {
  const { email, code } = req.body;
  const record = twoFACodes[email];

  if (!record) {
    return res
      .status(400)
      .json({ error: 'No code found. Please request again.' });
  }

  if (Date.now() > record.expiresAt) {
    delete twoFACodes[email];
    return res
      .status(400)
      .json({ error: 'Code expired. Please request a new one.' });
  }

  if (record.code !== code) {
    return res.status(400).json({ error: 'Invalid code' });
  }

  res.json({ verified: true });
});

// Complete 2FA login
router.post('/complete-2fa-login', (req, res) => {
  const { email, employeeNumber } = req.body;

  const query = `
    SELECT u.*,
           p.firstName,
           p.middleName,
           p.lastName,
           p.nameExtension,
           CONCAT(p.firstName,
                  CASE WHEN p.middleName IS NOT NULL THEN CONCAT(' ', p.middleName) ELSE '' END,
                  ' ', p.lastName,
                  CASE WHEN p.nameExtension IS NOT NULL THEN CONCAT(' ', p.nameExtension) ELSE '' END
           ) as fullName
    FROM users u
    LEFT JOIN person_table p ON u.employeeNumber = p.agencyEmployeeNum
    WHERE u.employeeNumber = ? AND u.email = ?
  `;

  db.query(query, [employeeNumber, email], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result[0];
    delete twoFACodes[email];

    const isDefaultPassword = user.isDefaultPassword === 1 || user.isDefaultPassword === true;

    const token = jwt.sign(
      {
        id: user.id,
        username: user.fullName,
        employeeNumber: user.employeeNumber,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        nameExtension: user.nameExtension,
      },
      JWT_SECRET,
      { expiresIn: '10h' }
    );

    // Get IP address and user agent for session tracking
    // Handle proxy headers (x-forwarded-for can contain multiple IPs, take the first one)
    let ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    if (ipAddress.includes(',')) {
      ipAddress = ipAddress.split(',')[0].trim();
    }
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // Calculate token expiration time (10 hours from now)
    const tokenExpiresAt = new Date();
    tokenExpiresAt.setHours(tokenExpiresAt.getHours() + 10);

    // Insert session into auth_sessions table
    // First ensure the table exists
    const ensureTableQuery = `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id INT(11) NOT NULL AUTO_INCREMENT,
        employee_number VARCHAR(64) NOT NULL COMMENT 'Employee number of the user',
        email VARCHAR(255) NOT NULL COMMENT 'Email address of the user',
        ip_address VARCHAR(45) NULL DEFAULT NULL COMMENT 'IP address from which the user logged in',
        user_agent TEXT NULL DEFAULT NULL COMMENT 'User agent/browser information',
        login_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the user logged in',
        logout_time DATETIME NULL DEFAULT NULL COMMENT 'When the user logged out (NULL if still active)',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the session is still active (1 = active, 0 = logged out)',
        token_expires_at DATETIME NULL DEFAULT NULL COMMENT 'When the JWT token expires',
        PRIMARY KEY (id),
        INDEX idx_employee_number (employee_number),
        INDEX idx_email (email),
        INDEX idx_login_time (login_time),
        INDEX idx_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Stores user authentication sessions for login tracking';
    `;

    // Insert session into auth_sessions table
    // First check table structure, then insert
    console.log('=== AUTH SESSION INSERT ATTEMPT ===');
    console.log('User data:', {
      employeeNumber: user.employeeNumber,
      email: user.email,
      ipAddress,
      tokenExpiresAt: tokenExpiresAt.toISOString()
    });

    // First, check if table exists and get its structure
    db.query('DESCRIBE auth_sessions', (describeErr, columns) => {
      if (describeErr) {
        // Table doesn't exist, create it
        console.log('Table does not exist, creating...');
        db.query(ensureTableQuery, (tableErr) => {
          if (tableErr) {
            console.error('Error creating auth_sessions table:', tableErr);
          } else {
            console.log('Table created successfully, now inserting...');
            insertSession();
          }
        });
      } else {
        // Table exists, check column names and insert
        console.log('Table exists with columns:', columns.map(c => c.Field).join(', '));
        insertSession();
      }
    });

    function insertSession() {
      // Match the actual table structure: id, session_token, employee_number, ip_address, user_agent, created_at, expires_at, last_activity, is_active
      const sessionQuery = `
        INSERT INTO auth_sessions (session_token, employee_number, ip_address, user_agent, created_at, expires_at, last_activity, is_active)
        VALUES (?, ?, ?, ?, NOW(), ?, NOW(), 1)
      `;

      console.log('Inserting with actual table structure...');

      db.query(
        sessionQuery,
        [token, user.employeeNumber, ipAddress, userAgent, tokenExpiresAt],
        (sessionErr, sessionResult) => {
          if (sessionErr) {
            console.error('=== AUTH SESSION INSERT ERROR ===');
            console.error('Error inserting auth session:', sessionErr);
            console.error('Error details:', {
              code: sessionErr.code,
              errno: sessionErr.errno,
              sqlMessage: sessionErr.sqlMessage,
              sqlState: sessionErr.sqlState
            });
          } else {
            console.log('=== AUTH SESSION INSERT SUCCESS ===');
            console.log('Auth session created successfully for:', user.employeeNumber);
            console.log('Session ID:', sessionResult.insertId);
          }
        }
      );
    }

    res.json({
      token,
      role: user.role,
      employeeNumber: user.employeeNumber,
      email: user.email,
      username: user.fullName,
      firstName: user.firstName,
      middleName: user.middleName,
      lastName: user.lastName,
      nameExtension: user.nameExtension,
      isDefaultPassword: isDefaultPassword,
    });
  });
});

module.exports = router;




