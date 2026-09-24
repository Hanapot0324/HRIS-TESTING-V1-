# Backend Scalability & Compatibility Report

Module-by-module review of every backend component (63 route files, services, utils,
middleware, socket, database layer). Each module lists the problems found, the
evidence, the solution, and whether it is already fixed in PR #1.

**Status legend:** ✅ Fixed in PR #1 · 🔧 To do (solution described) · ✔️ No significant issue found

## How it was tested

- **Test database:** MariaDB rebuilt from the code (the repo has no schema) and filled with
  realistic volume: 5,000 employees, 600k notifications, 600k device punches, 300k DTR rows,
  240k released payslips, 70k official-time rows, 50k leave requests, 40k leave assignments.
  The repo's own index migrations were applied so the original code was measured fairly.
- **Load tests:** 100–200 simultaneous users (staff screens) and 50 simultaneous admins,
  before and after each fix.
- **Query analysis:** SQL captured from the database log, every distinct query run through
  `EXPLAIN` (full-table scans) and through MySQL 8 strict mode (`ONLY_FULL_GROUP_BY`).
- **Static analysis:** every query call in every file scanned for queries in loops,
  non-indexable comparisons, whole-table reads, blocking calls and crash-prone error handling.
- **Regression checks:** every changed endpoint's response compared against the previous
  version on the same data; all 531 routes checked for access control before/after.

## Overall result (200 staff opening screens at the same time)

| | Before | After |
|---|---|---|
| Screen loads per second | 74 | 457 |
| Typical (p50) screen load | 2.4 s | 0.31 s |
| Slow (p95) screen load | 5.0 s | 0.9 s |

---

## Top priorities (to do)

| # | Problem | Module(s) | Why it matters |
|---|---|---|---|
| 1 | One request can crash the whole server | Attendance, settings, Official Time, Payroll, Upload Payroll, CTO, Service Credit, Leave | Every user is disconnected; `/api/check-attendance` crashes it on every call |
| 2 | Realtime updates broken (`getIO is not a function`) | socket | Notifications / live refresh do not arrive (pre-existing) |
| 3 | Same table spelled two ways (`AttendanceRecordInfo` / `attendancerecordinfo`) | Attendance, dashboard, reports, supervisor, users, socket | Breaks on a Linux MySQL server |
| 4 | Audit Logs page downloads the entire audit log | audit | Grows forever; slower every day |
| 5 | Admin list screens download whole tables (12–60 MB) | Leave, Payroll Released, Earnings | Needs pagination |
| 6 | Spreadsheet imports block the server | Official Time, Upload Payroll, Salary Grade, Voluntary import | 5,000 rows ≈ 0.5 s freeze for everyone |
| 7 | 17 known vulnerabilities (12 high) in dependencies | package.json | Includes connection-exhaustion DoS in Socket.IO |

---

## A. Platform / core

### `index.js` (server startup, routing)
| Problem | Solution | Status |
|---|---|---|
| Admin-only routers mounted at `/` applied their admin check to **every** request, so staff got 403 on notifications, dashboard, notes, events, own leave/earnings, and each request re-checked the token up to 7 times | Scope each router's check to its own paths | ✅ |
| Lookup indexes missing for per-employee queries | Startup creates 15 indexes if absent (skips when one already exists); also in `migrations/add_concurrency_indexes.sql` | ✅ |
| No health endpoint; `GET /health` would return the SPA page with 200 even when the DB is down | Add `/health/live` (process) and `/health/ready` (DB `SELECT 1`, startup done) before the SPA fallback | 🔧 |
| No graceful shutdown; restarts drop in-flight requests | On SIGTERM: stop accepting, `server.close()`, `io.close()`, `pool.end()` | 🔧 |
| No global `unhandledRejection` handler; on Node 22 an unhandled rejection kills the process | Log and keep serving (plus fix the handlers listed in section F-1) | 🔧 |
| `.env` loaded from the current directory (`dotenv.config()`); starting from another folder loses `JWT_SECRET` | `dotenv.config({ path: path.join(__dirname, '.env') })` | 🔧 |
| Startup runs ~40 `ALTER/CREATE` statements on every boot | Move to a one-time migration runner | 🔧 |

