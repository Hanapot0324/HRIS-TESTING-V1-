# Backend Diagnosis and Fix Plan

Complete backend diagnosis for the HRIS system:

- **Part A:** problems already **fixed** in PR #1 (what was wrong, where, what was done, measured result)
- **Part B:** problems still **open**, in priority order (where to find them and the safest, simplest fix)
- **Part C:** what's needed to serve **5,000+ employees at the same time**

Line numbers refer to the PR branch (`claude/gracious-mccarthy-guvu4f`).

## How the diagnosis was done

- **Test database:** MariaDB rebuilt from the code (the repo has no schema) with realistic volume:
  5,000 employees, 600k notifications, 600k device punches, 300k DTR rows, 240k released payslips,
  70k official-time rows, 50k leave requests. The repo's own index migrations were applied.
- **Load tests:** 100–200 simultaneous staff and 50 simultaneous admins, before and after each fix.
- **Endpoint pass:** all 253 read endpoints across the 63 backend route files called one by one,
  with every query captured and checked with `EXPLAIN` and MySQL 8 strict mode.
- **Code scans:** every query in every backend file checked for queries in loops, non-indexable
  comparisons, whole-table reads, blocking work and crash-prone error handling.
- **Regression checks:** each changed endpoint's response compared with the previous version on the
  same data; all 531 routes checked for access control before and after.

---

# Part A: Diagnosed and fixed (PR #1)

## Overall result (200 staff opening screens at the same time)

| | Before | After |
|---|---|---|
| Screen loads per second | 74 | 457 |
| Typical (p50) screen load | 2.4 s | 0.31 s |
| Slow (p95) screen load | 5.0 s | 0.9 s |

## A1. Staff blocked from their own pages (403) and repeated login checks
- **Where:** `backend/routes/remittance.js`, `department.js`, `item.js`, `salary.js`, `tasks.js`,
  `leave.js` (each had `router.use(authenticateToken, requireAdmin)` while mounted at `/` in `index.js`)
- **Problem:** the admin-only check ran on **every** request passing through these routers, so staff
  got 403 on notifications, dashboard, notes, events and their own leave and earnings. Each request
  also re-checked the login token up to 7 times.
- **Fix:** each router's check now applies only to its own paths (e.g.
  `router.use('/employee-remittance', authenticateToken, requireAdmin)`). `GET /ot-types` in
  `routes/serviceCredit.js` got its own `authenticateToken`, since it had relied on the old behaviour.
- **Result:** staff pages work. All 531 routes tested without login: **0 became less protected**.

## A2. Notifications read the whole table on every Home page load
- **Where:** `backend/routes/notifications.js`, `fetchNotificationsForEmployee()`
- **Problem:** `WHERE CAST(employeeNumber AS CHAR) = ?` cannot use an index, so every Home load and
  every realtime refresh scanned all notifications.
- **Fix:** `WHERE employeeNumber IN (?, ?)` plus an index on `notifications(employeeNumber, id)`,
  created at startup if missing.
- **Result:** 100 simultaneous users: **26 → 1,505 requests/s; 3.6 s → 65 ms**.

## A3. Announcement / holiday / suspension notifications lost, other users got errors
- **Where:** `backend/routes/announcements.js`, `routes/holiday.js`, `routes/suspensions.js`; new
  helper `backend/utils/notificationFanout.js`
- **Problem:** one INSERT per employee, all fired at the same moment. That overflowed the database
  connection queue: most notifications were silently lost and other users' requests failed.
- **Fix:** `insertNotificationsBulk()` inserts in chunks of 500 rows, one chunk at a time, keeping
  the old column fallbacks for older tables.
- **Result:** **212 of 5,000 saved → all 5,000 saved**, 0 errors for other users.

## A4. Bulk registration crashed the server
- **Where:** `backend/routes/users.js`, `POST /excel-register`; new helper `backend/utils/concurrency.js`
- **Problem:** every row was processed at once with blocking password hashing (`bcrypt.hashSync`).
  The page-access inserts had no error callback, so when the queue overflowed the whole server crashed.
- **Fix:** 5 rows at a time (`mapWithConcurrency`), async `bcrypt.hash`, one multi-row page-access
  insert per user, and error callbacks on every background query.
- **Result:** **300-row upload crashed the server every time → 300/300 registered**, other users served.

