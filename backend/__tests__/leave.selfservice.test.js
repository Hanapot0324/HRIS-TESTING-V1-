/**
 * Staff leave self-service authorization (synthetic data, DB mocked).
 * Spec §8: staff cannot approve, cannot act on another employee's request,
 * and may only withdraw their own request while it is still pending.
 */
process.env.JWT_SECRET = 'test-secret-do-not-use';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const mockStaff = { id: 1, employeeNumber: '1001', role: 'staff' };
const mockOther = { id: 2, employeeNumber: '1002', role: 'staff' };
const mockRequests = {
  10: { id: 10, employeeNumber: '1001', leave_code: 'VL', leave_date: '2026-11-03', status: 0 },
  11: { id: 11, employeeNumber: '1001', leave_code: 'VL', leave_date: '2026-11-04', status: 2 },
  12: { id: 12, employeeNumber: '1002', leave_code: 'VL', leave_date: '2026-11-05', status: 0 },
};
/** SQL statements that would change data — must stay empty for denied calls. */
const mockWrites = [];

function mockRows(sql, params) {
  if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
    mockWrites.push(sql);
    return { affectedRows: 1, insertId: 1 };
  }
  if (sql.includes('FROM users WHERE id = ?')) {
    const u = [mockStaff, mockOther].find((x) => x.id === params[0]);
    return u ? [{ employeeNumber: u.employeeNumber, role: u.role, email: null }] : [];
  }
  if (sql.includes('SELECT employeeNumber FROM users WHERE')) {
    const u = [mockStaff, mockOther].find((x) => params.includes(x.employeeNumber));
    return u ? [{ employeeNumber: u.employeeNumber }] : [];
  }
  if (sql.includes('SELECT * FROM leave_request WHERE id = ?')) {
    const r = mockRequests[params[0]];
    return r ? [{ ...r }] : [];
  }
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

const leaveRoutes = require('../routes/leave');

const app = express();
app.use(express.json());
app.use('/leaveRoute', leaveRoutes);

const auth = (u) => ({
  Authorization: `Bearer ${jwt.sign({ id: u.id, employeeNumber: u.employeeNumber, role: u.role }, process.env.JWT_SECRET)}`,
});

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
beforeEach(async () => {
  // Let any background work from the previous test (e.g. the cancel pipeline,
  // which keeps running after the response) finish before resetting.
  await new Promise((r) => setTimeout(r, 50));
  mockWrites.length = 0;
});

describe('PUT /leaveRoute/leave_request/:id as staff', () => {
  test.each([1, 2, 3])('cannot set status %i (approve/deny) on own request', async (status) => {
    const res = await request(app).put('/leaveRoute/leave_request/10').set(auth(mockStaff)).send({ status });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test("cannot cancel another employee's request", async () => {
    const res = await request(app).put('/leaveRoute/leave_request/12').set(auth(mockStaff)).send({ status: 4 });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('cannot cancel own request once HR has approved it', async () => {
    const res = await request(app).put('/leaveRoute/leave_request/11').set(auth(mockStaff)).send({ status: 4 });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('body cannot reassign the request to the caller', async () => {
    const res = await request(app)
      .put('/leaveRoute/leave_request/12')
      .set(auth(mockStaff))
      .send({ status: 4, employeeNumber: mockStaff.employeeNumber });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('can cancel own pending request (status claim is attempted)', async () => {
    await request(app).put('/leaveRoute/leave_request/10').set(auth(mockStaff)).send({ status: 4 });
    expect(mockWrites[0]).toMatch(/UPDATE leave_request SET status = \? WHERE id = \? AND status = \?/);
  });
});

describe('POST /leaveRoute/leave_request as staff', () => {
  test('cannot file for another employee', async () => {
    const res = await request(app)
      .post('/leaveRoute/leave_request')
      .set(auth(mockStaff))
      .send({ employeeNumber: mockOther.employeeNumber, leave_code: 'VL', leave_dates: ['2026-11-10'] });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
});

describe('admin-only leave endpoints reject staff', () => {
  test.each([
    ['get', '/leaveRoute/leave_table'],
    ['get', '/leaveRoute/leave_request'],
    ['post', '/leaveRoute/leave_assignment'],
    ['put', '/leaveRoute/leave_request/bulk-update'],
    ['delete', '/leaveRoute/leave_request/10'],
  ])('%s %s → 403', async (method, path) => {
    const res = await request(app)[method](path).set(auth(mockStaff)).send({});
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
});
