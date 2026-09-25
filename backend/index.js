const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bodyparser = require('body-parser');
require('dotenv').config();

const db = require('./db');
const { initializeSocket } = require('./socket/socketServer');
const {expireSupervisorAssignments} = require('./utils/supervisorPageAccess')
const {
  startAttendanceRecordInfoSocketApi,
} = require('./socket/attendanceRecordInfoSocketApi');

// Import existing route modules
const childrenRouter = require('./dashboardRoutes/Children');
const EligibilityRoute = require('./dashboardRoutes/Eligibility');
const VoluntaryWork = require('./dashboardRoutes/Voluntary');
const CollegeRoute = require('./dashboardRoutes/College');
const VocationalRoute = require('./dashboardRoutes/Vocational');
const PersonalRoute = require('./dashboardRoutes/PersonalInfo');
const WorkExperienceRoute = require('./dashboardRoutes/WorkExperience');
const OtherInfo = require('./dashboardRoutes/OtherSkills');
const GraduateRoute = require('./dashboardRoutes/Graduate');
const AllData = require('./dashboardRoutes/DataRoute');
const Attendance = require('./dashboardRoutes/Attendance');
const SalaryGradeTable = require('./payrollRoutes/SalaryGradeTable');
const Remittance = require('./payrollRoutes/Remittance');
const SendPayslip = require('./payrollRoutes/SendPayslip');
const Payroll = require('./payrollRoutes/Payroll');
const PayrollReleased = require('./payrollRoutes/PayrollReleased');
const PayrollJO = require('./payrollRoutes/PayrollJO');
const PayrollFormulas = require('./payrollRoutes/PayrollFormulas');
const PayrollExport = require('./payrollRoutes/PayrollExport');
const UploadPayroll = require('./payrollRoutes/UploadPayroll');
const EmployeeCategory = require('./dashboardRoutes/EmployeeCategory');
const dashboardAuditRoute = require('./dashboardRoutes/DashboardAuditRoute');
const AutoAttendance = require('./routes/auto-attendance');

// Import new organized routes
const authRoutes = require('./routes/auth');
const passwordRoutes = require('./routes/password');
const settingsRoutes = require('./routes/settings');
const learningRoutes = require('./routes/learning');
const userRoutes = require('./routes/users');
const pageRoutes = require('./routes/pages');
const officialtimeRoutes = require('./routes/officialtime');
const remittanceRoutes = require('./routes/remittance');
const itemRoutes = require('./routes/item');
const salaryRoutes = require('./routes/salary');
const departmentRoutes = require('./routes/department');
const leaveRoutes = require('./routes/leave');
const holidayRoutes = require('./routes/holiday');
const philhealthRoutes = require('./routes/philhealth');
const profileRoutes = require('./routes/profile');
const announcementsRoutes = require('./routes/announcements');
const suspensionsRoutes = require('./routes/suspensions');
const auditRoutes = require('./routes/audit');
const adminActionTrailRoutes = require('./routes/adminActionTrail');
const tasksRoutes = require('./routes/tasks');
const dashboardRoutes = require('./routes/dashboard');
const notesRoutes = require('./routes/notes');
const eventsRoutes = require('./routes/events');
const notificationsRoutes = require('./routes/notifications');
const reportsRoutes = require('./routes/reports');
const settingsExtendedRoutes = require('./routes/settings-extended');
const confidentialPasswordRoutes = require('./routes/confidential-password');
const commutationRoute = require('./routes/commutation');
const pdsTemplatesRoutes = require('./routes/pds-templates');
const file201Routes = require('./routes/file201');
const workingHoursRoutes = require('./routes/workingHoursRoutes');
const serviceCreditRoutes = require('./routes/serviceCredit');
const ctoRoutes = require('./routes/ctoRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const deductionsRoutes = require('./routes/deductions');
const leaveSalaryShortfallRoutes = require('./routes/leaveSalaryShortfallRoutes');
const attendanceResultRoutes = require('./routes/attendanceResultRoutes');
const supervisorRoutes = require('./routes/supervisor');
const attendanceComputationViewStateRoutes = require('./routes/attendanceComputationViewState');



const app = express();

// CORS configuration - MUST be before body parsing middleware
// Allow localhost, any 192.168.* (LAN), and specific public origins so other devices can load data
const allowedOrigins = [
  'http://localhost:5137',
  'http://192.168.50.36:5137',
  'http://192.168.50.45:5137',
  'http://136.239.248.42:5137',
  'http://192.168.50.97:5137',
  'http://192.168.50.86:5173',
  'http://192.168.50.62:5173',
  'http://192.168.50.49:5173'
];

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.indexOf(origin) !== -1) return true;
  // Allow any device on LAN (192.168.x.x) and localhost with any port
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    if (u.hostname.startsWith('192.168.')) return true;
  } catch (_) {}
  return false;
}

