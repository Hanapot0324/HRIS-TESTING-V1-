#!/usr/bin/env node
/**
 * Read-only security smoke test against a RUNNING HRIS backend.
 *
 * Signs in as a STAFF account through the real login flow (asks for the
 * emailed OTP when MFA is on), then checks that:
 *   - the staff user can read their own data,
 *   - they cannot read another employee's data,
 *   - HR/admin-only endpoints refuse them,
 *   - unauthenticated calls are refused.
 *
 * It only sends GETs and read-style POSTs, and never sends a cross-employee
 * write, so a failed protection cannot change data. (Write protections are
 * covered by the automated tests in backend/__tests__.)
 * Use a test database and test accounts.
 *
 * Usage (PowerShell):
 *   $env:HRIS_URL="http://localhost:5000"; $env:STAFF_EMP="1001";
 *   $env:STAFF_PASSWORD="..."; $env:OTHER_EMP="1002"; node scripts/security-smoke.js
 * Usage (bash):
 *   HRIS_URL=http://localhost:5000 STAFF_EMP=1001 STAFF_PASSWORD=... OTHER_EMP=1002 \
 *     node scripts/security-smoke.js
 */
const readline = require('readline');

const BASE = (process.env.HRIS_URL || 'http://localhost:5000').replace(/\/$/, '');
const ME = process.env.STAFF_EMP;
const PASSWORD = process.env.STAFF_PASSWORD;
const OTHER = process.env.OTHER_EMP;

