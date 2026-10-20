# How to test the security fixes and the staff mobile app

Branch: `claude/serene-dirac-qtcazy`. Use a **copy of the HRIS database and
test accounts**, not production.

```bash
git fetch origin
git checkout claude/serene-dirac-qtcazy
```

---

## 1. Automated tests (no database needed — about 1 minute)

### Backend (94 tests)

```bash
cd backend
npm install
npm test
```

Expected: `Tests: 94 passed, 94 total`. They run the real route code against a
fake in-memory database and cover login (password + OTP), `/api/me`, leave,
attendance/DTR (S2) and PDS (S3) access rules — including "staff A can't read or
change staff B", "staff can't call HR endpoints", and "a refused request writes
nothing".

### Mobile app (35 tests)

Needs Flutter **3.29 or newer** (Dart 3.7+). Check with `flutter --version`.

```bash
cd mobile
flutter pub get
flutter analyze      # expect: No issues found!
flutter test         # expect: All tests passed!
```

---

## 2. Run the system against a test database

1. In `backend/.env` make sure these are set (keep your existing DB settings):
   ```
   JWT_SECRET=<a long random string>     # required — without it sessions reset on restart
   ```
2. Start the backend:
   ```bash
   cd backend
   npm run dev        # http://localhost:5000
   ```
3. Start the web app (separate terminal):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

### Prepare test accounts

| Account | Role | Needed for |
|---|---|---|
| Staff A | `staff` | everything below |
| Staff B | `staff`, **different department** from the supervisor | "other employee" checks |
| Supervisor | `staff` with an active `supervisor_assignment` for Staff A's department | supervisor DTR check |
| HR | `administrator` | confirm HR still has full access |

---

## 3. Manual checks in the web app

**Login (S1)**
- [ ] Wrong password and unknown employee number both show *Invalid credentials*.
- [ ] Correct password → OTP email → code works once; using it again fails.
- [ ] 5 wrong codes → the code stops working; request a new one.

**Staff A — own data still works**
- [ ] Home, My Attendance, Daily Time Record, Leave Request (leave types list now loads), Payslip, Profile load normally.
- [ ] Profile → edit and save PDS sections (children, education, work experience…) → saved.
- [ ] Leave: file a request; cancel it while *Pending*. After HR approves another request, there is no cancel button and the server refuses a cancel.

**Supervisor**
- [ ] Daily Time Record (Supervisor) shows the department's employees and prints.

**HR (administrator)**
- [ ] Attendance modules, DTR overall/print, Person table, PDS pages, leave/SC/CTO management, payroll pages all work as before.

> Expected changes (see `PHASE1_DISCOVERY_REPORT.md` §8): for **staff** accounts the
> *Attendance Form / User State* pages can no longer edit punches or view other
> employees, and staff can't change their own employee number.

---

## 4. Security smoke test against your running server (read-only)

Signs in as Staff A (asks for the OTP if MFA is on) and checks 27 things: own
data allowed; Staff B's DTR, PDS, leave, balances and notifications refused;
HR-only endpoints refused; no-token and the old login bypass refused. It only
reads — it never sends a write against Staff B.

PowerShell:
```powershell
cd backend
$env:HRIS_URL="http://localhost:5000"
$env:STAFF_EMP="<Staff A employee no.>"
$env:STAFF_PASSWORD="<Staff A password>"
$env:OTHER_EMP="<Staff B employee no.>"
node scripts/security-smoke.js
```

bash:
```bash
cd backend
HRIS_URL=http://localhost:5000 STAFF_EMP=... STAFF_PASSWORD=... OTHER_EMP=... \
  node scripts/security-smoke.js
```

Expected last line: `All checks passed.` Any `FAIL` line names the endpoint.
(Use a **staff** account — the script stops if the account is HR/admin.)

---

## 5. Test the mobile app

### Option A — Android emulator (Android Studio)
```bash
cd mobile
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
```
(`10.0.2.2` is your PC as seen from the emulator.)

### Option B — real Android phone over USB
Enable *Developer options → USB debugging*, connect the phone, then:
```bash
adb reverse tcp:5000 tcp:5000
cd mobile
flutter run --dart-define=API_BASE_URL=http://localhost:5000
```
`adb reverse` lets the phone reach your PC's backend as `localhost`. (Plain
`http://192.168.x.x` is refused on purpose — only HTTPS or local dev hosts are allowed.)

### Option C — installable APK for testers
Needs the backend reachable over **HTTPS** (e.g. your institution's server):
```bash
flutter build apk --release --dart-define=API_BASE_URL=https://<your-hris-server>
# APK: mobile/build/app/outputs/flutter-apk/app-release.apk
```

iPhone builds need a Mac with Xcode (`flutter run` on a connected iPhone).

### Mobile checklist (as Staff A)
- [ ] Wrong password → *Invalid credentials*. Correct password → OTP screen (if MFA on) → Home.
- [ ] Home shows your name, unread notifications, pending leave, balances, announcements.
- [ ] My DTR: 1–15 / 16–end / Whole month and previous/next month load your records.
- [ ] My Leave → File leave: choose a type and dates → *Submitted* only after the server accepts it; it appears as *Pending* with **Cancel**; cancel works.
- [ ] Approved/denied requests show no Cancel button.
- [ ] My Records shows Service Credit / CTO hours.
- [ ] Notifications: tap marks read; *Mark all read* works.
- [ ] Profile shows your details; *Sign out* returns to sign-in.
- [ ] Close and reopen the app → still signed in.
- [ ] Session expiry: change `JWT_SECRET` in `backend/.env`, restart the backend, pull to refresh in the app → it signs you out with *session expired*.
- [ ] No HR/admin menus anywhere in the app.

---

## 6. Acceptance matrix (spec §8) → where it is tested

| Scenario | Expected | Covered by |
|---|---|---|
| Staff views own DTR | Allowed | `attendance.access.test.js`, `me.routes.test.js`, smoke test, mobile checklist |
| Staff changes an ID to see another's DTR | Denied | `attendance.access.test.js`, `me.routes.test.js`, smoke test |
| Staff views own leave balance | Allowed | smoke test, mobile checklist |
| Staff tries to change own leave balance | Denied | `leave.selfservice.test.js` (admin endpoints) |
| Staff submits a valid leave request | Processed | mobile/web checklist, `repository_test.dart` |
| Staff tries to approve a leave request | Denied | `leave.selfservice.test.js` |
| Staff reads/edits another's PDS | Denied | `pds.ownership.test.js`, smoke test |
| Staff calls an admin endpoint directly | Denied | all backend suites, smoke test |
| Session expired/invalid | Rejected | `auth.login.test.js`, `attendance.access.test.js`, `me.routes.test.js`, mobile tests + checklist |
| Invalid request | Validation error, no change | `me.routes.test.js`, `leave.selfservice.test.js`, `pds.ownership.test.js` |
| Login without password/OTP | Denied | `auth.login.test.js`, smoke test |

Report anything that fails with the failing line (or screenshot) and the account role used.