app.use(
  cors({
    origin: function (origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: [
      'Content-Type',
      'Authorization',
      'Content-Disposition',
      'X-Appendix33-Template',
      'X-Appendix33-Template-Id',
      'X-Appendix33-Employees',
    ],
  }),
);

// Body parsing middleware - AFTER CORS
// Increase payload size limit to handle bulk operations (default is 100kb)
app.use(express.json({ limit: '50mb' }));
app.use(bodyparser.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static file serving
app.use('/uploads', express.static('uploads'));

// Ensure audit log table exists
const ensureAuditLogTableSQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employeeNumber VARCHAR(64) NULL,
    action VARCHAR(512) NOT NULL,
    table_name VARCHAR(128) NULL,
    record_id INT NULL,
    targetEmployeeNumber VARCHAR(64) NULL,
    details_json LONGTEXT NULL,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

db.query(ensureAuditLogTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure audit_log table exists:', err);
  } else {
    console.log('Audit log table ready');
  }
});

// Admin Action Trail — superadmin / administrator / admin actors only
const ensureAdminActionTrailTableSQL = `
  CREATE TABLE IF NOT EXISTS admin_action_trail (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employeeNumber VARCHAR(64) NULL,
    actor_role VARCHAR(64) NULL,
    action VARCHAR(512) NOT NULL,
    table_name VARCHAR(128) NULL,
    record_id INT NULL,
    targetEmployeeNumber VARCHAR(64) NULL,
    details_json LONGTEXT NULL,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_admin_action_trail_timestamp (timestamp),
    KEY idx_admin_action_trail_employee (employeeNumber),
    KEY idx_admin_action_trail_actor_role (actor_role)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

db.query(ensureAdminActionTrailTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure admin_action_trail table exists:', err);
  } else {
    console.log('Admin action trail table ready');
  }
});

db.query(
  `INSERT INTO pages (page_name, page_description, page_url, page_group, component_identifier)
   SELECT
     'Admin Action Trail',
     'Trail of superadmin and administrator actions across the system',
     '/admin-action-trail',
     'superadmin,technical',
     'admin-action-trail'
   WHERE NOT EXISTS (
     SELECT 1 FROM pages WHERE component_identifier = 'admin-action-trail'
   )`,
  (seedErr) => {
    if (seedErr && seedErr.code !== 'ER_NO_SUCH_TABLE') {
      console.error('admin-action-trail page seed:', seedErr.message);
    }
  },
);

// Dedicated earnings / payroll-audit trail (used by earningsRoutes, leave half-day, salary shortfall mirror)
const ensureEarningsAuditLogTableSQL = `
  CREATE TABLE IF NOT EXISTS earnings_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    earning_type VARCHAR(64) NOT NULL,
    earning_id VARCHAR(64) NULL COMMENT 'Usually leave/sc/cto row id; may be employeeNumber for UI-only rows',
    action VARCHAR(512) NOT NULL,
    old_status VARCHAR(64) NULL,
    new_status VARCHAR(64) NULL,
    actor VARCHAR(64) NULL,
    notes TEXT NULL,
    payload LONGTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_earnings_audit_type_id (earning_type, earning_id),
    KEY idx_earnings_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureEarningsAuditLogTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure earnings_audit_log table exists:', err.message);
  } else {
    console.log('earnings_audit_log table ready');
  }
});

db.query(
  `ALTER TABLE earnings_audit_log
   MODIFY COLUMN earning_id VARCHAR(64) NULL
   COMMENT 'Usually leave/sc/cto row id; may be employeeNumber for UI-only rows'`,
  (alterErr) => {
    if (alterErr && alterErr.code !== 'ER_NO_SUCH_TABLE') {
      console.error('earnings_audit_log earning_id VARCHAR migration:', alterErr.message);
    }
  },
);