if (!ME || !PASSWORD || !OTHER) {
  console.error('Set STAFF_EMP, STAFF_PASSWORD and OTHER_EMP (see the header of this file).');
  process.exit(2);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function signIn() {
  const login = await call('POST', '/login', { body: { employeeNumber: ME, password: PASSWORD } });
  if (login.status !== 200 || !login.data?.loginTicket) {
    throw new Error(`Login failed (${login.status}). Check STAFF_EMP / STAFF_PASSWORD.`);
  }
  let ticket = login.data.loginTicket;
  let done = await call('POST', '/complete-2fa-login', { body: { loginTicket: ticket } });
  if (done.status === 401 && done.data?.mfaRequired) {
    const sent = await call('POST', '/send-2fa-code', { body: { loginTicket: ticket } });
    if (sent.status !== 200) throw new Error(`Could not send OTP (${sent.status}).`);
    const code = await ask('Enter the verification code sent to the staff email: ');
    const verified = await call('POST', '/verify-2fa-code', { body: { loginTicket: ticket, code } });
    if (verified.status !== 200) throw new Error(`OTP rejected (${verified.status}).`);
    ticket = verified.data.loginTicket;
    done = await call('POST', '/complete-2fa-login', { body: { loginTicket: ticket } });
  }
  if (done.status !== 200 || !done.data?.token) throw new Error(`Sign-in failed (${done.status}).`);
  const role = String(done.data.role || '').toLowerCase();
  if (role !== 'staff') {
    throw new Error(`Use a STAFF account for this test (this account's role is "${role}").`);
  }
  return done.data.token;
}

const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const FROM = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
const TO = ymd(today);
const R = `startDate=${FROM}&endDate=${TO}`;

const ALLOW = (s) => s >= 200 && s < 300;
const DENY = (s) => s === 401 || s === 403;

function checks(token) {
  const t = { token };
  return [
    // ── Own data: must work ──────────────────────────────────────────────
    ['own profile (/api/me)', ALLOW, () => call('GET', '/api/me/profile', t)],
    ['own DTR (/api/me)', ALLOW, () => call('GET', `/api/me/dtr?from=${FROM}&to=${TO}`, t)],
    ['own leave types', ALLOW, () => call('GET', '/api/me/leave-types', t)],
    ['own leave requests', ALLOW, () => call('GET', `/leaveRoute/leave_request/${ME}`, t)],
    ['own DTR (web route)', ALLOW, () => call('GET', `/attendance/api/dtr?personID=${ME}&${R}`, t)],
    ['own PDS', ALLOW, () => call('GET', `/personalinfo/person_table/${ME}`, t)],
    ['person list only contains self', ALLOW, async () => {
      const r = await call('GET', '/personalinfo/person_table', t);
      const rows = Array.isArray(r.data) ? r.data : [];
      const leaked = rows.filter((p) => String(p.agencyEmployeeNum).replace(/^0+/, '') !== String(ME).replace(/^0+/, ''));
      return leaked.length ? { status: 'LEAK', data: `${leaked.length} other employees returned` } : r;
    }],

    // ── Another employee's data: must be refused ───────────────────────
    ["other's DTR (query)", DENY, () => call('GET', `/attendance/api/dtr?personID=${OTHER}&${R}`, t)],
    ["other's attendance (body)", DENY, () => call('POST', '/attendance/api/view-attendance',
      { ...t, body: { personID: OTHER, startDate: FROM, endDate: TO } })],
    ['self in query + other in body', DENY, () => call('POST', `/attendance/api/view-attendance?personID=${ME}`,
      { ...t, body: { personID: OTHER, startDate: FROM, endDate: TO } })],
    ["other's PDS", DENY, () => call('GET', `/personalinfo/person_table/${OTHER}`, t)],
    ["other's children (PDS)", DENY, () => call('GET', `/ChildrenRoute/children-by-person/${OTHER}`, t)],
    ["other's leave requests", DENY, () => call('GET', `/leaveRoute/leave_request/${OTHER}`, t)],
    ["other's leave balances", DENY, () => call('GET', `/leaveRoute/leave_assignment/employee/${OTHER}`, t)],
    ["other's SC balance", DENY, () => call('GET', `/api/earnings/sc/${OTHER}/balance`, t)],
    ["other's notifications", DENY, () => call('GET', `/api/notifications/${OTHER}`, t)],

    // ── HR/admin-only: must be refused for staff ───────────────────────
    ['audit log (attendance)', DENY, () => call('GET', '/attendance/api/audit-log', t)],
    ['dashboard audit logs', DENY, () => call('GET', '/dashboard-audit/logs', t)],
    ['all PDS data', DENY, () => call('GET', '/allData/all_data', t)],
    ['all leave requests', DENY, () => call('GET', '/leaveRoute/leave_request', t)],
    ['leave table (admin)', DENY, () => call('GET', '/leaveRoute/leave_table', t)],
    ['released payroll (admin)', DENY, () => call('GET', '/PayrollReleasedRoute/released-payroll', t)],
    ['DTR employee list', DENY, () => call('GET', `/attendance/api/dtr-employee-list?${R}`, t)],
    ['all-users attendance', DENY, () => call('POST', '/attendance/api/view-attendance-all-users',
      { ...t, body: { startDate: FROM, endDate: TO } })],

    // ── No token / forged login: must be refused ───────────────────────
    ['audit log without token', DENY, () => call('GET', '/attendance/api/audit-log')],
    ['/api/me without token', DENY, () => call('GET', '/api/me/profile')],
    ['token without password/OTP (old bypass)', DENY, () => call('POST', '/complete-2fa-login',
      { body: { employeeNumber: OTHER, email: 'someone@example.com' } })],
  ];
}

(async () => {
  console.log(`HRIS security smoke test → ${BASE}\nStaff ${ME} vs other employee ${OTHER}\n`);
  const token = await signIn();
  let failed = 0;
  for (const [name, expect, run] of checks(token)) {
    let result;
    try {
      result = await run();
    } catch (e) {
      result = { status: `ERR ${e.message}` };
    }
    const ok = typeof result.status === 'number' && expect(result.status);
    if (!ok) failed += 1;
    const want = expect === ALLOW ? 'allow' : 'deny';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} expected ${want}, got ${result.status}${
      typeof result.data === 'string' ? ` (${result.data})` : ''}`);
  }
  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed.'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`Smoke test aborted: ${e.message}`);
  process.exit(2);
});