### `db.js` (connection pool)
| Problem | Solution | Status |
|---|---|---|
| Queue limit 200 turned normal bursts into "Queue limit reached" errors | Default raised to 1,000 (env-configurable) | ✅ |
| No `timezone` option; dates written from JS use the Node host's timezone while `NOW()` uses the DB server's — breaks if the two hosts differ | Set `timezone` explicitly (e.g. `'+08:00'`) and the DB `time_zone` to match | 🔧 |
| Several instances × 40 connections can exceed MariaDB `max_connections` (default 151) | Size `DB_CONNECTION_LIMIT` per instance so the total stays below the server limit | 🔧 (deployment) |

### `middleware/auth.js`
| Problem | Solution | Status |
|---|---|---|
| Login-check cache held only 2,000 users, so it kept emptying and hit the DB on almost every request | Holds 20,000; simultaneous lookups for one user are shared | ✅ |
| Canonical employee-number lookup used a full-table `REGEXP` scan | Exact indexed match first, fallback only if needed | ✅ |
| `JWT_SECRET` falls back to a random per-process secret if unset, so tokens fail across restarts/instances | Refuse to start in production without `JWT_SECRET` | 🔧 |

### `socket/` (Socket.IO)
| Problem | Solution | Status |
|---|---|---|
| **Circular `require` (socketServer → auth → socketService → socketServer) leaves `getIO` undefined; all `socketService` emits fail** (pre-existing, from commit `08625a5`) | Pass `io` into socketService at startup, or lazy-require `getIO` inside functions | 🔧 **high** |
| Broadcasts to every user made all browsers refetch at the same instant | Frontend now combines and randomly spreads refreshes over ~3 s | ✅ |
| No shared adapter; events reach only users on the same server process | Add `@socket.io/redis-adapter` (or MySQL adapter) before running more than one instance | 🔧 (for scale-out) |
| Device-punch poller and the 60 s expiry job run in every process | Run them on one instance only (env flag or DB `GET_LOCK`) | 🔧 (for scale-out) |
| 6 log lines per socket connection and 10 per broadcast helper; file-redirected logs are synchronous | Reduce to warnings/errors or use an async logger | 🔧 low |

### `package.json` (dependencies)
| Problem | Solution | Status |
|---|---|---|
| 17 known vulnerabilities (5 moderate, 12 high): `engine.io` polling connection exhaustion, `path-to-regexp`/`qs` DoS, `mysql2`, `jws`, `ws`, `nodemailer`, `xlsx` (no npm fix) | `npm audit fix`; replace `xlsx` 0.18.5 with SheetJS's CDN build (0.20.x) | 🔧 |
| Unused packages: `expres` (one-letter typo of `express`, a separate package), `vite`, `express-fileupload`, `moment`, `moment-timezone`, `node-fetch`, `@google/generative-ai` | Remove | 🔧 |
| `body-parser` used but not declared | Remove the duplicate `bodyparser.json()` (Express already parses JSON) or declare it | 🔧 |
| No `engines` field | Add `"engines": { "node": ">=18" }` | 🔧 |
| Global 50 MB JSON body limit on every route | Keep 50 MB only on the bulk routes; default ~1 MB elsewhere | 🔧 |

---

## B. Authentication & accounts

### `routes/auth.js`
| Problem | Solution | Status |
|---|---|---|
| 2FA codes stored in process memory (lost on restart, not shared between instances) | Store codes in a DB table with expiry | 🔧 |
| Runs `CREATE TABLE IF NOT EXISTS` + `DESCRIBE auth_sessions` on every 2FA login | Do the table check once at startup | 🔧 |
| Client IP taken from a raw `X-Forwarded-For` header (spoofable) | `app.set('trust proxy', …)` and use `req.ip` | 🔧 |
| Security: `complete-2fa-login` issues a token without checking the 2FA code | Verify the code server-side in that step | 🔧 (security) |