// Legacy phpMyAdmin / old installs used VARCHAR(10) earning_type → truncated "attendance", "half_day_p", etc.
db.query(
  `ALTER TABLE earnings_audit_log
   MODIFY COLUMN earning_type VARCHAR(64) NOT NULL`,
  (alterErr) => {
    if (alterErr && alterErr.code !== 'ER_NO_SUCH_TABLE') {
      console.error('earnings_audit_log earning_type width migration:', alterErr.message);
    }
  },
);
db.query(
  `ALTER TABLE earnings_audit_log
   MODIFY COLUMN action VARCHAR(512) NOT NULL`,
  (alterErr) => {
    if (alterErr && alterErr.code !== 'ER_NO_SUCH_TABLE') {
      console.error('earnings_audit_log action width migration:', alterErr.message);
    }
  },
);

db.query('ALTER TABLE audit_log ADD COLUMN details_json LONGTEXT NULL', (err) => {
  if (err && err.code !== 'ER_DUP_FIELDNAME') {
    console.error('Audit log migration details_json:', err.message);
  }
});

// Ensure auth_sessions table exists
const ensureAuthSessionsTableSQL = `
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

db.query(ensureAuthSessionsTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure auth_sessions table exists:', err);
  } else {
    console.log('Auth sessions table ready');
  }
});

// Ensure holiday table exists (create if missing, then add optional columns)
const ensureHolidayTableSQL = `
  CREATE TABLE IF NOT EXISTS holiday (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description VARCHAR(512) NULL,
    date DATE NULL,
    status VARCHAR(64) NULL DEFAULT 'Active',
    title VARCHAR(255) NULL,
    about TEXT NULL,
    date_start DATE NULL,
    date_end DATE NULL,
    image VARCHAR(500) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureHolidayTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure holiday table exists:', err.message);
  } else {
    db.query('ALTER TABLE holiday ADD COLUMN title VARCHAR(255) NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration title:', e.message);
    });
    db.query('ALTER TABLE holiday ADD COLUMN about TEXT NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration about:', e.message);
    });
    db.query('ALTER TABLE holiday ADD COLUMN date_start DATE NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration date_start:', e.message);
    });
    db.query('ALTER TABLE holiday ADD COLUMN date_end DATE NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration date_end:', e.message);
    });
    db.query('ALTER TABLE holiday ADD COLUMN image VARCHAR(500) NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration image:', e.message);
    });
    db.query('ALTER TABLE holiday ADD COLUMN branch TINYINT NULL DEFAULT NULL', (e) => {
      if (e && e.code !== 'ER_DUP_FIELDNAME')
        console.error('Holiday migration branch:', e.message);
    });
  }
});

// Leave requests: reason text captured when HR denies a request
db.query('ALTER TABLE leave_request ADD COLUMN denial_reason TEXT NULL', (err) => {
  if (err && err.code !== 'ER_DUP_FIELDNAME')
    console.error('Leave request migration denial_reason:', err.message);
});

// Announcements: Date Range for carousel visibility
[
  'ALTER TABLE announcements ADD COLUMN date_start DATE NULL',
  'ALTER TABLE announcements ADD COLUMN date_end DATE NULL',
  'ALTER TABLE announcements ADD COLUMN hr_only TINYINT(1) NOT NULL DEFAULT 0',
  'ALTER TABLE announcements ADD COLUMN is_flexi TINYINT(1) NOT NULL DEFAULT 0',
  'ALTER TABLE announcements ADD COLUMN flexi_hours DECIMAL(5,2) NULL',
  'ALTER TABLE announcements ADD COLUMN flexi_custom_time TIME NULL',
].forEach((sql) => {
  db.query(sql, (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME')
      console.error('Announcements migration:', err.message);
  });
});

