# Mobile HRIS (Staff) — Phase 1 Discovery Report

Scope: inspection only, per §10 of the *Mobile HRIS — Staff-Accessible Feature
Specification*. No application code was changed.

## 0. What the repo actually is

| Item | Finding |
|---|---|
| Backend | Node.js + Express 4, MySQL (`mysql2`), JWT (`jsonwebtoken`, 10h expiry), Socket.IO. Entry: `backend/index.js` |
| Web frontend | React 18 + Vite + MUI 6, axios, `react-router-dom` 6 |
| Mobile app | **None exists.** No React Native / Expo / Flutter / Capacitor code in the repo |
| Roles | `staff`, `administrator` (`admin`), `superadmin`, `technical` (`backend/middleware/auth.js:36`). "Supervisor" is not a role — it's a `staff` user with a `supervisor_assignment` or active `page_access` row |
| Auth helpers | `authenticateToken`, `requireAdmin`, `requireSelfOrAdmin(param)`, `scopeEmployeeNumberFromUser(req)`, `requirePageAccess` |
| Tests | No automated test suite or test runner configured in `backend/` or `frontend/` |

## 1. Existing staff-accessible features (web)

| Feature | Web screen | Backend endpoint(s) | Ownership enforced server-side? |
|---|---|---|---|
| Login + email OTP | `Login.jsx` | `POST /login`, `/send-2fa-code`, `/verify-2fa-code`, `/complete-2fa-login` | **NO — see Gap S1** |
| Forgot / reset password | `ForgotPassword.jsx`, `ResetPassword.jsx` | `/forgot-password`, `/verify-reset-code`, `/reset-password` | To verify (enumeration messages) |
| Change own password | `Settings.jsx` | `/verify-current-password`, `/send-password-change-code`, `/verify-password-change-code`, `/complete-password-change` | Partly (last two are unauthenticated — to verify) |
| Home / dashboard widgets | `Home.jsx`, `EmployeeHomeWidgets.jsx` | `/api/dashboard/*`, earnings balance endpoints | Mixed |
| My attendance | `MyAttendance.jsx` (`/my-attendance`) | `GET /attendance/api/attendance?personId=` | **NO — see Gap S2** |
| DTR view | `/daily_time_record` | `GET /attendance/api/dtr?personID=`, `POST /attendance/api/view-attendance` | **NO — see Gap S2** |
| Leave balances | `LeaveRequestUser` | `GET /leaveRoute/leave_assignment/employee/:employeeNumber` | Yes (`requireSelfOrAdmin`) |
| Leave requests (list / history) | `LeaveRequestUser` | `GET /leaveRoute/leave_request/:employeeNumber`, `/transactions/:employeeNumber` | Yes |
| Submit leave request | `LeaveRequestUser` | `POST /leaveRoute/leave_request` | Yes — staff forced to self + status 0 |
| Cancel own leave | `LeaveRequestUser` | `PUT /leaveRoute/leave_request/:id` with status 4 | Yes — non-admin may only self-cancel |
| Leave types list | `LeaveRequestUser` | `GET /leaveRoute/leave_table` | **`requireAdmin` — staff get 403** (Gap B1) |
| SC / CTO balances | Home widgets | `GET /api/earnings/sc/:employeeNumber`, `/api/earnings/cto/:employeeNumber`, `GET /api/cto/:employeeNumber` | Yes (`requireSelfOrAdmin`) |
| Payslips | `/payslip` | `GET /PayrollReleasedRoute/released-payroll-detailed` | Yes — scoped to caller for non-admin |
| Notifications | header bell | `GET /api/notifications/:employeeNumber`, `PUT /api/notifications/:id/read`, `/read-all` | Yes |
| Announcements / holidays / suspensions | `/announcement` | `GET /api/announcements`, `GET /holiday`, `GET /api/suspensions` | Public (no auth) — read only |
| Official time (schedule) | — | `GET /officialtimetable/:employeeID` | **To verify** — auth only |
| Profile / PDS | `/profile`, `/personalinfo`, `/pds1..4` | `GET/PUT/DELETE /personalinfo/person_table/...` | **NO — see Gap S3** |

## 2. Missing but in-scope staff features

| Feature | Status |
|---|---|
| Profile **correction request** workflow (§3.3) | Not present — PDS edits write directly to `person_table` |
| DTR **correction request** (§3.4) | Not present — do not build until HR defines the workflow |
| SC/CTO **employee request** workflow (§3.6) | Not present — admin-only entry. Spec says don't invent; view-only for now |
| Active session list / revoke own sessions (§3.1) | Login writes session rows (IP/UA) — no staff endpoint to list/revoke; JWTs are not revocable |
| Help & support (§3.9) | Not present — static content only unless HR approves a workflow |
| Leave types visible to staff | Blocked by `requireAdmin` on `/leave_table` (Gap B1) |

## 3. Privileged features that must stay out of the mobile app