### `routes/password.js`
| Problem | Solution | Status |
|---|---|---|
| Reset / change-password codes stored in process memory | Same DB-backed code table as 2FA | 🔧 |

### `routes/users.js`
| Problem | Solution | Status |
|---|---|---|
| Bulk registration processed every row at once with blocking password hashing; a callback-less query crashed the server (tested: 300 rows = crash) | 5 rows at a time, async hashing, error handlers on every query | ✅ |
| Grant-default-access routes insert page access one row per page per user in parallel (`forEach`) | One multi-row `INSERT … VALUES ?` per user | 🔧 |
| Name search uses `LIKE '%…%'` on a concatenated name (no index) | Fine at 5,000 employees; add `LIMIT` and client debounce | 🔧 low |

### `routes/confidential-password.js`, `routes/pages.js`, `routes/profile.js`
✔️ No significant scalability issue. The confidential password is stateless (time-window HMAC), which is fine across instances **if server clocks are in sync (NTP)**.

---

## C. Attendance & time

### `dashboardRoutes/Attendance.js`
| Problem | Solution | Status |
|---|---|---|
| **`GET /api/check-attendance` uses the reserved word `exists` as an alias, so the SQL always fails; `if (err) throw err` then crashes the server** (reproduced) | Rename the alias (`AS record_exists`) and return a 500 instead of throwing | 🔧 **critical** |
| DTR "modified by" names came from 3 `CAST` joins — ~90% of DTR query time (84 ms vs <10 ms) | Names resolved afterwards, only for modified rows | ✅ |
| My Attendance leave rows scanned users, leave requests and official time on each load | Bind the employee number; indexed | ✅ (4.9 s → 0.85 s p50 under load; 5–8 ms alone) |
| Table named both `AttendanceRecordInfo` (26×) and `attendancerecordinfo` (19×); on Linux these are different tables | Use one spelling everywhere (or set `lower_case_table_names=1` on a new server) | 🔧 |
| `view-attendance-full` save updates day by day in a loop | Batch upsert (`INSERT … ON DUPLICATE KEY UPDATE`) for the month | 🔧 |
| 4 GET endpoints write an audit row on every view (`check-attendance`, `dtr`, `dtr-employee-list`, `attendance_adjustment`) | Audit only admin views of other employees | 🔧 |
| Admin DTR employee list / device users: 0.4–0.6 s per call | Acceptable (whole-organisation summaries; device list already cached 90 s) | ✔️ |

### `routes/officialtime.js`
| Problem | Solution | Status |
|---|---|---|
| **11 async handlers can crash the server on one DB error** (all Excel uploads, bulk schedules, create/update/delete schedule) | Wrap in `try/catch` (or an `asyncHandler` wrapper) | 🔧 **high** |
| Excel parsing is synchronous (5,000 rows ≈ 0.5 s freeze for all users) | Parse in a `worker_thread` | 🔧 |
| Uploads insert row by row inside a long transaction (locks held for the whole upload) | Multi-row inserts per chunk | 🔧 |
| `users-status` list scans official time twice (0.29 s, 1.9 MB) | Acceptable for an admin summary; could cache briefly | ✔️ |

### `services/deviceAttendanceSyncService.js`, `services/autoAttendanceService.js`
| Problem | Solution | Status |
|---|---|---|
| Inserts row by row | Multi-row insert | 🔧 low |
| Updates already limited to 10 at a time | — | ✔️ |

### `routes/auto-attendance.js`, `routes/attendanceResultRoutes.js`, `routes/attendanceComputationViewState.js`, `routes/workingHoursRoutes.js`, `services/attendanceResultWriter.js`
✔️ No significant scalability issue in query shape. Note: `/api/auto-attendance/exempt-employees` is readable by any logged-in user (review whether intended).

---

## D. Leave, credits & earnings

