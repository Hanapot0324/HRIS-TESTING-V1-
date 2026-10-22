# EARIST HRIS — Introduction and Staff User Demonstration Video

**Production package:** findings report, narration script, storyboard, recording checklist, editing guide, QA checklist

| Item | Value |
|---|---|
| Source analysed | Repository `HRIS-TESTING-V1-` (branch `claude/zealous-franklin-5voch6`), React/Vite frontend + Node/Express/MySQL backend |
| Audience | Ordinary employees (`staff` role): orientation, system launch, user training |
| Target length | About 9 min 25 s (12 scenes) |
| Method | Static source review of routes, role guards, sidebar logic, API calls and backend middleware. **The app was not run and no database was available**, so live behaviour has to be confirmed during the dry run (Section 7, step A). |
| Status | No source code, configuration or data was changed. This document is the only file added. |

---

## 1. Executive Summary

The EARIST Human Resource Information System (HRIS) is a web application for Eulogio "Amang" Rodriguez Institute of Science and Technology. One system covers employee records (the Personal Data Sheet), attendance and Daily Time Records, leave, payroll and payslips, HR forms, announcements and system administration.

The system has four roles: **staff**, **administrator**, **superadmin** and **technical**. Access is controlled in three layers:

1. **Route role guards** (`ProtectedRoute`, `GatedPageRoute`) in `frontend/src/App.jsx`.
2. **Per-page access grants** (`pages` and `page_access` tables, checked by `usePageAccess`). A staff user sees a menu item only after the page is granted. New staff accounts are automatically granted every page whose `page_group` includes `staff` (`backend/routes/users.js` ≈ lines 596 and 1039).
3. **Backend JWT checks** (`authenticateToken`, `requireAdmin`, `requireSelfOrAdmin` in `backend/middleware/auth.js`).

An ordinary employee who signs in lands on the **Employee Home** dashboard (`/home`). The sidebar offers:

