/**
 * S3 — PDS / personal information ownership (synthetic data, DB mocked).
 * Staff may read and change only their own PDS rows; HR/admin keep full access.
 */
process.env.JWT_SECRET = 'test-secret-do-not-use';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const mockUsers = {
  1: { id: 1, employeeNumber: '1001', role: 'staff' },
  2: { id: 2, employeeNumber: '1002', role: 'staff' },
  9: { id: 9, employeeNumber: '9001', role: 'administrator' },
};
const mockChildren = {
  4: { id: 4, person_id: '1001', childrenFirstName: 'Own' },
  5: { id: 5, person_id: '1002', childrenFirstName: 'Other' },
};
const mockPersons = {
  10: { id: 10, agencyEmployeeNum: '1001', firstName: 'Ana' },
  11: { id: 11, agencyEmployeeNum: '1002', firstName: 'Ben' },
};
/** Data-changing statements that reached the DB. */
const mockWrites = [];

function mockRows(sql, params = []) {
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
    mockWrites.push({ sql, params });
    return { affectedRows: 1, insertId: 99 };
  }
  if (sql.includes('FROM users WHERE id = ?')) {
    const u = mockUsers[params[0]];
    return u ? [{ employeeNumber: u.employeeNumber, role: u.role, email: null }] : [];
  }
  if (sql.includes('SELECT employeeNumber FROM users WHERE')) {
    const u = Object.values(mockUsers).find((x) => params.includes(x.employeeNumber));
    return u ? [{ employeeNumber: u.employeeNumber }] : [];
  }
  if (sql.includes('AS owner FROM children_table')) {
    const r = mockChildren[params[0]];
    return r ? [{ owner: r.person_id }] : [];
  }
  if (sql.includes('AS owner FROM person_table')) {
    const r = mockPersons[params[0]];
    return r ? [{ owner: r.agencyEmployeeNum }] : [];
  }
  if (/SELECT \* FROM `?children_table`? WHERE id/.test(sql)) return [mockChildren[params[0]]].filter(Boolean);
  if (/SELECT \* FROM `?person_table`? WHERE id/.test(sql)) return [mockPersons[params[0]]].filter(Boolean);
  if (sql.includes('SELECT * FROM children_table')) return Object.values(mockChildren);
  if (sql.includes('SELECT * FROM person_table WHERE agencyEmployeeNum')) {
    return Object.values(mockPersons).filter((p) => p.agencyEmployeeNum === params[0]);
  }
  if (sql.includes('SELECT * FROM person_table')) return Object.values(mockPersons);
  if (sql.includes('FROM employment_category')) {
    return [{ id: 1, employeeNumber: '1001' }, { id: 2, employeeNumber: '1002' }];
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

const app = express();
app.use(express.json());
app.use('/ChildrenRoute', require('../dashboardRoutes/Children'));
app.use('/personalinfo', require('../dashboardRoutes/PersonalInfo'));
app.use('/dashboard-audit', require('../dashboardRoutes/DashboardAuditRoute'));
app.use('/allData', require('../dashboardRoutes/DataRoute'));
app.use('/EmploymentCategoryRoutes', require('../dashboardRoutes/EmployeeCategory'));

const as = (u) => ({
  Authorization: `Bearer ${jwt.sign({ id: u.id, employeeNumber: u.employeeNumber, role: u.role }, process.env.JWT_SECRET)}`,
});
const STAFF = mockUsers[1];
const ADMIN = mockUsers[9];

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20)); // let audit side-effects settle
  mockWrites.length = 0;
});

