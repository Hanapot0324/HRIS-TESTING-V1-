/**
 * S2 — attendance/DTR access policy (synthetic data, DB mocked).
 * Staff see only their own attendance; supervisors may view (not edit) their
 * department; everything that edits/syncs/reports is HR/admin-only.
 */
process.env.JWT_SECRET = 'test-secret-do-not-use';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const mockUsers = {
  1: { id: 1, employeeNumber: '1001', role: 'staff' }, // in dept CCS
  2: { id: 2, employeeNumber: '1002', role: 'staff' }, // other dept
  3: { id: 3, employeeNumber: '2001', role: 'staff' }, // supervisor of CCS
  9: { id: 9, employeeNumber: '9001', role: 'administrator' },
};
/** Queries that reached attendance data (anything not an auth/scope lookup). */
const mockDataQueries = [];

function mockRows(sql, params = []) {
  if (sql.includes('FROM users WHERE id = ?')) {
    const u = mockUsers[params[0]];
    return u ? [{ employeeNumber: u.employeeNumber, role: u.role, email: null }] : [];
  }
  if (sql.includes('SELECT employeeNumber FROM users WHERE')) {
    const u = Object.values(mockUsers).find((x) => params.includes(x.employeeNumber));
    return u ? [{ employeeNumber: u.employeeNumber }] : [];
  }
  if (sql.includes('FROM supervisor_assignment')) {
    return params.includes('2001')
      ? [{ departmentCode: 'CCS', role: 'head', status: 0, departmentDescription: 'CCS' }]
      : [];
  }
  if (sql.includes('FROM department_assignment WHERE code IN')) {
    return [{ employeeNumber: '1001' }, { employeeNumber: '2001' }];
  }
  mockDataQueries.push({ sql, params });
  return [];
}

jest.mock('../db', () => {
  const query = (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    setImmediate(() => cb(null, mockRows(sql, params || [])));
  };
  return { query, promise: () => ({ query: async (sql, params) => [mockRows(sql, params || [])] }) };
});
jest.mock('../socket/socketService', () => new Proxy({}, { get: () => jest.fn() }));
jest.mock('../socket/attendanceRecordInfoSocketApi', () => new Proxy({}, { get: () => jest.fn() }));

const attendanceRoutes = require('../dashboardRoutes/Attendance');

const app = express();
app.use(express.json());
app.use('/attendance', attendanceRoutes);

const tokenFor = (u, opts = {}) =>
  jwt.sign({ id: u.id, employeeNumber: u.employeeNumber, role: u.role }, process.env.JWT_SECRET, opts);
const as = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });
const STAFF = mockUsers[1];
const OTHER = mockUsers[2];
const SUP = mockUsers[3];
const ADMIN = mockUsers[9];
const range = 'startDate=2026-10-01&endDate=2026-10-15';

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
beforeEach(async () => {
  // Allowed calls write an audit row after responding; let it land first.
  await new Promise((r) => setTimeout(r, 20));
  mockDataQueries.length = 0;
});