> **Home · Attendance · Daily Time Record (Regular / Honorarium / Service Credits / Overtime) · Leave Request · Payslip · PDS Files (PDS1–PDS4) · Settings · Sign Out**, plus **Profile** (opened by clicking the employee's name or avatar).

The administrative sections (Payroll Management, Attendance Management, Leave Management, Information Management, Forms, System Administration) are hidden from staff by `userRole !== "staff"` checks in `Sidebar.jsx`, and their routes and APIs are restricted to admin roles.

**Video-relevant headline findings**

* Employees can **view and print/download their own DTR as a PDF**, **view and download their own payslips (3-month PDF)**, **view their leave balances and history**, **view their own PDS and print it**, **update their profile and photo**, and **manage password, email, two-factor authentication and support tickets**.
* **Leave filing has a probable blocker for staff.** The leave-type dropdown loads from `GET /leaveRoute/leave_table`, which is `requireAdmin`. For a staff account the dropdown may be empty. Check this in the dry run before recording Scene 8 (see §3).
* Some interface elements lead nowhere (the FAQs and Privacy Policy items in the avatar menu) or are hidden (FILE 201, Employee Reports). The video leaves them out.

---

## 2. Verified Staff-Accessible Feature Inventory

"Verified" means three things were confirmed in source: the route admits `staff`, the sidebar shows the item to staff (subject to a page grant), and the data shown is the signed-in employee's own. Where only the frontend enforces self-scoping, the table says so.

| # | Module (menu label) | Route / component | What staff can do | Download / print | Backend & scoping | Status |
|---|---|---|---|---|---|---|
| 1 | **Login** | `/` · `components/Login.jsx` | Sign in with **Employee Number** (letters and digits only, no hyphens) and **Password**. If MFA is enabled, enter a **6-digit code emailed** to the account (valid 15 min, resend timer; 3 wrong tries lock entry for 1 min). A **Password Security Notice** appears when the account still uses a default password and links to Settings → Change Password. | — | `POST /login`, `/send-2fa-code`, `/verify-2fa-code`, `/complete-2fa-login` (`backend/routes/auth.js`); JWT valid for 10 h | Fully implemented (MFA is on by default; it can be disabled globally or per user) |
| 2 | **Forgot password** | inline panel in `Login.jsx` | Email + reCAPTCHA → emailed code → new password + confirmation checkbox | — | `POST /forgot-password`, `/verify-reset-code`, `/reset-password` (`routes/password.js`) | Implemented (needs working email/reCAPTCHA keys) |
| 3 | **Home** (Employee dashboard) | `/home` · `components/Home.jsx` | View: announcement **carousel** (click for details); **Attendance Calendar** (legend: Present, Absent, Vacation leave, Sick leave, Non-working day, Holiday, Late); **Payslip** card (month selector, 1st/2nd *Quinceña*, Total, Ready/Pending; click opens Payslip); **Today** card (Time in, Break in/out, Time out); mini calendar with personal **notes and events** (Add Note / Add Event); **DTR Notice** panel (Absent, No Time-Out, No Break Punch, browsable by month); **Leave Requests** widget with status; **Leave Balances**; **Notifications** (filter, mark as read). Avatar menu: Profile, Settings, Sign Out. | — | Notes/events/notifications use `requireSelfOrAdmin`; payslip data is server-scoped; announcements, holidays and suspensions are public reads | Fully implemented |
| 4 | **Profile** | `/profile` · `components/DASHBOARD/Profile.jsx` | View own personal data and sections (children, college, graduate studies, vocational, eligibility, learning & development, voluntary work, work experience, other information). **Edit Profile** dialog; **Upload Photo / Remove Photo**; Refresh. | — | Photo upload: `requireSelfOrAdmin`. Profile save: `PUT /personalinfo/person_table/by-employee/:emp` — only `authenticateToken` (frontend sends own number) | Implemented. **Confirm with HR that staff self-editing is policy before showing the Save step.** |
| 5 | **Attendance** | `/attendance-user-state` · `ATTENDANCE/AttendanceUserState.jsx` | View raw device time punches (date, time, status) for a **Start/End date** or **Month & Year**. The Employee Number field is locked to the signed-in user. Refresh. | None | `POST /attendance/api/attendance` — `authenticateToken` only; self-scoping enforced in the UI | Implemented (view-only) |
| 6 | **Daily Time Record → Regular** | `/daily_time_record` · `ATTENDANCE/DailyTimeRecord.jsx` | Pick a year and month to load the DTR. View daily time-in/out with colour legend (Holiday, Suspension, On Leave). Refresh. | **Print DTR** opens the browser print dialog. **Download PDF** saves `Surname, First Name, MI. Month, Year.pdf`. A data check blocks printing if the data is older than 30 min ("Please search again") or was altered on screen. | `POST /attendance/api/view-attendance` with employee number from the JWT (UI-scoped) | Fully implemented (read-only for staff) |
| 7 | **DTR → Honorarium / Service Credits / Overtime** | `/daily_time_record_honorarium`, `_service_credits`, `_overtime` | Same pattern as Regular, but computed against the matching official-time window | Print DTR and Download PDF | Same endpoints | Implemented. Show **one** variant only, and only if the test employee has data for it. |
| 8 | **Leave Request** | `/leave-request-user` · `LEAVE/LeaveRequestUser.jsx` | **Leave Balances** (remaining credits per type, including Service Credit/CTO balances); **My Leave Request Records** with filters (month, leave type, status, search); **View Leave Ledger** and **Transaction Logs** (read-only pop-up windows); **Submit New Leave Request** (Leave Type → Date(s) → Reason (optional) → Request Summary → submit); **Cancel** while *Pending*. Status flow: *Pending → Sup. Approved → HR Approved*, or *Denied* / *Cancelled*. | — | View endpoints use `requireSelfOrAdmin`. `POST /leave_request` forces self and status 0 for non-admins. **`GET /leave_table` is `requireAdmin`, so staff may get an empty leave-type list.** | Viewing: implemented. **Submitting: partially implemented / unverified for staff.** |
| 9 | **Payslip** | `/payslip` · `PAYROLL/Payslip.jsx` | "My Payslip — Employee Portal". Choose a year and month to view that month **and the two prior months side by side**. Only **released** payroll appears. | **Download PDF** saves a landscape A4 PDF named `YYYY-MM-Lastname.pdf`; the download is audit-logged (`log-print`). There is no separate Print button (print the PDF from a PDF viewer). | `GET /PayrollReleasedRoute/released-payroll-detailed` is **server-scoped to the JWT employee** for non-admins | Fully implemented |
| 10 | **PDS Files → PDS1–PDS4** | `/pds1`–`/pds4` · `PDS/PDS*.jsx` → `versions/*_2017` or `*_2025` (chosen by active template) | View own Personal Data Sheet pages in the CSC form layout, filled from profile data (read-only). A banner shows the active template and lets the user download the blank template. | **Save / Print** button calls `window.print()`: the browser print dialog, where "Save as PDF" is an option. **Download blank template** (file as uploaded by HR). | Profile reads via `authenticateToken`; template download `authenticateToken` | Implemented |
| 11 | **Settings** | `/settings` · `components/Settings.jsx` | **Change Password**: current password, then a one-time code to email, then a new password (≥ 6 characters) plus a confirmation checkbox; the user is then signed out. **Email Settings**. **Two-Factor Auth** toggle. **About Us**, **FAQs**, **Policies** (read). **Contact Support**: New Message (subject, message, attachment), conversation list with status filter (New, Read, Replied, In progress, Resolved), **Give Feedback** after a ticket is resolved. | — | Password routes `authenticateToken`; `GET /api/contact-us` returns only the caller's tickets | Implemented |
| 12 | **Sign Out** | Sidebar *Sign Out* (confirmation dialog) / dashboard avatar menu *Sign Out* | Ends the session on this browser | — | — | Implemented |

**Cross-cutting notes**

* **Real-time refresh.** Socket.IO pushes updates, for example a payroll release or attendance change, so pages refresh without a reload (`contexts/SocketContext.jsx`).
* **Responsive layout.** Grids use MUI breakpoints, but the sidebar is a permanent drawer with no mobile layout. **Record on desktop at 1920×1080. Do not claim mobile support.**

---

## 3. Restricted, Incomplete and Unverified Features

### 3a. Restricted: never shown as staff capabilities

| Area | Routes (examples) | Guard |
|---|---|---|
| Payroll processing, released payroll, JO payroll, remittances, PhilHealth, items, salary grade, departments, holidays, payslip distribution, payroll formulas | `/payroll-table`, `/payroll-processed`, `/payroll-released`, `/remittance-table`, `/salary-grade`, `/holiday`, `/distribution-payslip`, `/payroll-formulas` | Admin roles; Payroll menu hidden for staff |
| Attendance management: view/modify other employees, DTR editor, faculty modules, official time, attendance summary, device | `/view_attendance`, `/search_attendance`, `/daily_time_record_editor`, `/attendance_module*`, `/official_time` | Admin roles |
| Leave administration: leave types, assignments, earnings, commutation, HR approval, supervisor assignment, CTO and service-credit management | `/leave-table`, `/leave-request`, `/assignment-management`, `/earnings-management`, `/leave-commutation`, `/cto`, `/service-credits`, `/supervisor-assignment` | Admin roles |
| Information Management (editing other employees' PDS sections) | `/personalinfo`, `/children`, `/college`, … | Admin roles |
| HR forms (clearance, leave form, SALN, locator slip, request for ID, …) | `/clearance`, `/leave-form`, `/saln-front`, … | `adminPage` (admin roles or explicit grant) |
| User management, registration, password reset for others, audit logs, admin action trail, reports, system settings, PDS templates, page management | `/users-list`, `/registration`, `/reset-password`, `/audit-logs`, `/admin-action-trail`, `/reports`, `/system-settings`, `/pds-templates`, `/pages-list` | Admin, superadmin or technical |
| **Supervisor Panel**: Department DTR, Department Leave Requests, Official Time Form | `/daily-time-record-supervisor`, `/leave-request-supervisor`, `/official_time_supervisor` | Only staff with an **active supervisor assignment**. Leave it out of this video, or make a separate supervisor training video. |

### 3b. Incomplete or unverified: excluded from the main demonstration

| Item | Finding | Recommendation |
|---|---|---|
| **Leave filing by staff** | The dropdown source `GET /leaveRoute/leave_table` is `requireAdmin` (`backend/routes/leave.js:1230`). Staff likely get HTTP 403 and an empty *Leave Type* list. | In the dry run, sign in as the test staff account and open the dropdown. **If it is empty**, record only balances, records, ledger and logs, and replace the submission segment with the alternate narration in Scene 8. Ask the developers to expose a read-only leave-types endpoint to staff. |
| "On Leave" markers on staff DTR | DTR pages call admin-only `GET /leaveRoute/leave_request` (403 is caught), so staff DTRs may not show leave markers. | Do not narrate the leave colour on the DTR. |
| Avatar menu **FAQs** and **Privacy Policy** | Navigate to `/faqs` and `/privacy-policy`; neither route exists in `App.jsx`. | Do not click them. Use **Settings → FAQs / Policies** instead. |
| **FILE 201** | Sidebar entry is commented out (`Sidebar.jsx` ≈ 1785). | Exclude. |
| **Employee Reports** (`/employee-reports`) | The route admits staff, but no sidebar item links to it. | Exclude. |
| **My Attendance** (`/my-attendance`) | The route admits staff, but it is only linked from the admin Attendance Management section. | Exclude; use **Attendance** (`/attendance-user-state`). |
| Automatic inactivity logout | `AutoLogoutProvider.jsx` exists but is **not mounted** anywhere. | Do **not** claim auto-logout. Say "always sign out". |
| Mobile use | No responsive sidebar | Do not claim mobile support. |
| Login screen FAQs / Privacy Policy dialogs | Placeholder text ("This is the FAQs content.") | Do not show them. |
| Exact menu set per account | Visibility depends on live `page_access` grants, which are database data and not in the repo. | Confirm every menu item in the dry run. |

### 3c. Internal note for the development team (not for the video)

These items do not change what the video shows. They do limit which security claims the narration can make, so the script makes no claims about them. They are listed so the team can fix them before launch:

1. `POST /complete-2fa-login` issues a token from email and employee number alone. It does not re-check the verified code on the server.
2. `POST /attendance/api/attendance`, `POST/PUT /attendance/api/view-attendance`, `PUT /personalinfo/person_table/by-employee/:emp` and `PUT /api/user-preferences/:emp` check that the caller is logged in, but not that the record belongs to the caller. The UI scopes them; the server should also scope them (`requireSelfOrAdmin`).
3. `GET /leaveRoute/leave_table` blocks staff from reading leave types (see 3b).
4. `Home.jsx` imports `../assets/EaristBG.PNG` but the file is `EaristBG.png`. Production builds on a case-sensitive file system (Linux) will fail on this import.

---

## 4. Recommended Duration and Narrative

**Length: about 9 min 25 s**, which suits the 6–10 minute target. There are seven verified modules, and each one gets a focused "where to find it, what you see, what you can do" segment.

**Narrative arc:** Why the HRIS exists → getting in safely → the dashboard as a daily starting point → *my* records (profile, attendance/DTR, payslip, leave, PDS) → getting documents out (print and download recap) → help and account settings → responsible use → close.

**Tone:** Formal and warm, in plain English for a Philippine state-college audience. Use the HR terms employees already know (DTR, *Quinceña*, PDS, CTO). Avoid technical jargon.

---

## 5. Complete Narration Script

> Read at about 130 words per minute. *[Bracketed italics]* are cues for the editor and are not spoken. If Scene 8's dry-run check fails, use the alternate paragraph marked **ALT**.

**Scene 1: Opening**
Welcome to the EARIST Human Resource Information System, or HRIS. In the next few minutes we will show you how to sign in, find your way around, and use the self-service features available to every EARIST employee.

**Scene 2: What Is the EARIST HRIS?**
The HRIS brings your human resource information together in one secure, web-based system. Your personal data sheet, your daily time record, your leave balances and requests, and your payslips are all available from your own account, whenever you need them. You can check your records, print or download official documents, and follow the status of your requests yourself, with fewer trips to the HR office. Each employee sees only their own information.

**Scene 3: Accessing the System**
Open the HRIS address provided by the HR office in your web browser. On the sign-in page, enter your employee number, without dashes, and your password, then click Sign In.
For your protection, the system may send a six-digit verification code to your registered email address. Enter the code to continue. The code expires after fifteen minutes, so use it right away, and never share it with anyone.
If your account still uses its default password, the system will remind you to create your own. Please do so immediately.
If you forget your password, click "Forgot password?", enter your registered email, and follow the code sent to your inbox.

**Scene 4: Exploring the Employee Dashboard**
After signing in, you arrive at your Home dashboard. At the top are the latest announcements from the Institute. Click any of them to read more.
Below, your attendance calendar shows each day at a glance: present, absent, on leave, late, or a holiday.
On the right, the payslip card shows your first and second *quinceña* amounts for the selected month. The Today card shows your time-in and time-out for today. The DTR Notice panel warns you about missing punches, such as no time-out or no break punch, so you can settle them early with HR. You will also see your leave requests, your leave balances, and your notifications.
You can even add personal notes and events to the mini calendar.
The menu on the left takes you to every module you are allowed to use.

**Scene 5: Your Profile**
Click your name at the top of the menu to open your profile. Here you can review your personal information and the sections of your personal data sheet, from your education and eligibility to your work experience and trainings.
To keep your record current, use Edit Profile, or upload a clear, recent photo. Please make sure every detail you enter is accurate.

**Scene 6: Attendance and Daily Time Record**
To see the individual time punches recorded by the attendance device, open Attendance. Your employee number is filled in automatically. Choose a date range or a month, and your entries appear with the date, time, and type of punch.
For your official Daily Time Record, open Daily Time Record, then Regular. Choose the year and click the month. Your DTR loads, showing your daily time-in and time-out and marking holidays and suspensions.
Click Print DTR to send it to your printer, or click Download PDF to save a copy named with your name and the month.
These pages are for viewing and printing only. If you see an error in your attendance, report it to the HR office; corrections to official attendance records are made by authorized HR personnel. Depending on your assignment, you may also see Honorarium, Service Credits, or Overtime DTRs, which work the same way.

**Scene 7: Payroll and Payslip**
Open Payslip from the menu. Choose the year and click a month. The system displays the payslip for that month together with the two previous months, side by side, showing your pay, deductions, and net pay.
Only payroll that the Payroll office has officially released appears here. To keep a copy, click Download PDF. The file is saved to your computer, and you can open it in any PDF viewer to print it.

**Scene 8: Leave Requests**
Open Leave Request. At a glance, you can see your remaining leave credits for each leave type, including your service credit and compensatory time-off balances where applicable.
To file a leave, choose the leave type, select your date or dates on the calendar, and add a reason if you wish. Review the summary, then submit. Your request is sent to your supervisor for approval.
Track every request in My Leave Request Records. A request moves from Pending, to Supervisor Approved, to HR Approved, unless it is denied. While a request is still pending, you can cancel it yourself. Approvals are made only by your supervisor and the HR office.

> **ALT (use if leave filing is not available to staff during recording):**
> Open Leave Request. Here you can see your remaining leave credits for each leave type, including service credit and compensatory time-off balances where applicable. My Leave Request Records lists every request you have filed, with its current status, from Pending, to Supervisor Approved, to HR Approved, or Denied. You can filter by month, leave type, or status, and review your leave ledger and transaction history. Approvals are made only by your supervisor and the HR office.

**Scene 9: Personal Data Sheet, Help and Account Settings**
Under PDS Files, you can view your Personal Data Sheet, pages one to four, in the official form layout, filled in from your profile. Click Save or Print to print it, or choose "Save as PDF" in the print window.
In Settings, you can change your password, update your email, and manage two-factor authentication. You can also read About Us, the FAQs, and the policies. If you need help, open Contact Support, write a new message, and follow its status until it is resolved.

**Scene 10: Downloading and Printing Your Records**
To recap, here is how to get your documents.
Your DTR: Daily Time Record, choose the month, then Print DTR, or Download PDF.
Your payslip: Payslip, choose the month, then Download PDF.
Your Personal Data Sheet: PDS Files, choose the page, then Save or Print.
Downloaded files go to your browser's Downloads folder. Printing opens your browser's print window, where you can choose a printer or save as PDF.

**Scene 11: Security and Responsible Use**
Your HRIS account holds personal and payroll information, so please protect it. Keep your password and verification codes private. Use a strong password that you do not use anywhere else. Keep two-factor authentication turned on. Always sign out when you finish, especially on shared or public computers. And access only the records you are authorized to see.

**Scene 12: Closing**
With the EARIST HRIS, your records, attendance, payslips, and leave information are always within reach. For questions about your account or your records, use Contact Support in Settings, or visit the Human Resource Management Office. Thank you.

*(≈ 1,180 words)*

---

## 6. Detailed Storyboard with Timestamps

> **Universal privacy rule for every scene:** record only with the designated **test staff account** and **dummy data**. Blur any real name, employee number, email, salary figure or photo that still appears.

### Scene 1 — Opening · 0:00–0:25 (25 s)
* **Narration:** Scene 1.
* **On screen:** Title card on a maroon (#6D2323) background. EARIST logo (`frontend/src/assets/earist-logo.png`) fades in, then the HRIS wordmark (`hrisLogo.png`). Title: "EARIST Human Resource Information System". Subtitle: "Employee Self-Service Guide".
* **Mouse:** none.
* **Overlays:** title and subtitle text.
* **Transition:** slow fade from black; cross-dissolve to Scene 2.
* **Privacy:** none.

### Scene 2 — What Is the EARIST HRIS? · 0:25–1:00 (35 s)
* **Narration:** Scene 2.
* **On screen:** Motion-graphic of five icons (Profile/PDS, DTR, Leave, Payslip, Settings) forming one card. Underlay: a soft, blurred screenshot of the Home dashboard.
* **Overlays:** "One system · Your own records · Anytime access".
* **Transition:** wipe to the browser.
* **Privacy:** the background screenshot must come from the test account.

### Scene 3 — Accessing the System · 1:00–2:00 (60 s)
* **Expected screen:** Login page (`/`), with the announcement carousel on the left and the Sign-in card on the right.
* **Actions:**
  1. Browser already open at the HRIS URL. Zoom to the sign-in card (1:05).
  2. Click **Employee Number** and type the test number. Click **Password** and type it; it shows as dots. **Never reveal the password.**
  3. Click **Sign In** (1:20). The "Verification Code Sent" message appears.
  4. Cut away. **Do not record the email inbox.** Return to the 6-box code entry, where the editor blurs the digits. Code accepted (1:40).
  5. *(Optional, if the test account uses a default password)* Show the **Password Security Notice** dialog for 3 s.
  6. Insert: click **Forgot password?** to show the panel (email field, reCAPTCHA), then **Back to Sign In** (1:50–2:00). Do not submit.
* **Overlays:** "Employee No. — no dashes"; "6-digit code · expires in 15 min"; "Never share your code".
* **Transition:** the dashboard loads; quick zoom-out.
* **Privacy:** blur the employee number if it is real, the masked email and every code digit. Do not show the browser's saved-password prompt (disable it beforehand).

### Scene 4 — Employee Dashboard · 2:00–3:00 (60 s)
* **Expected screen:** `/home`.
* **Actions:**
  1. Full view for 3 s. Slowly hover over the sidebar items.
  2. Click a carousel announcement; the details open. Close it (2:10).
  3. Highlight box on the **Attendance Calendar**. Open the legend (⋮) (2:20).
  4. Zoom on the **Payslip** card. Change the month selector once (2:30).
  5. Highlight **Today**, then **DTR Notice** (use the arrows to change month once) (2:40).
  6. Highlight **Leave Requests** and **Leave Balances**. Open **Notifications** (bell), then close (2:50).
  7. Click a date in the mini calendar, then **Add Note**; type "Submit DTR" and **Save Note** (optional).
* **Overlays:** callout labels matching each panel title.
* **Transition:** cut.
* **Privacy:** payslip amounts must be dummy data or blurred. Notifications must not name other employees.

### Scene 5 — Profile · 3:00–3:40 (40 s)
* **Expected screen:** `/profile` (Employee Profile).
* **Actions:** Click the name/avatar at the top of the sidebar. Scroll through Profile Sections (Personal, Education, Eligibility, Work Experience). Click **Edit Profile** to open the dialog, and point to **Upload Photo**. **Click Cancel** (do not save in the recording unless HR has confirmed self-editing is allowed).
* **Overlays:** "Keep your information accurate".
* **Privacy:** dummy profile only. No real addresses, IDs (GSIS/PhilHealth/TIN) or birthdates.

### Scene 6 — Attendance and DTR · 3:40–5:10 (90 s)
* **Expected screens:** `/attendance-user-state`, then `/daily_time_record`.
* **Actions:**
  1. Sidebar **Attendance**. Point to the locked **Employee Number** field. Set **Start/End Date** or **Month & Year** to the prepared sample month; records load (3:40–4:05).
  2. Sidebar **Daily Time Record → Regular**. Select the year and click the sample month. The DTR renders (4:05–4:30).
  3. Scroll the DTR slowly. Zoom on the legend (4:30–4:40).
  4. Hover **Print DTR** and click it. The browser print dialog opens: show the preview, then **Cancel** (or print to "Save as PDF") (4:40–4:50).
  5. Click **Download PDF**. The "Preparing PDF download…" overlay appears and the file shows in the browser download bar (4:50–5:00).
  6. Hover over the Honorarium / Service Credits / Overtime sub-menu items without opening them (5:00–5:10).
* **Overlays:** "View & print only. Corrections go through HR"; the file name format.
* **Privacy:** the file name contains the employee's name, so use the test account. Blur the download bar if needed.
* **Note:** finish steps 4–5 within 30 minutes of loading the month, or the integrity check asks for a reload.

### Scene 7 — Payslip · 5:10–6:05 (55 s)
* **Expected screen:** `/payslip` (My Payslip).
* **Actions:** Sidebar **Payslip**. Select the year and click a month that has released dummy payroll. Three payslips appear side by side. Zoom across Employee Information, then earnings, deductions and net pay. Click **Download PDF**; "Generating…" shows and the file appears in the download bar. Open the PDF briefly in the browser viewer.
* **Overlays:** "Only released payroll appears"; "Saved as YYYY-MM-Lastname.pdf".
* **Privacy:** **all amounts must be dummy data.** Blur them otherwise.

### Scene 8 — Leave · 6:05–7:10 (65 s)
* **Expected screen:** `/leave-request-user`.
* **Actions (main version):** Highlight **Leave Balances**. In **Submit New Leave Request**, choose a Leave Type, pick 1 future date, and type the reason "Sample request". Click submit, show the **Request Summary**, and confirm; the success message appears. In **My Leave Request Records** the new row shows *Pending*. Click **Cancel** on that row and confirm, so the demo leaves no live request behind. Show the filters, then open **View Leave Ledger** and **Transaction Logs** (each opens a read-only window; close it).
* **Actions (ALT version):** Balances, then records with filters, then View Leave Ledger, then Transaction Logs (open and close each window). No form interaction.
* **Overlays:** status chip legend: Pending → Sup. Approved → HR Approved / Denied / Cancelled. "Approvals: supervisor & HR only".
* **Privacy:** no real medical or personal reasons in the Reason field.

### Scene 9 — PDS Files and Settings · 7:10–7:55 (45 s)
* **Expected screens:** `/pds1`, then `/settings`.
* **Actions:** Sidebar **PDS Files → PDS1**. Scroll and point to the template banner. Click **Save / Print** to show the print preview, then cancel (7:10–7:30). Sidebar **Settings**: click **Change Password** (show the fields, do not submit), **Two-Factor Auth** (show the toggle *on*), **FAQs**, then **Contact Support → New Message** form, then cancel (7:30–7:55).
* **Overlays:** "Print → Save as PDF"; "Keep 2FA on".
* **Privacy:** do not show the email address field unmasked.

### Scene 10 — Downloading and Printing Recap · 7:55–8:30 (35 s)
* **On screen:** A three-row graphic (DTR · Payslip · PDS) with "Menu → Select → Button → Output" columns, intercut with 2-second replays from Scenes 6, 7 and 9. End on the browser's Downloads list showing the two test PDFs.
* **Overlays:** "Download = file saved" vs "Print = browser print window".

### Scene 11 — Security and Responsible Use · 8:30–9:05 (35 s)
* **On screen:** Five checklist icons animate in. Then real footage: sidebar **Sign Out**, the confirmation dialog, and a return to the sign-in page.
* **Overlays:** the five tips as short phrases.
* **Privacy:** none beyond the universal rule.

### Scene 12 — Closing · 9:05–9:25 (20 s)
* **On screen:** Maroon end card: EARIST logo, "EARIST Human Resource Information System", and "For assistance: Settings → Contact Support · HR Management Office". Fade to black.
* **Note:** do not add a slogan or endorsement unless the HR Management Office supplies the official wording.

---

## 7. Step-by-Step Screen Recording Checklist

**A. Preparation and dry run (before recording day)**
1. Ask IT/HR for a **dedicated test staff account** (role `staff`) linked to a **dummy employee profile** with a fictitious name, dummy IDs and an email inbox the team controls.
2. Confirm the test account's sidebar shows: Home, Attendance, Daily Time Record (Regular at minimum), Leave Request, Payslip, PDS Files (PDS1–4), Settings. If an item is missing, ask the administrator to grant the page (`page_access`).
3. Seed dummy data for one **sample month**: attendance punches, a generated DTR, **released** payroll for that month and the two prior months, leave assignments and balances, and one announcement.
4. **Leave check:** open Leave Request and the *Leave Type* dropdown. If the dropdown is empty, use the **ALT** narration for Scene 8.
5. Make sure the test account does **not** use a default password, unless you plan to show the notice in Scene 3.
6. Confirm the verification email arrives for the test account (MFA on).
7. Browser: a clean Chrome or Edge profile with no extensions or bookmarks bar, saved-password prompts off, zoom 100%, window 1920×1080, notifications muted. Close every other tab.
8. Set the Windows/macOS download location to a clean folder.

**B. Recording**
9. Open the HRIS login page.
10. Sign in with the test employee number and password, enter the emailed code, and land on Home.
11. Tour the dashboard panels in order: carousel, calendar, payslip card, Today, DTR Notice, Leave widgets, notifications.
12. Open **Profile**. Scroll the sections, open **Edit Profile**, then **Cancel**.
13. Open **Attendance** and select the sample month.
14. Open **Daily Time Record → Regular** and select the sample month.
15. Click **Print DTR**, show the preview, then cancel.
16. Click **Download PDF** and wait for the file in the download bar.
17. Open **Payslip** and select the sample month.
18. Click **Download PDF**, then open the PDF to verify it.
19. Open **Leave Request**. Show balances. Then either file and cancel a sample request, or (ALT) show records, ledger and logs.
20. Open **PDS Files → PDS1** and click **Save / Print**, then cancel.
21. Open **Settings**: Change Password (view only), Two-Factor Auth (leave on), FAQs, Contact Support → New Message (cancel).
22. Click **Sign Out** and confirm.
23. Record any pick-up shots (zooms and hovers) separately.

**C. Post-recording verification**
24. Open both downloaded PDFs. Check that they are the test employee's and that the month is correct.
25. Delete the test notes, events and leave requests created during recording, or ask the administrator to.
26. Watch the raw footage frame by frame for real data, codes, email addresses and URLs with tokens.

---

## 8. Video Editing and Branding Guidelines

| Parameter | Specification |
|---|---|
| Resolution / aspect | 1920 × 1080, 16:9 |
| Frame rate | 30 fps (record and export at the same rate) |
| Export | H.264 MP4, 10–16 Mbps, AAC 48 kHz stereo |
| Narration | One professional voice in clear Philippine English; recorded in a treated room; normalised to −16 LUFS; noise reduction; no music under detailed instructions louder than −24 dB |
| Music | Calm instrumental, royalty-free or licensed; −28 to −30 dB under voice; slightly louder only on the title and end cards |
| Captions | Burned-in or SRT, sans-serif (the app uses **Poppins**), 42–48 px, white on a 70% maroon box, max 2 lines and 42 characters per line |
| Colour palette (from `useSystemSettings.js` defaults) | Primary **#894444**, Secondary/maroon **#6D2323**, Accent/cream **#FEF9E1**, White **#FFFFFF** |
| Logos | `frontend/src/assets/earist-logo.png` / `earistlogo.PNG` (institution), `hrisLogo.png` (system). Get the official high-resolution EARIST seal and usage approval from the Public Information Office. |
| Callouts | Rounded rectangles, 3 px cream (#FEF9E1) outline with a soft maroon shadow; arrow pointers; one callout at a time |
| Zooms | 1.5–2× on buttons and fields, 0.5 s ease-in/out; hold at least 2 s |
| Cursor | Slightly enlarged with a click ripple; no erratic movement |
| Transitions | Cross-dissolve (0.5 s) between scenes; straight cuts within a scene; no flashy wipes |
| Lower thirds | Scene title in maroon bar with cream text, 3 s, bottom left |
| Interface | Do **not** retouch or redesign the application UI; show it as it is |

---

## 9. Privacy, Security and Accuracy Checklist (Final QA)

| ✔ | Check |
|---|---|
| ☐ | Every demonstrated feature appears in §2 as implemented, and none comes from §3. |
| ☐ | Every action was performed with a **staff** account (no admin menus visible in any frame). |
| ☐ | Leave Scene 8 uses the version that matched the dry-run result. |
| ☐ | Print vs download wording matches: DTR = Print DTR **and** Download PDF; Payslip = Download PDF only; PDS = Save / Print (browser). |
| ☐ | Narration does **not** claim: mobile support, automatic logout, staff editing attendance, staff approving leave, or anything about FILE 201, Employee Reports, or the avatar FAQs/Privacy Policy. |
| ☐ | No real names, employee numbers, emails, salaries, government IDs, birthdates, addresses or photos (all dummy or blurred). |
| ☐ | No passwords, verification codes, JWTs, browser dev-tools, local storage or URLs with tokens are visible. |
| ☐ | Email inbox never shown. |
| ☐ | Downloaded file names in the frame belong to the test account. |
| ☐ | On-screen labels in captions match the UI exactly (e.g., "Print DTR", "Download PDF", "Save / Print", "Leave Request", "My Leave Request Records"). |
| ☐ | Closing card has no invented slogan, policy statement or endorsement. HR has approved the final cut. |
| ☐ | Test data created during recording has been removed. |

---

## 10. Repository Files to Inspect When Verifying the Final Demonstration

**Routing and access control**
* `frontend/src/App.jsx`: route definitions and allowed roles
* `frontend/src/components/ProtectedRoute.jsx`, `GatedPageRoute.jsx`, `frontend/src/utils/gatedRoutes.jsx`
* `frontend/src/hooks/usePageAccess.js`, `frontend/src/utils/routeToComponentMapping.js`
* `frontend/src/components/Sidebar.jsx`: staff menu (≈ lines 1250–2340), admin sections gated by `userRole !== "staff"`
* `backend/middleware/auth.js`: `authenticateToken`, `requireAdmin`, `requireSelfOrAdmin`
* `backend/routes/users.js` (default staff page grants), `backend/migrations/seed_rbac_pages.sql`

**Login and account**
* `frontend/src/components/Login.jsx`, `backend/routes/auth.js`, `backend/routes/password.js`
* `frontend/src/components/Settings.jsx`, `backend/routes/settings-extended.js`

**Dashboard and profile**
* `frontend/src/components/Home.jsx`, `EmployeeHomeWidgets.jsx`, `AttendanceCalendar.jsx`, `DtrNoticePanel.jsx`
* `frontend/src/components/DASHBOARD/Profile.jsx`, `frontend/src/hooks/useProfileData.js`, `useProfileSections.js`, `useProfileMutations.js`
* `backend/routes/notifications.js`, `notes.js`, `events.js`, `announcements.js`, `backend/routes/profile.js`

**Attendance and DTR**
* `frontend/src/components/ATTENDANCE/AttendanceUserState.jsx`
* `frontend/src/components/ATTENDANCE/DailyTimeRecord.jsx`, `DailyTimeRecordHonorarium.jsx`, `DailyTimeRecordServiceCredits.jsx`, `DailyTimeRecordOvertime.jsx`, `DailyTimeRecordPrintable.jsx`
* `backend/dashboardRoutes/Attendance.js`

**Payslip**
* `frontend/src/components/PAYROLL/Payslip.jsx`
* `backend/payrollRoutes/PayrollReleased.js` (`/released-payroll-detailed`, `/log-print`)

**Leave**
* `frontend/src/components/LEAVE/LeaveRequestUser.jsx`
* `backend/routes/leave.js` (`/leave_table` line ≈ 1230; `/leave_request` lines ≈ 2465–3020)

**PDS**
* `frontend/src/components/PDS/PDS1.jsx`–`PDS4.jsx`, `frontend/src/components/PDS/versions/*`
* `frontend/src/components/TemplateInfoBanner.jsx`, `frontend/src/hooks/useActiveTemplate.js`, `backend/routes/pds-templates.js`

**Branding**
* `frontend/src/assets/earist-logo.png`, `earistlogo.PNG`, `hrisLogo.png`, `EaristBG.png`; `frontend/src/hooks/useSystemSettings.js` (colour defaults)

---

*Limitations: this package comes from static source analysis. Menu visibility depends on live database grants, and payroll, attendance and leave screens depend on seeded data. The dry run in §7-A is required before recording. No video file was rendered.*