User/bulk registration, users list, pages & page-access, roles; department/item/salary-grade/PhilHealth/remittance tables; payroll processing, JO payroll, formulas, release, send-payslip bulk, payroll export/upload; leave table/assignment CRUD, bulk leave update, HR deduction tools, commutation, leave credit usage reconcile; SC/CTO create/edit/void/undo/commute; earnings management; attendance editing, bulk save, send-to-DTR, DTR batch print, device sync / device insights; official-time upload/edit; supervisor assignment & supervisor approval queues; audit logs, admin action trail, reports, system settings, admin security, working-hours config, announcements/holiday/suspension CRUD; File201 admin; assessment clearance.

## 4. Proposed mobile API & permission matrix

Every endpoint is `authenticateToken`-protected; identity comes from `req.user.employeeNumber`.

| Mobile screen | Endpoint | Ownership rule |
|---|---|---|
| Sign-in | `/login` → `/send-2fa-code` → `/verify-2fa-code` → `/complete-2fa-login` | **Must be fixed first (S1)** |
| Home | composition of rows below | — |
| My DTR | **new** `GET /api/me/dtr?from&to` | server uses `req.user.employeeNumber`; no `personID` param |
| My Leave — balances | `GET /leaveRoute/leave_assignment/employee/:me` | `requireSelfOrAdmin` ✔ |
| My Leave — requests | `GET /leaveRoute/leave_request/:me`; `POST /leaveRoute/leave_request`; `PUT /leaveRoute/leave_request/:id` (status 4 only) | ✔ existing checks |
| My Leave — types | **new** `GET /api/me/leave-types` (eligible types only, server-side) | fixes B1 without opening admin `/leave_table` |
| My Records — SC/CTO | `GET /api/earnings/sc/:me`, `/api/earnings/cto/:me` | ✔ |
| My Records — payslips | `GET /PayrollReleasedRoute/released-payroll-detailed` | ✔ scoped |
| Notifications | `GET /api/notifications/:me`, `PUT /:id/read`, `PUT /:me/read-all` | ✔ |
| Announcements | `GET /api/announcements`, `/holiday`, `/api/suspensions` | public read |
| Profile | **new** `GET /api/me/profile` (allow-listed fields only) | self only; read-only in v1 |

Recommendation: a small `backend/routes/me.js` router mounted at `/api/me` that only ever reads `req.user`. It reuses existing SQL/services — no new tables, no duplicated business rules.

## 5. Security & business-rule gaps (must address before mobile release)

| ID | Severity | Location | Issue |
|---|---|---|---|
| **S1** | **Critical** | `backend/routes/auth.js:205` | `POST /complete-2fa-login` issues a JWT given only `employeeNumber` + `email` in the body. It never checks that the password was verified or that the OTP was verified. Anyone who knows an account's employee number and email — including an admin's — can obtain a valid token. |
| **S2** | **High** | `backend/dashboardRoutes/Attendance.js:432, 1029, 1576` (and other `personID`-param routes in that file) | Attendance/DTR reads take `personID` from the query/body with only `authenticateToken`. Any staff user can read any employee's attendance. Most mutating routes in that file (`/api/update-attendance`, `/api/save-attendance`, `PUT /api/view-attendance`, `/api/send-to-dtr`, bulk/device routes) also lack role checks — to be confirmed one by one. |
| **S3** | **High** | `backend/dashboardRoutes/PersonalInfo.js:21, 33, 100, 263` | `GET /person_table` (all employees), `GET/PUT/DELETE /person_table/:id` require only a token. A staff user can read, edit or delete any employee's PDS record. Same pattern likely in sibling `dashboardRoutes/*` (Children, College, Eligibility, …) — to be audited. |
| S4 | Medium | `backend/routes/auth.js:28-34` | `/login` returns "User not found" vs "Invalid credentials" — account enumeration. |
| S5 | Medium | `backend/routes/auth.js` | OTP codes are kept in an in-memory object (`twoFACodes`); no attempt counter / rate limit visible on `/verify-2fa-code`. |
| S6 | Medium | `backend/routes/password.js:330, 367` | `/verify-password-change-code` and `/complete-password-change` are unauthenticated — need to verify they are bound to a verified code. |
| S7 | Low | auth model | JWTs (10h) cannot be revoked; "sign out other sessions" needs a server-side session check. |
| S8 | Medium | `backend/routes/announcements.js:50` | `GET /api/announcements` is unauthenticated and, without `?audience=employee`, also returns `hr_only` announcements. The mobile app requests `audience=employee`, but the server should not serve HR-only items to anonymous callers. |
| S9 | Medium | `backend/routes/leave.js` `PUT /leave_request/:id` | Staff could self-cancel their own request in **any** status (incl. HR-approved, which restores balances); the staff UI only allows pending. **Fixed** — see §8. |
| B1 | Functional | `backend/routes/leave.js:1230` | Staff cannot list leave types (`requireAdmin`), but the leave form needs them. |
| T1 | Process | repo | No automated tests exist; spec §4 negative-authorization tests need a test harness (e.g. `jest` + `supertest` against a test DB with synthetic data). |