### `routes/leave.js`
| Problem | Solution | Status |
|---|---|---|
| Leave deduction lookup used `CAST` on users (full scan on every deduction, including bulk loops) | Bound parameters; indexed | ✅ |
| Missing index on `leave_request.employeeNumber` / `leave_assignment.employeeNumber` (staff Leave page ~1.7 s under load) | Indexes created at startup | ✅ (→ 0.30 s) |
| Admin `GET /leave_request` (12 MB) and `/leave_assignment` (18 MB) return whole tables | Server-side pagination + filters | 🔧 |
| `bulk-update` runs one UPDATE per request row sequentially | Group updates; single `UPDATE … CASE` or chunks | 🔧 low |
| `leave_credit_usage/reconcile` has an unguarded `await` (crash risk) | `try/catch` | 🔧 |
| `leave_table` is admin-only, but the staff Leave page calls it (always 403) | Allow read for staff, or stop calling it | 🔧 (functional) |

### `routes/earningsRoutes.js`
| Problem | Solution | Status |
|---|---|---|
| `GET /sc/all`, `/cto/all` return whole tables | Pagination / period filter | 🔧 |
| `TRIM(leave_code) = TRIM(?)` in lookups (employee-number part is indexed, so impact is small) | Store trimmed codes and compare directly | 🔧 low |
| Uses `WITH RECURSIVE` (needs MySQL 8 / MariaDB 10.2+) | Document minimum DB version | 🔧 (docs) |

### `routes/serviceCredit.js`, `routes/ctoRoutes.js`, `utils/serviceCreditBalanceUtils.js`, `utils/ctoBalanceUtils.js`
| Problem | Solution | Status |
|---|---|---|
| **Lost update:** `restoreScPeriodUsedHoursAsync` / `restoreCtoPeriodUsedHoursAsync` compute the new `used_hours` in JS and overwrite it; two undo actions at once lose one | `SET used_hours = GREATEST(0, used_hours - ?)` | 🔧 |
| `undo-entry` handlers have unguarded `await`s (crash risk) | `try/catch` | 🔧 |
| Missing index on `service_credit` / `cto_credit` employee number | Created at startup | ✅ |

### `routes/commutation.js`, `routes/deductions.js`, `routes/leaveSalaryShortfallRoutes.js`, `services/deductionPolicyService.js`, `services/leaveCreditUsageService.js`, `utils/leaveAssignmentBalanceUtils.js`
| Problem | Solution | Status |
|---|---|---|
| Deduction policy lookups used `CAST` on users | Bound parameters | ✅ |
| Others | — | ✔️ |

---

## E. Payroll

### `payrollRoutes/PayrollReleased.js`
| Problem | Solution | Status |
|---|---|---|
| Staff payslips (Home, Payslip) scanned all payroll history (`CAST`) | Bound parameter; indexed | ✅ (2.7 s → 0.30 s under load) |
| **Admin view compared every payslip with every category: did not finish in 60 s** | Categories merged in JS | ✅ (→ 3.3 s) |
| Admin `released-payroll` / `-detailed` return every payslip ever (~60 MB) | Pagination / period filter | 🔧 |

### `payrollRoutes/Payroll.js`
| Problem | Solution | Status |
|---|---|---|
| `payroll-processed` same row × category join | Categories merged in JS; also fixes duplicated rows | ✅ |
| `payroll/search` and `payroll-with-remittance` still join categories with `CAST` on both sides, plus per-request `GROUP BY` over remittance, PhilHealth and item tables | Same JS merge, or align collations and drop `CAST` | 🔧 |
| `add-rendered-time` runs ~7 sequential queries per employee (~35k queries for 5,000 employees) | Set-based queries per batch | 🔧 |
| `POST /payroll-processed`, `DELETE /payroll-processed/:id` have unguarded `await`s | `try/catch` | 🔧 |

### `payrollRoutes/UploadPayroll.js`, `payrollRoutes/SalaryGradeTable.js`
| Problem | Solution | Status |
|---|---|---|
| Synchronous Excel parsing blocks the server | Worker thread | 🔧 |
| Salary Grade upload buffers the file in memory with **no size limit** | Add `limits.fileSize` | 🔧 |
| `import-payroll` has an unguarded `await`; row-by-row queries in the loop | `try/catch`; multi-row statements | 🔧 |