// Ensure suspensions table exists (for suspension creation visible on HomeAdmin carousel)
const ensureSuspensionsTableSQL = `
  CREATE TABLE IF NOT EXISTS suspensions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(512) NULL,
    about TEXT NULL,
    date DATE NULL,
    date_start DATE NULL,
    date_end DATE NULL,
    reason VARCHAR(512) NULL,
    image VARCHAR(500) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureSuspensionsTableSQL, (err) => {
  if (err)
    console.error('Failed to ensure suspensions table exists:', err.message);
  else console.log('Suspensions table ready');
});

// Suspension scope / type columns (Announcement → DTR / attendance modules)
[
  "ALTER TABLE suspensions ADD COLUMN personnel_scope VARCHAR(32) NOT NULL DEFAULT 'all'",
  "ALTER TABLE suspensions ADD COLUMN suspension_type VARCHAR(32) NOT NULL DEFAULT 'whole_day'",
  'ALTER TABLE suspensions ADD COLUMN effective_time TIME NULL',
  'ALTER TABLE suspensions ADD COLUMN branch TINYINT NULL DEFAULT NULL',
].forEach((sql) => {
  db.query(sql, (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME')
      console.error('Suspensions migration:', err.message);
  });
});

// Ensure contact messages table exists (threaded replies)
const ensureContactMessagesTableSQL = `
  CREATE TABLE IF NOT EXISTS contact_us_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contact_id INT NOT NULL,
    sender_role VARCHAR(32) NULL,
    sender_employee_number VARCHAR(64) NULL,
    sender_name VARCHAR(255) NULL,
    sender_email VARCHAR(255) NULL,
    message TEXT NOT NULL,
    attachment VARCHAR(512) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contact_id (contact_id),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Stores threaded replies for contact_us';
`;

db.query(ensureContactMessagesTableSQL, (err) => {
  if (err)
    console.error('Failed to ensure contact_us_messages table exists:', err.message);
  else console.log('Contact messages table ready');
});

// Ensure contact_us_messages has attachment column
db.query('ALTER TABLE contact_us_messages ADD COLUMN attachment VARCHAR(512) NULL', (err) => {
  if (err && err.code !== 'ER_DUP_FIELDNAME') {
    console.error('Contact messages attachment migration:', err.message);
  }
});

// Ensure feedbacks table exists
const ensureFeedbacksTableSQL = `
  CREATE TABLE IF NOT EXISTS feedbacks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contact_id INT NOT NULL,
    sender_role VARCHAR(32) NULL,
    sender_employee_number VARCHAR(64) NULL,
    sender_name VARCHAR(255) NULL,
    sender_email VARCHAR(255) NULL,
    message TEXT NOT NULL,
    attachment VARCHAR(512) NULL,
    rating TINYINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contact_id (contact_id),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Stores feedback threads for resolved contact tickets';
`;

db.query(ensureFeedbacksTableSQL, (err) => {
  if (err)
    console.error('Failed to ensure feedbacks table exists:', err.message);
  else console.log('Feedbacks table ready');
});

// Ensure feedbacks has rating column
db.query('ALTER TABLE feedbacks ADD COLUMN rating TINYINT NULL', (err) => {
  if (err && err.code !== 'ER_DUP_FIELDNAME') {
    console.error('Feedbacks rating migration:', err.message);
  }
});

// Ensure contact_us status enum includes on_process
const ensureContactStatusEnumSQL = `
  ALTER TABLE contact_us
  MODIFY COLUMN status ENUM('new','on_process','read','replied','resolved')
  NOT NULL DEFAULT 'new'
  COMMENT 'Status of the contact message';
