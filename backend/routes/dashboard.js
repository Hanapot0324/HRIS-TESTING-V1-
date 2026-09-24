const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { createSharedCache } = require('../utils/concurrency');

/**
 * Admin dashboard aggregates are identical for every admin, and every open
 * HomeAdmin refetches them ~1.5s after each attendance/announcement event.
 * Share one in-flight computation between concurrent callers and reuse it for
 * 1s — shorter than the client's 1.5s debounce, so an event-driven refresh
 * never gets a result computed before the change that triggered it.
 */
const sharedResult = createSharedCache({
  ttlMs: Math.max(0, parseInt(process.env.DASHBOARD_CACHE_TTL_MS || '1000', 10) || 0),
});

// GET Dashboard Statistics
async function computeDashboardStats() {
  const stats = {};

  // Total Employees (person records with employee numbers)
  const [employeeCount] = await db
    .promise()
    .query(
      'SELECT COUNT(DISTINCT agencyEmployeeNum) as total FROM person_table WHERE agencyEmployeeNum IS NOT NULL'
    );
  stats.totalEmployees = employeeCount[0].total;

  // Registered users by role / branch / employment status (UsersList parity)
  try {
    const [userRows] = await db.promise().query(`
      SELECT
        COUNT(*) AS totalUsers,
        SUM(CASE WHEN branch = 0 THEN 1 ELSE 0 END) AS manila,
        SUM(CASE WHEN branch = 1 THEN 1 ELSE 0 END) AS cavite,
        SUM(CASE WHEN branch IS NULL OR (branch <> 0 AND branch <> 1) THEN 1 ELSE 0 END) AS unassignedBranch,
        SUM(CASE WHEN LOWER(role) = 'superadmin' THEN 1 ELSE 0 END) AS superadmin,
        SUM(CASE WHEN LOWER(role) = 'administrator' THEN 1 ELSE 0 END) AS administrator,
        SUM(CASE WHEN LOWER(role) = 'staff' THEN 1 ELSE 0 END) AS staff,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS activeStatus,
        SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) AS inactiveStatus,
        SUM(CASE WHEN status = 'Default' OR status IS NULL OR status = '' THEN 1 ELSE 0 END) AS defaultStatus,
        SUM(CASE WHEN status = 'Resigned' THEN 1 ELSE 0 END) AS resignedStatus,
        SUM(CASE WHEN status = 'Terminated' THEN 1 ELSE 0 END) AS terminatedStatus,
        SUM(CASE WHEN status = 'Retired' THEN 1 ELSE 0 END) AS retiredStatus
      FROM users
    `);
    const u = userRows[0] || {};
    stats.totalUsers = Number(u.totalUsers) || 0;
    stats.manila = Number(u.manila) || 0;
    stats.cavite = Number(u.cavite) || 0;
    stats.unassignedBranch = Number(u.unassignedBranch) || 0;
    stats.superadmin = Number(u.superadmin) || 0;
    stats.administrator = Number(u.administrator) || 0;
    stats.staff = Number(u.staff) || 0;
    stats.activeStatus = Number(u.activeStatus) || 0;
    stats.inactiveStatus = Number(u.inactiveStatus) || 0;
    stats.defaultStatus = Number(u.defaultStatus) || 0;
    stats.resignedStatus = Number(u.resignedStatus) || 0;
    stats.terminatedStatus = Number(u.terminatedStatus) || 0;
    stats.retiredStatus = Number(u.retiredStatus) || 0;
    // Prefer registered users count for the Total Employees KPI when available
    if (stats.totalUsers > 0) {
      stats.totalEmployees = stats.totalUsers;
    }
  } catch (userStatsErr) {
    console.warn('dashboard user stats:', userStatsErr?.message);
    stats.totalUsers = stats.totalEmployees;
    stats.manila = 0;
    stats.cavite = 0;
    stats.unassignedBranch = 0;
    stats.superadmin = 0;
    stats.administrator = 0;
    stats.staff = 0;
    stats.activeStatus = 0;
    stats.inactiveStatus = 0;
    stats.defaultStatus = 0;
    stats.resignedStatus = 0;
    stats.terminatedStatus = 0;
    stats.retiredStatus = 0;
  }

  // Active Users (those who have logged in)
  const [activeUsers] = await db
    .promise()
    .query('SELECT COUNT(*) as total FROM users WHERE role != "admin"');
  stats.activeUsers = activeUsers[0].total;

  // Today's Attendance (Time In records for today)
  const today = new Date().toISOString().split('T')[0];
  const todayStart = new Date(today).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const [attendanceToday] = await db
    .promise()
    .query(
      'SELECT COUNT(DISTINCT PersonID) as total FROM attendancerecordinfo WHERE AttendanceState = 1 AND AttendanceDateTime BETWEEN ? AND ?',
      [todayStart, todayEnd]
    );
  stats.presentToday = attendanceToday[0].total;

  // Pending leave requests needing action (0 = pending review, 1 = awaiting HR)
  const [pendingLeaves] = await db
    .promise()
    .query(
      `SELECT COUNT(*) as total FROM leave_request WHERE CAST(status AS CHAR) IN ('0', '1')`
    );
  stats.pendingLeaves = pendingLeaves[0]?.total || 0;

  // Departments Count
  const [departments] = await db
    .promise()
    .query('SELECT COUNT(*) as total FROM department_table');
  stats.totalDepartments = departments[0].total;

  // Active Announcements (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [announcements] = await db
    .promise()
    .query('SELECT COUNT(*) as total FROM announcements WHERE date >= ?', [
      thirtyDaysAgo.toISOString().split('T')[0],
    ]);
  stats.recentAnnouncements = announcements[0].total;

  // Open contact tickets (new / in progress / read)
  try {
    const [ticketCount] = await db.promise().query(`
      SELECT COUNT(*) AS total FROM contact_us
      WHERE status IN ('new', 'on_process', 'read')
    `);
    stats.openTickets = Number(ticketCount[0]?.total) || 0;
  } catch (ticketErr) {
    console.warn('dashboard open tickets:', ticketErr?.message);
    stats.openTickets = 0;
  }

  return stats;
}