## A5. Supervisor-expiry job (runs every 60 s) loaded the database heavily
- **Where:** `backend/utils/supervisorPageAccess.js`, `sendSupervisorAssignmentNotice()`
- **Problem:** the duplicate-notice check used `CAST(employeeNumber AS CHAR)`, scanning all
  notifications once per expiring assignment, every minute.
- **Fix:** `WHERE employeeNumber = ?` (indexed).
- **Result:** **~14 s → ~70 ms** of database time per run.

## A6. Admin dashboard recomputed for every admin on every event
- **Where:** `backend/routes/dashboard.js` (`/api/dashboard/stats`, `payroll-summary`,
  `monthly-attendance`); helper `backend/utils/concurrency.js` (`createSharedCache`)
- **Problem:** every open admin dashboard re-ran the same 8 aggregate queries after each attendance
  event.
- **Fix:** admins asking at the same moment share one result, reused for 1 s (shorter than the
  screen's 1.5 s refresh delay, so results are never stale).
- **Result:** 50 simultaneous admins: **102 → 2,170 requests/s; 478 ms → 21 ms**.

## A7. Login-check cache too small
- **Where:** `backend/middleware/auth.js`, `enrichUserFromDb()`
- **Problem:** the cache held only 2,000 users, so with more users online it kept emptying and hit
  the database on almost every request. A page firing several requests looked the user up several times.
- **Fix:** holds 20,000 users (`AUTH_ENRICH_MAX_ENTRIES`), and simultaneous lookups for the same
  user share one database query.

## A8. Employee-number lookup scanned all users
- **Where:** `backend/utils/supervisorPageAccess.js`, `resolveCanonicalEmployeeNumber()`
- **Problem:** a full-table `REGEXP` comparison on every cache miss.
- **Fix:** try an exact indexed match first; fall back to the old comparison only if needed.

## A9. Connection queue too small
- **Where:** `backend/db.js`
- **Problem:** a limit of 200 waiting queries turned normal bursts into "Queue limit reached" errors.
- **Fix:** default raised to 1,000 (still configurable with `DB_QUEUE_LIMIT`).

## A10. My Attendance slow for every employee
- **Where:** `backend/dashboardRoutes/Attendance.js`, `GET /api/attendance` (leave-gap query)
- **Problem:** four `CAST(x AS CHAR) = CAST(lr.employeeNumber AS CHAR)` comparisons scanned users,
  leave requests and official time on each load.
- **Fix:** compare each column directly to the requested employee number (bound parameter).
- **Result:** **4.9 s → 0.85 s** under 200 users (**5–8 ms** on its own); responses identical.

## A11. DTR slow because of "modified by" name lookups
- **Where:** `backend/dashboardRoutes/Attendance.js`, `attachModifierNames()`; used by
  `POST /api/view-attendance`, `POST /api/view-attendance-full` and the special-rows batch
- **Problem:** three `CAST` joins on person and user tables took about 90% of the DTR query time,
  even though almost no rows are modified.
- **Fix:** names are looked up afterwards with two indexed `IN (...)` queries, only for modified rows,
  with the same name rules as before.
- **Result:** DTR query **84 ms → under 10 ms**; **2.8 s → 0.32 s** under load; responses identical.

## A12. Staff payslips scanned all payroll history
- **Where:** `backend/payrollRoutes/PayrollReleased.js`, `GET /released-payroll-detailed` (staff path)
- **Problem:** `WHERE CAST(pr.employeeNumber AS CHAR) = ?` and a `CAST` join to employment categories.
- **Fix:** direct comparisons with the employee number; index on `payroll_released(employeeNumber, dateReleased)`.
- **Result:** Home / Payslip **2.7 s → 0.30 s** under load.

## A13. Admin payslip view never finished
- **Where:** `backend/payrollRoutes/PayrollReleased.js` (admin path); new helper
  `backend/utils/employmentCategoryMerge.js`
- **Problem:** every payslip was compared with every employment-category row
  (`CAST(...) = CAST(...)` on both sides).
- **Fix:** categories are loaded once and matched in the backend code, with the same matching rules.
- **Result:** **over 60 s (never finished) → 3.3 s**.

## A14. Payroll Processed slow and showed duplicate rows
- **Where:** `backend/payrollRoutes/Payroll.js`, `GET /payroll-processed`
- **Problem:** same row × category join; an employee with two category rows appeared twice.
- **Fix:** same `attachEmploymentCategories()` merge.
- **Result:** faster, and no duplicated payroll rows.

## A15. Supervisor leave list read all leave requests 3 times per employee
- **Where:** `backend/routes/supervisor.js`, `GET /api/supervisor-leave/employees/:supervisorEmployeeNumber`
- **Problem:** three correlated `COUNT` subqueries per department employee, each scanning all leave requests.
- **Fix:** one grouped count (`GROUP BY employeeNumber, status`) for the department's employees.
- **Result:** identical counts; one indexed query instead of millions of row reads.

## A16. Leave deduction lookups scanned all users
- **Where:** `backend/routes/leave.js`, `fetchLeaveDeductionMeta()`;
  `backend/services/deductionPolicyService.js`, `fetchLeaveDeductionMeta()` and `getEmploymentTypeIdForEmployee()`
- **Problem:** `CAST` comparisons on every leave deduction, including inside bulk loops.
- **Fix:** bound parameters; indexed. Results identical.

## A17. Missing per-employee indexes
- **Where:** `backend/index.js` (`ensureLeadingIndexes`), `backend/migrations/add_concurrency_indexes.sql`
- **Problem:** the lookups behind Home, DTR, Payslip and Leave had no index to use.
- **Fix:** 15 indexes created at startup only if missing: `notifications`, `attendancerecordinfo`,
  `users`, `person_table`, `attendancerecord`, `officialtime`, `leave_request`, `leave_assignment`,
  `payroll_released`, `employment_category`, `transaction_table`, `notes`, `events`, `service_credit`, `cto_credit`.
- **Result:** staff Leave / notes / events **~1.6 s → 0.30 s** under load.

## A18. Admin Home downloaded every payslip just to count them
- **Where:** `backend/routes/dashboard.js`, `computePayrollSummary()` (and the Admin Home screen)
- **Problem:** about 60 MB downloaded on every dashboard refresh to take its length.
- **Fix:** `payroll-summary` now returns a `released` count.

## A19. Admin screens sent one name request per employee
- **Where:** `backend/payrollRoutes/Remittance.js`, new `POST /Remittance/employees/lookup`
  (admin only); used by PDS sections, Leave Request, Department Assignment and Item Table
- **Problem:** thousands of requests per page load.
- **Fix:** one batch request per 1,000 employees; same fields as the single lookup.

## A20. DTR downloaded all employment categories, then audited every load
- **Where:** `backend/dashboardRoutes/EmployeeCategory.js`, `GET /employment-category/:employeeNumber`
  (and the DTR screen)
- **Problem:** each DTR load downloaded all 5,000 categories (1 MB) to find one. After switching to
  the single-employee endpoint, that endpoint wrote an audit row on every view.
- **Fix:** DTR fetches only the employee's own row; own-record lookups are not audited (viewing
  someone else's record still is).

## Frontend changes that support these fixes (for completeness)
- Notification refreshes after a broadcast are combined and spread over ~3 s (`Home.jsx`, `HomeAdmin.jsx`).
- Batch name lookup helper `frontend/src/utils/employeeLookup.js`.
- DTR fetches only its own employment category (`DailyTimeRecord.jsx`).

---

# Part B: Still open (priority order)

## Priority 1: the server can crash (fix before anything else)

With 5,000 people online, one crash logs everyone out. These must be fixed first.

### 1. Check Attendance crashes the whole server
- **Where:** `backend/dashboardRoutes/Attendance.js`, line 731 (`GET /api/check-attendance`)
- **Problem:** the SQL uses `AS exists`, a reserved word, so the query always fails. The next
  line, `if (err) throw err;`, then kills the process. Reproduced in testing.
- **Solution:**
  ```js
  const sql = `SELECT EXISTS(SELECT 1 FROM attendancerecord WHERE personID = ? AND date = ?) AS record_exists`;
  db.query(sql, [personID, date], (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to check attendance' });
    res.json({ exists: results[0].record_exists });   // same field name the screens read
  });
  ```

### 2. Public Settings endpoint can crash the server
- **Where:** `backend/routes/settings.js`, lines 349, 376, 389, 397 (`GET` and `POST /api/settings`).
  The GET needs **no login**.
- **Problem:** `if (err) throw err;` inside database callbacks. Any database hiccup lets any
  visitor take the server down.
- **Solution:** replace each with
  `if (err) return res.status(500).json({ error: 'Settings unavailable' });`

### 3. 17 async handlers crash the server on one database error
- **Where:**
  - `routes/officialtime.js`: 11 handlers (e.g. line 1475 `POST /officialtimetable`, all
    `upload-excel-*` routes, `bulk-schedules`, and the PUT/DELETE of `/officialtimetable/:employeeID`)
  - `payrollRoutes/Payroll.js`: lines 959 and 1075
  - `payrollRoutes/UploadPayroll.js`: line 183
  - `routes/leave.js`: line 3668
  - `routes/serviceCredit.js`: line 271
  - `routes/ctoRoutes.js`: line 244
- **Problem:** on Node 22, an `await` that fails outside `try/catch` stops the process, and
  Express 4 doesn't catch it.
- **Solution (easiest):** wrap each handler with a small helper so errors become a 500 response:
  ```js
  // backend/utils/asyncHandler.js
  module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  ```
  Then use `router.post('/x', authenticateToken, asyncHandler(async (req, res) => { ... }))`.
- **Safety net:** add this to `backend/index.js`:
  ```js
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
  ```

---

## Priority 2: features that are broken

### 4. Realtime updates don't arrive
- **Where:**
  - `backend/socket/socketService.js`, line 1 (`const { getIO } = require('./socketServer')`)
  - `socket/socketServer.js`, line 3 (imports `middleware/auth`)
  - `middleware/auth.js`, line 27 (imports `socketService`)
- **Problem:** these three files import each other in a circle, so `getIO` is undefined. Every
  notification, announcement and payroll live update fails with `getIO is not a function`.
  This was already broken before the PR changes.
- **Solution (easiest):** look `getIO` up only when it's used:
  ```js
  // socketService.js — replace line 1
  const getIO = () => require('./socketServer').getIO();
  ```

### 5. Supervisor page-access update throws an error
- **Where:** `backend/utils/supervisorPageAccess.js`, lines 298 and 308
- **Problem:** it calls `socketService.notifyPageAccessGranted(...)`, but that file never defines
  `socketService`.
- **Solution:** import `notifyPageAccessGranted` and `notifyPageAccessRevoked` from
  `../socket/socketService` at the top of the file, and call them directly.

---

## Priority 3: slow or oversized endpoints (these hurt most with 5,000 users)

### 6. Audit Logs page downloads the entire audit log
- **Where:** `backend/routes/audit.js`, line 52. The table is created at `backend/index.js`,
  line 144, with no index on `timestamp`.
- **Problem:** there's no `LIMIT`. With 5,000 employees writing audit rows daily, this page gets
  slower every day and eventually times out.
- **Solution:**
  ```sql
  CREATE INDEX idx_audit_log_timestamp ON audit_log (timestamp);
  ```
  Then add `LIMIT ? OFFSET ?` to the query (for example 100 rows per page) and page through it
  on the screen. Also archive rows older than 1–2 years.

### 7. An unused endpoint returns 123 MB to any logged-in user
- **Where:** `backend/dashboardRoutes/Attendance.js`, line 1418 (`POST /api/view-attendance-all-users`)
- **Problem:** it took 8.3 s and returned 123 MB in testing. No screen calls it (they use
  `-paged`), but anyone logged in can, which ties up the server.
- **Solution (safest):** delete the route. If it's needed, add `requireAdmin` and force a maximum
  date range plus paging.

### 8. Device Insights endpoints take 3–15 seconds
- **Where:** `backend/dashboardRoutes/Attendance.js`, lines 2621, 2719, 2788 and 2833
  (`device-attendance-summary`, `device-punch-insights`, `device-insights-bundle`,
  `device-attendance-list`)
- **Problem:** they group all device punches (600k+) before filtering by date.
- **Solution:**
  1. Put `WHERE AttendanceDateTime BETWEEN ? AND ?` inside the inner query, so the existing
     date index is used.
  2. Cache results for 60–90 s, the way `all-device-users` already does.

### 9. Supervisor leave requests take 4.3 s per page load
- **Where:** `backend/routes/supervisor.js`, line 532
- **Problem:** `TRIM(CAST(da.employeeNumber AS CHAR)) = TRIM(CAST(lr.employeeNumber AS CHAR))`
  stops index use, so every supervisor page load reads all leave requests.
- **Solution:** first `SELECT employeeNumber FROM department_assignment WHERE code IN (?)`, then
  `... FROM leave_request lr WHERE lr.employeeNumber IN (?)`.

### 10. Admin lists return whole tables (12–66 MB)
- **Where:**
  - `routes/leave.js`, lines 1963 (`/leave_request`) and 1351 (`/leave_assignment`)
  - `payrollRoutes/PayrollReleased.js`, lines 13 and 31
  - `routes/earningsRoutes.js`, lines 2602 and 3393 (`/sc/all`, `/cto/all`)
- **Problem:** each admin page load transfers and renders tens of MB. It grows every payroll period.
- **Solution:** server-side paging, e.g. `?page=1&limit=100` → `LIMIT ? OFFSET ?`, plus
  period/date filters. Paging must also be added to those screens in the frontend.

### 11. Attendance report runs 38 queries one after another
- **Where:** `backend/routes/reports.js`, line 325 (`generateAttendanceReport`)
- **Solution:** replace the day-by-day loop with a single grouped query, the same one already
  used in `routes/dashboard.js` (`monthly-attendance`).

### 12. Payroll Processing has a slow join
- **Where:** `backend/payrollRoutes/Payroll.js`, lines 130 and 301
  (`LEFT JOIN employment_category ec ON CAST(...) = CAST(...)`)
- **Solution:** remove that join and call `attachEmploymentCategories(rows, ...)` from
  `utils/employmentCategoryMerge.js`, the same fix already applied to Payroll Processed.

### 13. Add Rendered Time runs about 35,000 queries for 5,000 employees
- **Where:** `backend/payrollRoutes/Payroll.js`, line 733
- **Problem:** 7 queries per employee, one after another.
- **Solution:** load each lookup once for all employees (`WHERE employeeNumber IN (?)`), then do
  one multi-row insert or upsert per chunk of 500.

### 14. Payroll Export availability check takes 5.3 s
- **Where:** `backend/payrollRoutes/PayrollExport.js`, line 236
- **Solution:** cache the result per payroll period (it only changes when payroll is processed).

---

## Priority 4: uploads and heavy work that freeze everyone

### 15. Excel imports block the server
- **Where:**
  - `routes/officialtime.js`, line 994
  - `payrollRoutes/UploadPayroll.js`, line 150
  - `payrollRoutes/SalaryGradeTable.js`
  - `dashboardRoutes/Voluntary.js`, line 110
- **Problem:** parsing is synchronous. A 5,000-row file froze the server for about 0.5 s for
  **every** user, and bigger files take longer.
- **Solution (easiest):** parse the file in a worker thread using Node's built-in
  `worker_threads`, then insert in chunks of 500 rows with one multi-row `INSERT ... VALUES ?`.

### 16. Uploads with no size limit
- **Where:** `payrollRoutes/SalaryGradeTable.js`, line 9, and `payrollRoutes/SendPayslip.js`,
  line 11 (`multer.memoryStorage()`)
- **Solution:**
  `multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })`

### 17. Bulk payslip email sending runs inside one HTTP request
- **Where:** `backend/payrollRoutes/SendPayslip.js` (`POST /send-bulk`)
- **Problem:** 5,000 emails in one request will time out.
- **Solution:** save the job and send in the background in batches. Let the screen poll for progress.

### 18. 50 MB JSON limit on every route
- **Where:** `backend/index.js`, lines 135–137
- **Solution:** set the default to `'1mb'`, and apply `'50mb'` only on the bulk-upload routes.

---

## Priority 5: data safety when many people act at once

### 19. Service Credit / CTO balance can lose an update
- **Where:** `utils/serviceCreditBalanceUtils.js`, line 517, and `utils/ctoBalanceUtils.js`, line 476
- **Problem:** the new value is computed in JavaScript and written back, so two simultaneous
  undo actions overwrite each other.
- **Solution:**
  ```sql
  UPDATE service_credit SET used_hours = GREATEST(0, used_hours - ?) WHERE id = ?
  ```
  Do the same for `cto_credit`.

---

## Priority 6: security and login (also needed before adding servers)

### 20. 2FA does not actually check the code
- **Where:** `backend/routes/auth.js`, line 205 (`POST /complete-2fa-login`)
- **Problem:** it issues a login token without verifying the 2FA code.
- **Solution:** check the stored code and its expiry inside `complete-2fa-login` itself, and
  delete it after one use.

### 21. Login and password codes are kept in server memory
- **Where:** `routes/auth.js`, line 133, and `routes/password.js`, lines 82 and 291
- **Problem:** a restart loses all pending codes, and with more than one server the code isn't found.
- **Solution:** a table `auth_codes(email, purpose, code_hash, expires_at)`. Store a **hash** of
  the code, not the code itself.

### 22. Random JWT secret if `.env` isn't found
- **Where:** `middleware/auth.js`, line 16; `.env` is loaded at `index.js`, line 6, and `db.js`, line 3
- **Solution:**
  - Load the file from a fixed path:
    `require('dotenv').config({ path: require('path').join(__dirname, '.env') })`.
  - Stop the server if `JWT_SECRET` is missing in production.
  - Move secrets out of the committed `backend/.env`, and change the passwords that were committed.

### 23. Vulnerable and unused packages
- **Where:** `backend/package.json`
- **Solution:**
  1. Run `npm audit fix`; this clears most of the 17 (12 high).
  2. Replace `xlsx` 0.18.5 with SheetJS's own build.
  3. Remove the unused packages: `expres`, `vite`, `express-fileupload`, `moment`,
     `moment-timezone`, `node-fetch`, `@google/generative-ai`.

### 24. Duplicate login check
- **Where:** `backend/dashboardRoutes/EmployeeCategory.js`, line 8
- **Solution:** use the shared `authenticateToken` from `middleware/auth.js`.

---

## Priority 7: compatibility

### 25. One table spelled two ways
- **Where:** 45 places use `AttendanceRecordInfo` (e.g. `dashboardRoutes/Attendance.js`, line 796;
  `socket/attendanceRecordInfoSocketApi.js`, line 43); others use `attendancerecordinfo`
- **Problem:** Windows ignores the difference, but a Linux MySQL server treats them as two
  different tables.
- **Solution:** use one spelling everywhere (lowercase), or set `lower_case_table_names=1` when
  installing the Linux database.

### 26. No timezone set
- **Where:** `backend/db.js`, line 31
- **Solution:** add `timezone: '+08:00'` to the pool and set the database `time_zone='+08:00'`.

### 27. Startup runs about 40 schema changes every boot
- **Where:** `backend/index.js` (the `ALTER TABLE` / `CREATE TABLE` blocks)
- **Solution:** move them into `backend/migrations/` and run them once per release.

---

# Part C: What's needed for 5,000+ simultaneous employees

Tested capacity so far: **one Node process handled 457 screen loads per second** with 200 users
clicking nonstop (no pauses between clicks). Real users pause between clicks, so this covers
roughly a few thousand active users. It's close to the limit for 5,000 all acting at once, such
as at clock-in time or payslip release.

To get safely above that, in this order:

1. **Fix Priorities 1–3 above.** A single crash or a 123 MB response undoes any added capacity.
2. **Use every CPU core:** run the backend with PM2 in cluster mode (e.g. `pm2 start index.js -i 4`).
   That gives about 4× capacity on a 4-core server.
3. **Before step 2, three things must be in place:**
   - Realtime updates across processes: add `@socket.io/cluster-adapter` (no Redis needed on one
     server) and set Socket.IO to WebSocket only.
   - Login and password codes stored in the database (item 21).
   - The background jobs (`index.js`, line 779, the supervisor expiry job; and the device-punch
     poller) run in only one process, using `if (process.env.NODE_APP_INSTANCE === '0')`.
4. **Size the database:** 4 processes × 40 connections = 160, which is more than MariaDB's
   default of 151. Set `DB_CONNECTION_LIMIT=30` per process, or raise `max_connections` to 300.
5. **Add a health check:** a `GET /health` that runs `SELECT 1` against the database, so PM2 or
   a load balancer can restart a stuck process.

---

**Not tested:** against the real database (the repo has no schema), so re-run a load test on the
real server after applying these fixes.