`;
db.query(ensureContactStatusEnumSQL, (err) => {
  if (err && err.code !== 'ER_BAD_FIELD_ERROR') {
    console.error('Contact status enum migration:', err.message);
  }
});

// Ensure working hours rate settings exist (only editable source rates are stored)
const ensureWorkingHoursRatesTableSQL = `
  CREATE TABLE IF NOT EXISTS working_hours_rates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rate_key VARCHAR(20) NOT NULL,
    rate_value VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_rate_key (rate_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

db.query(ensureWorkingHoursRatesTableSQL, (err) => {
  if (err) {
    console.error('Failed to ensure working_hours_rates table exists:', err.message);
  } else {
    console.log('working_hours_rates table ready');

    db.query(
      `INSERT INTO working_hours_rates (rate_key, rate_value)
       VALUES ('hour', '0.125'), ('minute', '0.002')
       ON DUPLICATE KEY UPDATE rate_value = VALUES(rate_value)`,
      (seedErr) => {
        if (seedErr) {
          console.error('working_hours_rates seed migration:', seedErr.message);
        }
      },
    );
  }
});

// existing routes
app.use('/ChildrenRoute', childrenRouter);
app.use('/VoluntaryRoute', VoluntaryWork);
app.use('/eligibilityRoute', EligibilityRoute);
app.use('/college', CollegeRoute);
app.use('/GraduateRoute', GraduateRoute);
app.use('/vocational', VocationalRoute);
app.use('/personalinfo', PersonalRoute);
app.use('/WorkExperienceRoute', WorkExperienceRoute);
app.use('/OtherInfo', OtherInfo);
app.use('/allData', AllData);
app.use('/attendance', Attendance);
app.use('/SalaryGradeTable', SalaryGradeTable);
app.use('/Remittance', Remittance);
app.use('/leaveRoute', leaveRoutes);
app.use('/SendPayslipRoute', SendPayslip);
app.use('/PayrollRoute', Payroll);
app.use('/PayrollReleasedRoute', PayrollReleased);
app.use('/PayrollExportRoute', PayrollExport);
app.use('/PayrollJORoutes', PayrollJO);
app.use('/EmploymentCategoryRoutes', EmployeeCategory);
app.use('/dashboard-audit', dashboardAuditRoute);
app.use('/', authRoutes);
app.use('/', supervisorRoutes);
app.use('/', passwordRoutes);
app.use('/', settingsRoutes);
// Public routes (login carousel, MFA prefs, FAQs, etc.) — before routers that use router.use(authenticateToken)
app.use('/', holidayRoutes);
app.use('/', announcementsRoutes);
app.use('/', suspensionsRoutes);
app.use('/', settingsExtendedRoutes);
app.use('/', learningRoutes);
app.use('/', userRoutes);
app.use('/', pageRoutes);
app.use('/', officialtimeRoutes);
app.use('/', remittanceRoutes);
app.use('/', itemRoutes);
app.use('/', salaryRoutes);
app.use('/', departmentRoutes);
app.use('/', leaveRoutes);
app.use('/', philhealthRoutes);
app.use('/', profileRoutes);
app.use('/', auditRoutes);
app.use('/', adminActionTrailRoutes);
app.use('/', tasksRoutes);
app.use('/', dashboardRoutes);
app.use('/', notesRoutes);
app.use('/', eventsRoutes);
app.use('/', notificationsRoutes);
app.use('/', reportsRoutes);
app.use('/', confidentialPasswordRoutes);
app.use('/', PayrollFormulas);
app.use('/commutationRoute', commutationRoute);
app.use('/pds-templates', pdsTemplatesRoutes);
app.use('/file201', file201Routes);
app.use('/auto-attendance', AutoAttendance);
app.use('/api/working-hours', workingHoursRoutes);
app.use('/api/service-credits', serviceCreditRoutes);
// Legacy alias (older clients called /api/ot-types)
app.get('/api/ot-types', (req, res, next) => {
  req.url = '/ot-types';
  serviceCreditRoutes(req, res, next);
});
app.use('/api/cto', ctoRoutes);
app.use('/api/', UploadPayroll);
app.use('/api/earnings', earningsRoutes);
app.use('/api/deductions', deductionsRoutes);
app.use('/api/leave-salary-shortfall', leaveSalaryShortfallRoutes);
app.use('/api/attendance-result', attendanceResultRoutes);
app.use('/api/attendance-computation-view-state', attendanceComputationViewStateRoutes);

// ── Serve the production frontend build (retire the server) ──
// Registered AFTER all API routes so existing endpoints keep priority; static
// files only respond when a matching file exists, otherwise fall through.
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_DIST));

// SPA fallback: unmatched GETs that accept HTML return index.html so client-side
// routes (e.g. /attendance) work when the frontend is served by the backend.
app.get('*', (req, res, next) => {
  const p = req.path;
  if (p === '/api' || p.startsWith('/api/') || p.startsWith('/uploads') || p.startsWith('/socket.io')) {
    return next();
  }
  if (!req.accepts('html')) return next();
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err) => {
    if (err) next();
  });
});