describe('staff: own records only', () => {
  test('can read own DTR', async () => {
    const res = await request(app).get(`/attendance/api/dtr?personID=1001&${range}`).set(as(STAFF));
    expect([200, 304]).toContain(res.status);
  });

  test.each([
    ['get', `/attendance/api/dtr?personID=1002&${range}`, null],
    ['get', `/attendance/api/attendance?personId=1002&${range}`, null],
    ['get', `/attendance/api/overall_attendance_record?personID=1002&${range}`, null],
    ['post', '/attendance/api/view-attendance', { personID: '1002', startDate: '2026-10-01', endDate: '2026-10-15' }],
    ['post', '/attendance/api/attendance-raw-batch', { personIDs: ['1001', '1002'], startDate: '2026-10-01', endDate: '2026-10-15' }],
  ])("cannot read another employee's attendance: %s %s", async (method, url, body) => {
    const res = await request(app)[method](url).set(as(STAFF)).send(body || {});
    expect(res.status).toBe(403);
    expect(mockDataQueries).toEqual([]);
  });

  test('self in the query + victim in the body is rejected', async () => {
    const res = await request(app)
      .post('/attendance/api/view-attendance?personID=1001')
      .set(as(STAFF))
      .send({ personID: '1002', startDate: '2026-10-01', endDate: '2026-10-15' });
    expect(res.status).toBe(403);
    expect(mockDataQueries).toEqual([]);
  });

  test('a single-employee read without an employee is rejected (no "everyone")', async () => {
    const res = await request(app).get(`/attendance/api/dtr?${range}`).set(as(STAFF));
    expect(res.status).toBe(400);
    expect(mockDataQueries).toEqual([]);
  });

  test('leave overlay without an employee is scoped to the caller', async () => {
    const res = await request(app).get(`/attendance/api/leaves?${range}`).set(as(STAFF));
    expect(res.status).toBe(200);
    const leaveQuery = mockDataQueries.find((q) => q.sql.includes('FROM leave_request'));
    expect(leaveQuery.sql).toContain('lr.employeeNumber = ?');
    expect(leaveQuery.params).toContain('1001');
  });

  test.each([
    ['put', '/attendance/api/view-attendance'],
    ['post', '/attendance/api/save-attendance'],
    ['post', '/attendance/api/update-attendance'],
    ['post', '/attendance/api/send-to-dtr'],
    ['post', '/attendance/api/bulk-send-to-dtr'],
    ['patch', '/attendance/api/attendance-record-state'],
    ['post', '/attendance/api/force-sync-from-device'],
    ['post', '/attendance/api/all-attendance'],
    ['put', '/attendance/api/overall_attendance_record/daily-late-undertime'],
    ['delete', '/attendance/api/overall_attendance_record/1/1001'],
    ['post', '/attendance/api/view-attendance-all-users'],
    ['get', '/attendance/api/dtr-employee-list'],
    ['get', '/attendance/api/audit-log'],
    ['get', '/attendance/api/some-route-added-later'],
  ])('HR-only: %s %s → 403 with no data access', async (method, url) => {
    const res = await request(app)[method](url).set(as(STAFF)).send({ personID: '1001', records: [] });
    expect(res.status).toBe(403);
    expect(mockDataQueries).toEqual([]);
  });

  test('shared calendars stay available', async () => {
    const res = await request(app).get(`/attendance/api/holiday?${range}`).set(as(STAFF));
    expect(res.status).not.toBe(403);
  });
});

describe('supervisor: read-only view of own department', () => {
  test('can view a department employee', async () => {
    const res = await request(app)
      .post('/attendance/api/view-attendance')
      .set(as(SUP))
      .send({ personID: '1001', startDate: '2026-10-01', endDate: '2026-10-15' });
    expect(res.status).toBe(200);
  });

  test('cannot view someone outside their departments', async () => {
    const res = await request(app)
      .post('/attendance/api/view-attendance')
      .set(as(SUP))
      .send({ personID: '1002', startDate: '2026-10-01', endDate: '2026-10-15' });
    expect(res.status).toBe(403);
  });

  test('paged DTR: department list allowed, any outsider rejects the whole call', async () => {
    const body = { startDate: '2026-10-01', endDate: '2026-10-15', skipCount: true, skipAudit: true };
    const ok = await request(app).post('/attendance/api/view-attendance-all-users-paged')
      .set(as(SUP)).send({ ...body, employeeNumbers: ['1001', '2001'] });
    expect(ok.status).not.toBe(403);

    mockDataQueries.length = 0;
    const bad = await request(app).post('/attendance/api/view-attendance-all-users-paged')
      .set(as(SUP)).send({ ...body, employeeNumbers: ['1001', '1002'] });
    expect(bad.status).toBe(403);
    expect(mockDataQueries).toEqual([]);
  });

  test('paged DTR without an explicit list is rejected (no "all users")', async () => {
    const res = await request(app).post('/attendance/api/view-attendance-all-users-paged')
      .set(as(SUP)).send({ startDate: '2026-10-01', endDate: '2026-10-15' });
    expect(res.status).toBe(400);
    expect(mockDataQueries).toEqual([]);
  });

  test('still cannot edit attendance', async () => {
    const res = await request(app).put('/attendance/api/view-attendance')
      .set(as(SUP)).send({ records: [{ personID: '1001' }] });
    expect(res.status).toBe(403);
    expect(mockDataQueries).toEqual([]);
  });
});

describe('authentication and admin', () => {
  test('audit log is no longer readable without a token', async () => {
    const res = await request(app).get('/attendance/api/audit-log');
    expect(res.status).toBe(401);
    expect(mockDataQueries).toEqual([]);
  });

  test('expired token is rejected', async () => {
    const expired = tokenFor(STAFF, { expiresIn: -10 });
    const res = await request(app).get(`/attendance/api/dtr?personID=1001&${range}`)
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });

  test('HR/admin keeps full access', async () => {
    const log = await request(app).get('/attendance/api/audit-log').set(as(ADMIN));
    expect(log.status).toBe(200);
    const other = await request(app).get(`/attendance/api/dtr?personID=1002&${range}`).set(as(ADMIN));
    expect(other.status).toBe(200);
  });

  test('another staff member is not treated as a supervisor', async () => {
    const res = await request(app).get(`/attendance/api/dtr?personID=1001&${range}`).set(as(OTHER));
    expect(res.status).toBe(403);
  });
});
