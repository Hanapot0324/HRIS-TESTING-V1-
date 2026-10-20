# EARIST HRIS — Staff mobile app (Flutter)

Employee self-service only, per *Mobile HRIS — Staff-Accessible Feature
Specification*. There are no HR, supervisor, payroll-processing or admin
screens in this app, and the backend — not the app — enforces every access rule.

## Features

| Tab | What staff can do | Backend endpoint(s) |
|---|---|---|
| Sign-in | Employee no. + password, email OTP when MFA is on | `/login` → `/send-2fa-code` → `/verify-2fa-code` → `/complete-2fa-login` (login-ticket chain) |
| Home | Greeting, unread notifications, pending leave, top balances, announcements | composes the rows below |
| My DTR | Own DTR by 1–15 / 16–end / whole month | `GET /api/me/dtr?from&to` |
| My Leave | Requests + status, balances (hours), file leave, cancel **pending** request | `/leaveRoute/leave_request/:me`, `/leaveRoute/leave_assignment/employee/:me`, `/api/me/leave-types`, `POST /leaveRoute/leave_request`, `PUT /leaveRoute/leave_request/:id` (status 4) |
| My Records | Service Credit and CTO balances (view only) | `/api/earnings/sc/:me/balance`, `/api/earnings/cto/:me/balance` |
| Notifications | List, mark read / all read | `/api/notifications/:me`, `PUT /api/notifications/:id/read`, `PUT /api/notifications/:me/read-all` |
| Profile | Own profile (read-only), help, sign out | `GET /api/me/profile` |

`:me` paths are checked server-side with `requireSelfOrAdmin`; `/api/me/*` routes
take identity from the token only.

**Not included yet (needs approval / backend work):** payslips, password change
and recovery in-app (users are pointed to the web portal), profile-correction
requests, active-session list/revoke, push notifications.

## Run

```bash
cd mobile
flutter pub get
# Android emulator → backend on your machine (debug builds only):
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
# Real devices / release: HTTPS is required
flutter build apk --dart-define=API_BASE_URL=https://hris.example.edu.ph
```

`API_BASE_URL` must be `https://`; plain `http://` is accepted only in debug
builds and only for `localhost`, `127.0.0.1` or `10.0.2.2`.

## Security notes

- Session token stored only in the OS keystore (`flutter_secure_storage`);
  Android backups are disabled so it cannot be restored onto another device.
- No secrets in the app. Passwords are sent only to `/login` and never stored.
- Request/response bodies are never logged; server error details are not shown.
- A rejected/expired token signs the user out and clears storage. Sign-out is
  local only — the backend has no logout/revocation endpoint yet, so a token
  stays valid until it expires (10 h). See gap S7 in
  `docs/mobile/PHASE1_DISCOVERY_REPORT.md`.

## Tests

```bash
flutter analyze
flutter test
```

Tests run against an in-memory fake backend with synthetic data
(`test/support/fake_backend.dart`). Backend authorization tests live in
`backend/__tests__` (`cd backend && npm test`).
