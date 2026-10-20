/**
 * Staff self-service (/api/me) authorization tests — synthetic data, DB mocked.
 * Core rule (spec §4): identity comes from the verified token only; a client
 * cannot point these routes at another employee by adding IDs to the request.
 */
process.env.JWT_SECRET = 'test-secret-do-not-use';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const mockUsers = {
  1: { id: 1, employeeNumber: '1001', role: 'staff', email: 'a@example.test', sex: 'Male' },
  2: { id: 2, employeeNumber: '1002', role: 'staff', email: 'b@example.test', sex: 'Female' },
};
const mockLeaveTable = [
  { id: 1, leave_code: 'MAT', leave_description: 'Maternity Leave', gender_restriction: 'Female' },
  { id: 2, leave_code: 'PAT', leave_description: 'Paternity Leave', gender_restriction: 'Male' },
  { id: 3, leave_code: 'VL', leave_description: 'Vacation Leave', gender_restriction: null },
];
/** Every query the routes run: { sql, params } — used to prove which employee was queried. */
const mockQueries = [];

function mockByEmp(params) {
  return Object.values(mockUsers).find((u) => params.includes(u.employeeNumber));
}

function mockRows(sql, params) {
  mockQueries.push({ sql, params });
  if (sql.includes('FROM users WHERE id = ?')) {
    const u = mockUsers[params[0]];
    return u ? [{ employeeNumber: u.employeeNumber, role: u.role, email: u.email }] : [];
  }
  if (sql.includes('SELECT employeeNumber FROM users WHERE')) {
    const u = mockByEmp(params);
    return u ? [{ employeeNumber: u.employeeNumber }] : [];
  }
  if (sql.includes('FROM users u') && sql.includes('person_table p')) {
    const u = mockByEmp(params);
    return u ? [{ employeeNumber: u.employeeNumber, firstName: `Emp${u.id}`, email: u.email }] : [];
  }
  if (sql.includes('FROM attendancerecord ar')) {
    const u = mockByEmp(params);
    return u ? [{ date: '2026-10-01', day: 'Thursday', timeIN: '08:00', timeOUT: '17:00' }] : [];
  }
  if (sql.includes('SELECT p.sex FROM person_table')) {
    const u = mockByEmp(params);
    return u ? [{ sex: u.sex }] : [];
  }
  if (sql.includes('FROM leave_table')) return mockLeaveTable;
  return [];
}

jest.mock('../db', () => {
  const query = (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    setImmediate(() => cb(null, mockRows(sql, params || [])));
  };
  return { query, promise: () => ({ query: async (sql, params) => [mockRows(sql, params || [])] }) };
});
jest.mock('../socket/socketService', () => ({
  broadcastNewAuditLog: jest.fn(),
  broadcastNewAdminActionTrail: jest.fn(),
}));

const meRoutes = require('../routes/me');

const app = express();
app.use(express.json());
app.use('/api/me', meRoutes);

function tokenFor(user, opts = {}) {
  return jwt.sign(
    { id: user.id, employeeNumber: user.employeeNumber, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h', ...opts },
  );
}
const A = mockUsers[1];
const B = mockUsers[2];
const auth = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

/** True if any query the route ran was parameterised with employee B's number. */
const queriedB = () => mockQueries.some((q) => (q.params || []).includes(B.employeeNumber));

beforeEach(() => { mockQueries.length = 0; });

describe('authentication', () => {
  test.each(['/profile', '/dtr?from=2026-10-01&to=2026-10-31', '/leave-types'])(
    '%s rejects a missing token',
    async (path) => {
      const res = await request(app).get(`/api/me${path}`);
      expect(res.status).toBe(401);
    },
  );

  test('rejects an expired token', async () => {
    const expired = tokenFor(A, { expiresIn: -10 });
    const res = await request(app).get('/api/me/profile').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });

  test('rejects a token signed with another secret', async () => {
    const bad = jwt.sign({ id: 1, employeeNumber: '1001', role: 'staff' }, 'attacker');
    const res = await request(app).get('/api/me/profile').set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(403);
  });

  test('denies when the token carries no resolvable employee', async () => {
    const anon = jwt.sign({ role: 'staff' }, process.env.JWT_SECRET);
    const res = await request(app).get('/api/me/profile').set('Authorization', `Bearer ${anon}`);
    expect(res.status).toBe(403);
  });
});

describe('ownership — staff A cannot reach staff B', () => {
  test('profile returns only the caller, ignoring injected identifiers', async () => {
    const res = await request(app)
      .get(`/api/me/profile?employeeNumber=${B.employeeNumber}&personID=${B.employeeNumber}`)
      .set(auth(A));
    expect(res.status).toBe(200);
    expect(res.body.employeeNumber).toBe(A.employeeNumber);
    expect(queriedB()).toBe(false);
  });

  test('DTR returns only the caller, ignoring injected identifiers', async () => {
    const res = await request(app)
      .get(`/api/me/dtr?from=2026-10-01&to=2026-10-31&personID=${B.employeeNumber}&employeeNumber=${B.employeeNumber}`)
      .set(auth(A));
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(queriedB()).toBe(false);
  });

  test('leave types are filtered by the caller’s own record', async () => {
    const res = await request(app)
      .get(`/api/me/leave-types?employeeNumber=${B.employeeNumber}`)
      .set(auth(A));
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.leave_code)).toEqual(['PAT', 'VL']);
    expect(queriedB()).toBe(false);
  });

  test('leave types expose only id, code and description', async () => {
    const res = await request(app).get('/api/me/leave-types').set(auth(B));
    expect(res.body.map((t) => t.leave_code)).toEqual(['MAT', 'VL']);
    for (const t of res.body) expect(Object.keys(t).sort()).toEqual(['id', 'leave_code', 'leave_description']);
  });
});

describe('DTR input validation', () => {
  test.each([
    ['missing dates', ''],
    ['bad format', '?from=10/01/2026&to=2026-10-31'],
    ['impossible date', '?from=2026-02-30&to=2026-03-01'],
    ['reversed range', '?from=2026-10-31&to=2026-10-01'],
    ['range over 62 days', '?from=2026-01-01&to=2026-12-31'],
  ])('%s → 400 with no DB query', async (_label, qs) => {
    const res = await request(app).get(`/api/me/dtr${qs}`).set(auth(A));
    expect(res.status).toBe(400);
    expect(mockQueries.some((q) => q.sql.includes('attendancerecord'))).toBe(false);
  });
});

describe('read-only surface', () => {
  test.each(['post', 'put', 'patch', 'delete'])('%s /api/me/profile is not routed', async (method) => {
    const res = await request(app)[method]('/api/me/profile').set(auth(A)).send({ role: 'superadmin' });
    expect(res.status).toBe(404);
  });
});