const ensureAttendanceResultSQL = `
  CREATE TABLE IF NOT EXISTS attendance_result (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_number VARCHAR(64) NOT NULL,
    result_date DATE NOT NULL,
    source_type VARCHAR(16) NOT NULL COMMENT 'ABSENT | TARDINESS',
    source_key VARCHAR(160) NOT NULL,
    original_hours DECIMAL(14, 6) NOT NULL DEFAULT 0,
    leave_used VARCHAR(32) NOT NULL DEFAULT 'NONE',
    leave_hours_used DECIMAL(14, 6) NOT NULL DEFAULT 0,
    unpaid_hours DECIMAL(14, 6) NOT NULL DEFAULT 0,
    paid_hours DECIMAL(14, 6) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    leave_earning_id INT NULL,
    sc_earning_id INT NULL,
    cto_earning_id INT NULL,
    deduction_decision_log_id INT NULL,
    remarks TEXT NULL,
    processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ar_source_key (source_key),
    KEY idx_ar_emp_date (employee_number, result_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureAttendanceResultSQL, (err) => {
  if (err) {
    console.error('Failed to ensure attendance_result table:', err.message);
  } else {
    console.log('attendance_result table ready');
  }
});

const ensureAttendanceComputationViewStateSQL = `
  CREATE TABLE IF NOT EXISTS attendance_computation_view_state (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_number VARCHAR(64) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    selected_computation_type VARCHAR(128) NOT NULL,
    selected_by VARCHAR(128) NULL,
    selected_at DATETIME NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_acvs_emp_period (employee_number, period_start, period_end)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureAttendanceComputationViewStateSQL, (err) => {
  if (err) {
    console.error('Failed to ensure attendance_computation_view_state table exists:', err.message);
  } else {
    console.log('attendance_computation_view_state table ready');
  }
});

const ensureAttendanceRecordRemarksColumns = [
  `ALTER TABLE attendancerecord ADD COLUMN remarks TEXT NULL COMMENT 'Manual adjustment remarks for this day'`,
  `ALTER TABLE attendancerecord ADD COLUMN autofill_remarks TEXT NULL COMMENT 'Auto-filled adjustment remarks'`,
];
ensureAttendanceRecordRemarksColumns.forEach((sql) => {
  db.query(sql, (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME') {
      console.error('attendancerecord column ensure:', err.message);
    }
  });
});

const ensureOverallDailyLateColumns = [
  `ALTER TABLE overall_attendance_record ADD COLUMN daily_late_undertime JSON NULL COMMENT 'Per-day late/undertime for DTR'`,
  `ALTER TABLE overall_attendance_record ADD COLUMN computation_module_type VARCHAR(64) NULL`,
];
ensureOverallDailyLateColumns.forEach((sql) => {
  db.query(sql, (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME') {
      console.error('overall_attendance_record column ensure:', err.message);
    }
  });
});

// Payroll budget department: optional per-employee override used only by the
// Appendix 33 export so an employee's pay can be charged to another department
// tab while their real department (department_assignment.code) stays unchanged.
const ensureDepartmentAssignmentBudgetCode = [
  `ALTER TABLE department_assignment ADD COLUMN budgetCode VARCHAR(50) NULL COMMENT 'Optional budget department code for payroll export routing' AFTER code`,
];
ensureDepartmentAssignmentBudgetCode.forEach((sql) => {
  db.query(sql, (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME') {
      console.error('department_assignment column ensure:', err.message);
    }
  });
});