### `payrollRoutes/SendPayslip.js`
| Problem | Solution | Status |
|---|---|---|
| Upload in memory with no size limit | Add `limits.fileSize` | 🔧 |
| Bulk send emails one by one inside a single HTTP request (long request, can time out) | Queue the job and report progress | 🔧 |

### `payrollRoutes/PayrollJO.js`
| Problem | Solution | Status |
|---|---|---|
| Page makes 2 requests per JO employee (attendance + official time) | Combined batch endpoint | 🔧 |

### `payrollRoutes/PayrollExport.js`, `services/payrollTemplate/*`
| Problem | Solution | Status |
|---|---|---|
| Appendix 33 template library and position overrides saved on the local disk | Shared storage or DB if more than one server | 🔧 (scale-out) |
| Export built synchronously in memory | Worker thread for large exports | 🔧 low |

### `payrollRoutes/Remittance.js`
| Problem | Solution | Status |
|---|---|---|
| Admin screens fetched one employee name per request (thousands per page) | New batch `POST /Remittance/employees/lookup` | ✅ |

### `routes/remittance.js`, `routes/salary.js`, `routes/item.js`, `routes/philhealth.js`, `routes/department.js`, `payrollRoutes/PayrollFormulas.js`
✔️ Small admin CRUD tables. Fixed only the routing-scope bug (see `index.js`).

---

## F. Personnel records (PDS / 201 file)

### `dashboardRoutes/PersonalInfo.js`, `Children.js`, `College.js`, `Eligibility.js`, `Graduate.js`, `OtherSkills.js`, `Vocational.js`, `Voluntary.js`, `WorkExperience.js`, `routes/learning.js`
| Problem | Solution | Status |
|---|---|---|
| Each has a "list everything" GET (`SELECT * FROM <table>`, no filter or limit) | Pagination / search on the server | 🔧 |
| Frontend fetched one name per row | Batch lookup | ✅ |
| `person_id` lookups need an index on each table | Add `(person_id)` indexes | 🔧 |
| Voluntary Excel import (`upload_voluntary_work_table`): upload with no size limit, synchronous Excel parse, one INSERT per row | Size limit, worker thread, multi-row insert | 🔧 |
| College / Eligibility / Vocational configure an upload (`multer({ dest })`, no size limit) that no route uses | Remove the dead upload config | 🔧 low |

### `dashboardRoutes/DataRoute.js`
| Problem | Solution | Status |
|---|---|---|
| `/all_data` joins each person's eligibility rows × work-experience rows (result multiplies) | Return sections separately | 🔧 |

### `dashboardRoutes/EmployeeCategory.js`
| Problem | Solution | Status |
|---|---|---|
| DTR downloaded all 5,000 categories (1 MB) to find one | Fetch the employee's own row | ✅ |
| Self-lookup wrote an audit row on every DTR load (introduced by the fix above) | Skip audit for own record | ✅ |
| Has its own copy of `authenticateToken` (skips the shared role refresh) | Use `middleware/auth.js` | 🔧 |

### `routes/file201.js`, `routes/pds-templates.js`, `routes/FORMS/assessmentClearance.js`
| Problem | Solution | Status |
|---|---|---|
| Files stored on local disk | Shared storage before scaling out | 🔧 (scale-out) |
| 50 MB upload limit | Confirm needed | ✔️ |

---

## G. Communication, dashboards & admin

### `routes/notifications.js`
| Problem | Solution | Status |
|---|---|---|
| `CAST` blocked the index; every Home load scanned all notifications | Direct comparison + index | ✅ (26 → 1,505 req/s; 3.6 s → 65 ms) |