router.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    res.json(await sharedResult('stats', computeDashboardStats));
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

// Get Attendance Overview (for charts)
router.get(
  '/api/dashboard/attendance-overview',
  authenticateToken,
  async (req, res) => {
    try {
      const { days } = req.query;
      const dayCount = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const start = new Date();
      start.setDate(start.getDate() - (dayCount - 1));
      start.setHours(0, 0, 0, 0);

      const rangeStartMs = start.getTime();
      const rangeEndMs = end.getTime();

      const [rows] = await db.promise().query(
        `SELECT DATE(FROM_UNIXTIME(AttendanceDateTime/1000)) AS punchDate,
                COUNT(DISTINCT PersonID) AS count
         FROM attendancerecordinfo
         WHERE AttendanceState = 1
           AND AttendanceDateTime BETWEEN ? AND ?
         GROUP BY punchDate`,
        [rangeStartMs, rangeEndMs],
      );

      const countByDate = new Map(
        (rows || []).map((r) => {
          const d =
            r.punchDate instanceof Date
              ? r.punchDate.toISOString().slice(0, 10)
              : String(r.punchDate).slice(0, 10);
          return [d, Number(r.count) || 0];
        }),
      );

      const data = [];
      for (let i = dayCount - 1; i >= 0; i--) {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        data.push({
          date: dateStr,
          day: date.toLocaleDateString('en-US', { weekday: 'short' }),
          present: countByDate.get(dateStr) || 0,
        });
      }

      res.json(data);
    } catch (error) {
      console.error('Error fetching attendance overview:', error);
      res.status(500).json({ error: 'Failed to fetch attendance overview' });
    }
  }
);