describe('section tables (children as the representative)', () => {
  test('list returns only the caller’s rows', async () => {
    const res = await request(app).get('/ChildrenRoute/children-table').set(as(STAFF));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual([4]);
  });

  test('by-person for someone else → 403', async () => {
    const res = await request(app).get('/ChildrenRoute/children-by-person/1002').set(as(STAFF));
    expect(res.status).toBe(403);
  });

  test('cannot create a row for another employee', async () => {
    const res = await request(app).post('/ChildrenRoute/children-table').set(as(STAFF))
      .send({ childrenFirstName: 'X', childrenLastName: 'Y', person_id: '1002' });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('a create without person_id is pinned to the caller', async () => {
    const res = await request(app).post('/ChildrenRoute/children-table').set(as(STAFF))
      .send({ childrenFirstName: 'X', childrenLastName: 'Y' });
    expect(res.status).toBe(201);
    expect(mockWrites[0].params).toContain('1001');
  });

  test("cannot edit or delete another employee's row", async () => {
    const put = await request(app).put('/ChildrenRoute/children-table/5').set(as(STAFF))
      .send({ childrenFirstName: 'Hacked', person_id: '1002' });
    const del = await request(app).delete('/ChildrenRoute/children-table/5').set(as(STAFF));
    expect(put.status).toBe(403);
    expect(del.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('cannot move own row to another employee', async () => {
    const res = await request(app).put('/ChildrenRoute/children-table/4').set(as(STAFF))
      .send({ childrenFirstName: 'Own', person_id: '1002' });
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });

  test('can edit own row', async () => {
    const res = await request(app).put('/ChildrenRoute/children-table/4').set(as(STAFF))
      .send({ childrenFirstName: 'Own2', person_id: '1001' });
    expect(res.status).toBe(200);
    expect(mockWrites.some((w) => w.sql.startsWith('UPDATE children_table'))).toBe(true);
  });

  test('admin keeps full access', async () => {
    const list = await request(app).get('/ChildrenRoute/children-table').set(as(ADMIN));
    expect(list.body).toHaveLength(2);
    const put = await request(app).put('/ChildrenRoute/children-table/5').set(as(ADMIN))
      .send({ childrenFirstName: 'Fix', person_id: '1002' });
    expect(put.status).toBe(200);
  });
});

describe('person_table', () => {
  test('list returns only the caller', async () => {
    const res = await request(app).get('/personalinfo/person_table').set(as(STAFF));
    expect(res.body.map((p) => p.agencyEmployeeNum)).toEqual(['1001']);
  });

  test("cannot read another employee's PDS", async () => {
    const res = await request(app).get('/personalinfo/person_table/1002').set(as(STAFF));
    expect(res.status).toBe(403);
  });

  test("cannot update another employee's PDS by employee number or by id", async () => {
    const a = await request(app).put('/personalinfo/person_table/by-employee/1002').set(as(STAFF)).send({ firstName: 'X' });
    const b = await request(app).put('/personalinfo/person_table/11').set(as(STAFF)).send({ firstName: 'X' });
    const c = await request(app).put('/personalinfo/person/1002').set(as(STAFF)).send({ firstName: 'X', lastName: 'Y' });
    expect([a.status, b.status, c.status]).toEqual([403, 403, 403]);
    expect(mockWrites).toEqual([]);
  });

  test('own profile save cannot change the employee number', async () => {
    const res = await request(app).put('/personalinfo/person_table/by-employee/1001').set(as(STAFF))
      .send({ firstName: 'Ana', agencyEmployeeNum: '9999' });
    expect(res.status).not.toBe(403);
    const update = mockWrites.find((w) => w.sql.includes('UPDATE person_table'));
    expect(update.params).not.toContain('9999');
  });

  test('staff cannot delete PDS records or another profile picture', async () => {
    const del = await request(app).delete('/personalinfo/person_table/10').set(as(STAFF));
    const pic = await request(app).delete('/personalinfo/remove-profile-picture/11').set(as(STAFF));
    expect([del.status, pic.status]).toEqual([403, 403]);
    expect(mockWrites).toEqual([]);
  });
});

describe('organisation-wide reads are HR-only', () => {
  test.each([
    '/dashboard-audit/logs',
    '/allData/all_data',
    '/allData/all_data2',
    '/EmploymentCategoryRoutes/employment-category/search/ana',
  ])('%s → 403 for staff', async (url) => {
    const res = await request(app).get(url).set(as(STAFF));
    expect(res.status).toBe(403);
  });

  test('employment category list is scoped to the caller', async () => {
    const res = await request(app).get('/EmploymentCategoryRoutes/employment-category').set(as(STAFF));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.employeeNumber)).toEqual(['1001']);
  });
});
