# Backend Fix Plan: Problems, Locations and Solutions

**Scope:** backend only. Every item below is **still open**; fixes already made are on PR #1.
Line numbers refer to the PR branch (`claude/gracious-mccarthy-guvu4f`). Each solution is the
smallest safe change, chosen so the system holds up with **5,000+ employees using it at the
same time**.

---

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

## What's needed for 5,000+ simultaneous employees

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

## Already fixed in PR #1 (for reference)

| Area | Before | After |
|---|---|---|
| Staff screens, 200 simultaneous users | 2.4 s typical load | 0.31 s |
| Notifications | 3.6 s | 65 ms |
| Admin payslip view | over 60 s | 3.3 s |
| Announcement notifications | 212 of 5,000 saved | all saved |
| Bulk registration of 300 rows | crashed the server | works |
| Staff blocked from their own pages (403) | broken | fixed |

**Not tested:** against the real database (the repo has no schema), so re-run a load test on the
real server after applying these fixes.