// Get Department Distribution
router.get(
  '/api/dashboard/department-distribution',
  authenticateToken,
  async (req, res) => {
    try {
      const [results] = await db.promise().query(`
      SELECT 
        dt.description as department,
        dt.code,
        COUNT(DISTINCT da.employeeNumber) as employeeCount
      FROM department_table dt
      LEFT JOIN department_assignment da ON dt.code = da.code
      GROUP BY dt.code, dt.description
      ORDER BY employeeCount DESC
    `);

      res.json(results);
    } catch (error) {
      console.error('Error fetching department distribution:', error);
      res
        .status(500)
        .json({ error: 'Failed to fetch department distribution' });
    }
  }
);

// Get Leave Statistics (numeric: 0 pending, 1 supervisor, 2 HR approved, 3 denied)
router.get('/api/dashboard/leave-stats', authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(`
      SELECT
        SUM(CASE WHEN CAST(status AS CHAR) = '0' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN CAST(status AS CHAR) = '1' THEN 1 ELSE 0 END) AS supervisor,
        SUM(CASE WHEN CAST(status AS CHAR) = '2' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN CAST(status AS CHAR) = '3' THEN 1 ELSE 0 END) AS rejected
      FROM leave_request
    `);
    const r = rows[0] || {};
    const pending = Number(r.pending) || 0;
    const supervisor = Number(r.supervisor) || 0;
    const approved = Number(r.approved) || 0;
    const rejected = Number(r.rejected) || 0;
    res.json({
      pending,
      supervisor,
      approved,
      rejected,
      needsAction: pending + supervisor,
      total: pending + supervisor + approved + rejected,
    });
  } catch (error) {
    console.error('Error fetching leave stats:', error);
    res.status(500).json({ error: 'Failed to fetch leave statistics' });
  }
});

/** Admin home: actionable queue counts + recent pending leave rows. */
router.get('/api/dashboard/admin-queue', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);

    const [leaveCounts] = await db.promise().query(`
      SELECT
        SUM(CASE WHEN CAST(status AS CHAR) = '0' THEN 1 ELSE 0 END) AS pendingReview,
        SUM(CASE WHEN CAST(status AS CHAR) = '1' THEN 1 ELSE 0 END) AS awaitingHr
      FROM leave_request
    `);

    const [pendingLeaves] = await db.promise().query(
      `
      SELECT lr.id, lr.employeeNumber, lr.leave_code, lr.status,
        lt.leave_description,
        CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension) AS fullName,
        DATE_FORMAT(lr.leave_date, '%Y-%m-%d') AS leave_date,
        DATE_FORMAT(lr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM leave_request lr
      LEFT JOIN leave_table lt ON lr.leave_code = lt.leave_code
      LEFT JOIN person_table p ON lr.employeeNumber = p.agencyEmployeeNum
      WHERE CAST(lr.status AS CHAR) IN ('0', '1')
      ORDER BY lr.created_at DESC
      LIMIT ?
    `,
      [limit],
    );

    let openTickets = 0;
    let recentTickets = [];
    try {
      const [ticketCount] = await db.promise().query(`
        SELECT COUNT(*) AS total FROM contact_us
        WHERE status IN ('new', 'on_process', 'read')
      `);
      openTickets = Number(ticketCount[0]?.total) || 0;
      const [tickets] = await db.promise().query(`
        SELECT id, name, subject, status, created_at, employee_number
        FROM contact_us
        WHERE status IN ('new', 'on_process', 'read')
        ORDER BY created_at DESC
        LIMIT 5
      `);
      recentTickets = tickets || [];
    } catch (ticketErr) {
      console.warn('admin-queue tickets:', ticketErr?.message);
    }

    let pendingPayroll = 0;
    let processedPayroll = 0;
    let latestPeriod = null;
    try {
      const [pending] = await db
        .promise()
        .query(
          'SELECT COUNT(*) AS count FROM payroll_processing WHERE status = 0',
        );
      const [processed] = await db
        .promise()
        .query(
          'SELECT COUNT(*) AS count FROM payroll_processing WHERE status = 1',
        );
      const [period] = await db.promise().query(`
        SELECT startDate, endDate, COUNT(*) AS employeeCount
        FROM payroll_processing
        GROUP BY startDate, endDate
        ORDER BY startDate DESC
        LIMIT 1
      `);
      pendingPayroll = Number(pending[0]?.count) || 0;
      processedPayroll = Number(processed[0]?.count) || 0;
      latestPeriod = period[0] || null;
    } catch (payErr) {
      console.warn('admin-queue payroll:', payErr?.message);
    }

    const pendingReview = Number(leaveCounts[0]?.pendingReview) || 0;
    const awaitingHr = Number(leaveCounts[0]?.awaitingHr) || 0;

    res.json({
      pendingReview,
      awaitingHr,
      leaveNeedsAction: pendingReview + awaitingHr,
      openTickets,
      pendingPayroll,
      processedPayroll,
      latestPeriod,
      pendingLeaves: pendingLeaves || [],
      recentTickets,
    });
  } catch (error) {
    console.error('Error fetching admin queue:', error);
    res.status(500).json({ error: 'Failed to fetch admin queue' });
  }
});