// Indexes for lookups every logged-in user triggers (Home notifications,
// device-punch polling). Without them each request scans the whole table,
// which is what makes the app crawl once many users are online at once.
// Skipped when any index already leads with the column (e.g. created by
// migrations/add_concurrency_indexes.sql or an older migration).
const ensureLeadingIndexes = [
  { table: 'notifications', name: 'idx_notifications_emp_id', columns: ['employeeNumber', 'id'] },
  { table: 'attendancerecordinfo', name: 'idx_ari_attendance_datetime', columns: ['AttendanceDateTime'] },
  // Per-employee lookups behind the screens every staff member opens
  // (Home, DTR, Payslip, Leave). Without them each load scans the whole table.
  { table: 'users', name: 'idx_users_employee_number', columns: ['employeeNumber'] },
  { table: 'person_table', name: 'idx_person_table_agency_employee_num', columns: ['agencyEmployeeNum'] },
  { table: 'attendancerecord', name: 'idx_attendancerecord_person_date', columns: ['personID', 'date'] },
  { table: 'officialtime', name: 'idx_officialtime_employee_dates', columns: ['employeeID', 'startDate', 'endDate'] },
  { table: 'leave_request', name: 'idx_leave_request_employee_created', columns: ['employeeNumber', 'created_at'] },
  { table: 'leave_assignment', name: 'idx_leave_assignment_employee_code', columns: ['employeeNumber', 'leave_code'] },
  { table: 'payroll_released', name: 'idx_payroll_released_employee', columns: ['employeeNumber', 'dateReleased'] },
  { table: 'employment_category', name: 'idx_employment_category_employee', columns: ['employeeNumber'] },
  { table: 'transaction_table', name: 'idx_transaction_table_employee', columns: ['employee_id'] },
  { table: 'notes', name: 'idx_notes_employee', columns: ['employee_number', 'created_at'] },
  { table: 'events', name: 'idx_events_employee', columns: ['employee_number', 'created_at'] },
  { table: 'service_credit', name: 'idx_service_credit_employee', columns: ['employeeNumber'] },
  { table: 'cto_credit', name: 'idx_cto_credit_employee', columns: ['employeeNumber'] },
];
ensureLeadingIndexes.forEach(({ table, name, columns }) => {
  db.query(
    `SELECT t.TABLE_NAME AS tableName,
            EXISTS (
              SELECT 1 FROM information_schema.STATISTICS s
              WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME
                AND s.COLUMN_NAME = ? AND s.SEQ_IN_INDEX = 1
            ) AS hasIndex
     FROM information_schema.TABLES t
     WHERE t.TABLE_SCHEMA = DATABASE() AND LOWER(t.TABLE_NAME) = LOWER(?)
       AND t.TABLE_TYPE = 'BASE TABLE'
     LIMIT 1`,
    [columns[0], table],
    (err, rows) => {
      if (err || !rows[0] || Number(rows[0].hasIndex)) return;
      const cols = columns.map((c) => `\`${c}\``).join(', ');
      db.query(`CREATE INDEX ${name} ON \`${rows[0].tableName}\` (${cols})`, (idxErr) => {
        if (idxErr && idxErr.code !== 'ER_DUP_KEYNAME') {
          console.error(`${table}.${columns[0]} index ensure:`, idxErr.message);
        } else if (!idxErr) {
          console.log(`Created index ${name} on ${rows[0].tableName}`);
        }
      });
    },
  );
});

db.query('DROP TABLE IF EXISTS dtr_computed_daily_late', (err) => {
  if (err) {
    console.warn('dtr_computed_daily_late drop (optional):', err.message);
  }
});

const ensureLeaveSalaryShortfallSQL = `
  CREATE TABLE IF NOT EXISTS leave_salary_shortfall (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_number VARCHAR(64) NOT NULL,
    period_year INT NOT NULL,
    period_month INT NOT NULL,
    negative_balance_days DECIMAL(14, 6) NOT NULL COMMENT 'Balance after deduction in days (often negative)',
    shortfall_days DECIMAL(14, 6) NOT NULL,
    shortfall_hours DECIMAL(14, 6) NOT NULL,
    leave_code VARCHAR(32) NOT NULL,
    entry_type VARCHAR(64) NULL,
    leave_earning_id INT NULL,
    remarks TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lss_emp_period (employee_number, period_year, period_month),
    INDEX idx_lss_created (created_at),
    UNIQUE KEY uq_lss_leave_earning (leave_earning_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
db.query(ensureLeaveSalaryShortfallSQL, (err) => {
  if (err) {
    console.error('Failed to ensure leave_salary_shortfall table:', err.message);
  } else {
    console.log('leave_salary_shortfall table ready');
  }
});

// Server startup with Socket.IO
const PORT = process.env.WEB_PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = initializeSocket(server);
startAttendanceRecordInfoSocketApi(io);

// Wire up Socket.IO to route files that use it for real-time events
leaveRoutes.setSocketIO(io);
commutationRoute.setSocketIO(io);

setInterval(expireSupervisorAssignments, 60 * 1000);

// Make io accessible to routes via app.locals
app.locals.io = io;

// Start server - listen on 0.0.0.0 so other devices on the network can connect
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`✓ HTTP Server running on http://${HOST}:${PORT}`);
  console.log(`✓ Socket.IO server ready`);
  console.log(`========================================`);
});

module.exports = { app, server, io };