### `routes/announcements.js`, `routes/holiday.js`, `routes/suspensions.js`
| Problem | Solution | Status |
|---|---|---|
| One notification INSERT per employee all at once; only 212 of 5,000 saved and other users got errors | Batched inserts of 500 | ✅ |
| Public list GETs (small tables) | — | ✔️ |

### `routes/dashboard.js`
| Problem | Solution | Status |
|---|---|---|
| Every admin re-ran 8 aggregate queries after each attendance event | Shared 1 s result across admins | ✅ (478 ms → 21 ms) |
| Admin Home downloaded every payslip (~60 MB) to count them | Count returned by `payroll-summary` | ✅ |

### `routes/reports.js`
| Problem | Solution | Status |
|---|---|---|
| Attendance report runs 38 sequential queries (7 per week + 1 per day of month) | One grouped query (as already done in `dashboard.js`) | 🔧 |
| 11 report GETs write an audit row on every view | Audit report generation, not viewing | 🔧 low |

### `routes/audit.js`
| Problem | Solution | Status |
|---|---|---|
| **Audit Logs page returns the entire audit log (no LIMIT)**; the table only grows and has no index on `timestamp` | Server-side pagination; index `audit_log(timestamp)`; archive old rows | 🔧 **high** |

### `routes/adminActionTrail.js`
✔️ Already limited to 5,000 rows and indexed on `timestamp`.

### `routes/supervisor.js`
| Problem | Solution | Status |
|---|---|---|
| Supervisor leave list: 3 correlated `COUNT` subqueries per employee over all leave requests | One grouped count | ✅ |

### `routes/settings.js`
| Problem | Solution | Status |
|---|---|---|
| **`GET /api/settings` (public, no login) and `POST /api/settings` `throw err` inside DB callbacks (4 places); any DB error crashes the server** | Return 500 instead of throwing | 🔧 **critical** |

### `routes/settings-extended.js`
| Problem | Solution | Status |
|---|---|---|
| Contact-us notifications to admins inserted one by one | Batch insert (small fan-out) | 🔧 low |

### `routes/notes.js`, `routes/events.js`, `routes/tasks.js`, `dashboardRoutes/DashboardAuditRoute.js`
| Problem | Solution | Status |
|---|---|---|
| Missing index on `notes/events.employee_number` | Created at startup | ✅ |

### `utils/supervisorPageAccess.js` (60 s expiry job)
| Problem | Solution | Status |
|---|---|---|
| Duplicate-notice check scanned all notifications per expiring assignment (~14 s DB time per run) | Direct comparison, indexed | ✅ (→ ~70 ms) |
| Notice de-duplication is check-then-insert with no unique key | Unique key + `INSERT IGNORE` | 🔧 |

---

## Compatibility checklist

| Check | Result |
|---|---|
| Table-name case consistency (Linux MySQL is case-sensitive) | ❌ `AttendanceRecordInfo` vs `attendancerecordinfo` |
| `require()` path case (Linux file systems are case-sensitive) | ✅ All correct |
| MySQL 8 reserved words | ❌ `AS exists` in `/api/check-attendance` (fails on MariaDB and MySQL) |
| `ON DUPLICATE KEY UPDATE col = VALUES(col)` (deprecated in MySQL 8.0.20+) | ⚠️ 24 uses; still works, warns |
| `WITH RECURSIVE` | ⚠️ Requires MySQL 8.0 / MariaDB 10.2 or newer |
| Collations: 102 `CAST(... AS CHAR)` comparisons, likely added to avoid "Illegal mix of collations" | ⚠️ Align table/column collations (e.g. `utf8mb4_general_ci`), then remove the `CAST`s |
| Timezone: `NOW()` in SQL vs dates written from Node | ⚠️ Set pool `timezone` and DB `time_zone` to the same zone |
| Node version | ⚠️ No `engines` field; code needs Node 18+ |
| Frontend build on Linux | ❌ Asset imports with wrong case (e.g. `EaristBG.PNG` vs `EaristBG.png`) |

## Not verified

- The real production schema (not in the repo). Numbers come from the rebuilt test database;
  re-run a load test on the real server after deploying.