// Get Recent Activities (Audit Log Summary)
router.get(
  '/api/dashboard/recent-activities',
  authenticateToken,
  async (req, res) => {
    try {
      const { limit = 10 } = req.query;

      const [activities] = await db.promise().query(
        `
      SELECT 
        al.action,
        al.table_name,
        al.timestamp,
        al.employeeNumber,
        CONCAT(pt.firstName, ' ', COALESCE(pt.lastName, '')) as userName
      FROM audit_log al
      LEFT JOIN person_table pt ON al.employeeNumber = pt.agencyEmployeeNum
      ORDER BY al.timestamp DESC
      LIMIT ?
    `,
        [parseInt(limit)]
      );

      res.json(activities);
    } catch (error) {
      console.error('Error fetching recent activities:', error);
      res.status(500).json({ error: 'Failed to fetch recent activities' });
    }
  }
);

// Get Payroll Summary
router.get(
  '/api/dashboard/payroll-summary',
  authenticateToken,
  async (req, res) => {
    try {
      res.json(await sharedResult('payroll-summary', computePayrollSummary));
    } catch (error) {
      console.error('Error fetching payroll summary:', error);
      res.status(500).json({ error: 'Failed to fetch payroll summary' });
    }
  }
);

async function computePayrollSummary() {
  const [totalProcessed] = await db
    .promise()
    .query(
      'SELECT COUNT(*) as count FROM payroll_processing WHERE status = 1'
    );

  const [totalPending] = await db
    .promise()
    .query(
      'SELECT COUNT(*) as count FROM payroll_processing WHERE status = 0'
    );

  const [latestPayroll] = await db.promise().query(`
  SELECT startDate, endDate, COUNT(*) as employeeCount 
  FROM payroll_processing 
  GROUP BY startDate, endDate 
  ORDER BY startDate DESC 
  LIMIT 1
    `);

  return {
    processed: totalProcessed[0]?.count || 0,
    pending: totalPending[0]?.count || 0,
    latestPeriod: latestPayroll[0] || null,
  };
}

// Get Monthly Attendance Trend
router.get(
  '/api/dashboard/monthly-attendance',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        year = new Date().getFullYear(),
        month = new Date().getMonth() + 1,
      } = req.query;

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);
      const daysInMonth = endDate.getDate();

      // Single grouped query for the whole month instead of one round-trip per day.
      const rangeStart = startDate.getTime();
      const rangeEnd = new Date(year, month, 1).getTime();

      const [rows] = await sharedResult(`monthly-attendance:${rangeStart}:${rangeEnd}`, () =>
        db
          .promise()
          .query(
            `SELECT FLOOR((AttendanceDateTime - ?) / 86400000) AS dayIdx,
                    COUNT(DISTINCT PersonID) AS count
             FROM attendancerecordinfo
             WHERE AttendanceState = 1
               AND AttendanceDateTime >= ? AND AttendanceDateTime < ?
             GROUP BY dayIdx`,
            [rangeStart, rangeStart, rangeEnd]
          ),
      );

      const countByIndex = new Map(
        (rows || []).map((r) => [Number(r.dayIdx), Number(r.count) || 0]),
      );

      const data = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, month - 1, day);
        data.push({
          day: day,
          date: currentDate.toISOString().split('T')[0],
          present: countByIndex.get(day - 1) || 0,
        });
      }

      res.json(data);
    } catch (error) {
      console.error('Error fetching monthly attendance:', error);
      res.status(500).json({ error: 'Failed to fetch monthly attendance' });
    }
  }
);