## 6. Phased plan

1. **Phase 2a — Fix S1** (`backend/routes/auth.js`): issue a short-lived signed "login challenge" after `/login` succeeds; `/verify-2fa-code` upgrades it; `/complete-2fa-login` requires it. Also S4/S5. Add `supertest` tests.
2. **Phase 2b — `/api/me` router** (`backend/routes/me.js`, mount in `backend/index.js`): `profile`, `dtr`, `leave-types`. Negative tests: staff A ≠ staff B, admin routes 403, expired token 401/403.
3. **Phase 2c — S2/S3 hardening** of existing attendance and PDS routes (add `requireSelfOrAdmin` / `requireAdmin`). Must be checked against the web app so HR workflows don't break.
4. **Phase 3 — Mobile app** (`mobile/`): screens Home, My DTR, My Leave, My Records, Notifications, Profile. Token in OS secure storage; no secrets in the app; generic error states.
5. **Phase 4/5** — run the §8 acceptance matrix, document evidence, HR/security sign-off.

## 7. Decisions needed from the project owner

1. **Mobile framework** — the spec forbids introducing one without approval. Recommended: **React Native with Expo** (same language/React skills as the web team, `expo-secure-store` for tokens, Android + iOS from one codebase). Alternatives: Capacitor wrapping a mobile-optimised React build (reuses MUI), or Flutter.
2. Approve fixing S1–S3 **before** building mobile screens (strongly recommended — the mobile app would otherwise ride on bypassable auth).
3. Confirm payslips are approved for mobile self-service.
4. Confirm whether profile editing on mobile is view-only in v1.

## 8. Implementation status (owner decisions: Flutter; security first)

| Item | Status | Where |
|---|---|---|
| S1 login bypass | **Fixed** — signed, single-use login ticket chains password → OTP → token; OTP single-use, 5-attempt limit; `/send-2fa-code` needs the ticket | `backend/routes/auth.js`, `backend/utils/loginTicket.js`, `frontend/src/components/Login.jsx` |
| S4 account enumeration on `/login` | **Fixed** — one generic message | `backend/routes/auth.js` |
| S5 OTP brute force | **Fixed** (per-code attempt limit). No IP rate limiting yet | `backend/routes/auth.js` |
| `/api/me` router | **Done** — `profile`, `dtr`, `leave-types`; identity from token only | `backend/routes/me.js` |
| B1 leave types 403 for staff | **Fixed** — web + mobile use `/api/me/leave-types` | `frontend/src/components/LEAVE/LeaveRequestUser.jsx` |
| S9 self-cancel any status | **Fixed** — staff may cancel only pending | `backend/routes/leave.js` |
| T1 no tests | **Started** — jest + supertest, DB mocked (94 tests) + read-only smoke script for a live server | `backend/__tests__/`, `backend/scripts/security-smoke.js` |
| Flutter staff app | **Done (v1)** — Home, My DTR, My Leave, My Records, Notifications, Profile; 35 tests | `mobile/` |
| S2 attendance IDOR | **Fixed** — deny-by-default policy for all `/attendance` routes: staff read own records, supervisors read (not edit) their departments, everything else HR/admin-only. Unauthenticated `/attendance/api/audit-log` closed | `backend/dashboardRoutes/attendanceAccessPolicy.js` |
| S3 PDS IDOR | **Fixed** — staff read/change only their own PDS rows (lists scoped, by-person self-only, creates pinned to self, edits/deletes row-owner checked); deleting PDS records, org-wide dumps and audit logs HR-only; staff can't change their employee number | `backend/utils/accessScope.js`, `backend/dashboardRoutes/*.js`, `backend/routes/learning.js` |
| S6 password-change endpoints, S7 revocation, S8 announcements | **Open** | — |
| S10 official time | **Open** — `backend/routes/officialtime.js` reads/uploads/edits only require a login (same pattern as S2) | `backend/routes/officialtime.js` |
| Payslips on mobile | **Not included** — awaiting approval (§7.3) | — |

Known pre-existing issue (not from this work): `vite build` fails on Linux because
`Login.jsx` imports `../assets/EaristBG.PNG` and the file's case differs.

### Behaviour changes from the S2/S3 fixes (for HR to confirm)

- **Staff "Attendance Form / User State" pages** (`/attendance_form`, `/attendance-user-state`) edit punch states and read any employee. For staff accounts these calls are now refused (HR-only). HR/admin are unaffected.
- **Staff DTR page** also tried to save computed late/undertime to `overall_attendance_record`. For staff that save is now refused; the page already handles the failure and keeps its local copy. HR's computation modules still save it.
- **Supervisors** keep read-only DTR viewing for employees in their assigned departments (same rule as the supervisor DTR page), and can still mark their DTRs as printed.
- **Staff profile save** can no longer change the employee number (`agencyEmployeeNum`).
- Staff pages that loaded "all employees" lists just to find their own row (person list, employment category, voluntary work) now receive only their own row.