// Get Employee Growth Trend (last 6 months)
router.get(
  '/api/dashboard/employee-growth',
  authenticateToken,
  async (req, res) => {
    try {
      // Build the 6 month cutoffs once, then count them all in a single query
      const cutoffs = [];
      for (let i = 5; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        date.setDate(1); // First day of month

        cutoffs.push({
          month: date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
          }),
          cutoff: date.toISOString(),
        });
      }

      const sums = cutoffs
        .map((_, idx) => `SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END) AS c${idx}`)
        .join(', ');
      const params = cutoffs.map((c) => c.cutoff);

      const [result] = await db
        .promise()
        .query(`SELECT ${sums} FROM users`, params);
      const counts = result[0] || {};

      const data = cutoffs.map((c, idx) => ({
        month: c.month,
        total: Number(counts[`c${idx}`]) || 0,
      }));

      res.json(data);
    } catch (error) {
      console.error('Error fetching employee growth:', error);
      res.status(500).json({ error: 'Failed to fetch employee growth data' });
    }
  }
);

// Get Quick Stats for specific employee (for user dashboard)
router.get(
  '/api/dashboard/employee-stats/:employeeNumber',
  authenticateToken,
  async (req, res) => {
    try {
      const { employeeNumber } = req.params;
      const stats = {};

      // Total attendance days this month
      const currentMonth = new Date();
      const monthStart = new Date(
        currentMonth.getFullYear(),
        currentMonth.getMonth(),
        1
      );
      const monthStartTimestamp = monthStart.getTime();
      const monthEndTimestamp = new Date().getTime();

      const [attendanceCount] = await db
        .promise()
        .query(
          'SELECT COUNT(DISTINCT DATE(FROM_UNIXTIME(AttendanceDateTime/1000))) as days FROM attendancerecordinfo WHERE PersonID = ? AND AttendanceState = 1 AND AttendanceDateTime BETWEEN ? AND ?',
          [employeeNumber, monthStartTimestamp, monthEndTimestamp]
        );
      stats.attendanceDaysThisMonth = attendanceCount[0].days;

      // Leave balance
      const [leaveBalance] = await db
        .promise()
        .query(
          'SELECT SUM(noOfLeaves) as total FROM leave_assignment WHERE employeeID = ?',
          [employeeNumber]
        );
      stats.leaveBalance = leaveBalance[0]?.total || 0;

      // Pending leave requests
      const [pendingLeaves] = await db
        .promise()
        .query(
          'SELECT COUNT(*) as count FROM leave_request WHERE employeeNumber = ? AND LOWER(status) = "pending"',
          [employeeNumber]
        );
      stats.pendingLeaveRequests = pendingLeaves[0]?.count || 0;

      // Last payroll
      const [lastPayroll] = await db
        .promise()
        .query(
          'SELECT pay1st, pay2nd, startDate, endDate FROM payroll_processed WHERE employeeNumber = ? ORDER BY dateCreated DESC LIMIT 1',
          [employeeNumber]
        );
      stats.lastPayroll = lastPayroll[0] || null;

      res.json(stats);
    } catch (error) {
      console.error('Error fetching employee stats:', error);
      res.status(500).json({ error: 'Failed to fetch employee statistics' });
    }
  }
);

module.exports = router;




