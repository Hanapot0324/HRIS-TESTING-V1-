/**
 * Login flow authorization tests (synthetic data, DB mocked — no MySQL needed).
 * Covers the §4 / §8 rules: no token without password + OTP, no account
 * enumeration, no OTP brute force, no ticket replay, ticket != session token.
 */
process.env.JWT_SECRET = 'test-secret-do-not-use';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const PASSWORD_HASH = bcrypt.hashSync('Correct#Pass1', 4);
const mockUser = {
  id: 7,
  employeeNumber: '1001',
  email: 'staff.a@example.test',
  password: PASSWORD_HASH,
  role: 'staff',
  firstName: 'Ana',
  middleName: null,
  lastName: 'Staff',
  nameExtension: null,
  fullName: 'Ana Staff',
  isDefaultPassword: 0,
};

// Mutable per-test settings read by the fake DB.
const mockState = { globalMfa: 'true', userMfa: null };

function mockRows(sql, params) {
  if (sql.includes("setting_key = 'global_mfa_enabled'")) {
    return [{ setting_value: mockState.globalMfa }];
  }
  if (sql.includes('FROM user_preferences')) {
    return mockState.userMfa === null ? [] : [{ enable_mfa: mockState.userMfa }];
  }
  if (sql.includes('FROM users u')) {
    return params.includes(mockUser.employeeNumber) ? [mockUser] : [];
  }
  return [];
}

jest.mock('../db', () => {
  const query = (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    setImmediate(() => cb(null, mockRows(sql, params || [])));
  };
  return {
    query,
    promise: () => ({
      query: async (sql, params) => [mockRows(sql, params || [])],
    }),
  };
});
jest.mock('../config/email', () => ({ sendMail: jest.fn(async () => ({})) }));
jest.mock('../socket/socketService', () => ({
  broadcastNewAuditLog: jest.fn(),
  broadcastNewAdminActionTrail: jest.fn(),
}));

const transporter = require('../config/email');
const { twoFACodes } = require('../utils/verificationCodes');
const authRoutes = require('../routes/auth');
const { authenticateToken } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use('/', authRoutes);
app.get('/protected', authenticateToken, (req, res) => res.json({ ok: true }));

beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => {}));

beforeEach(() => {
  mockState.globalMfa = 'true';
  mockState.userMfa = null;
  for (const k of Object.keys(twoFACodes)) delete twoFACodes[k];
  transporter.sendMail.mockClear();
});

async function passwordStep() {
  const res = await request(app)
    .post('/login')
    .send({ employeeNumber: mockUser.employeeNumber, password: 'Correct#Pass1' });
  expect(res.status).toBe(200);
  expect(res.body.loginTicket).toEqual(expect.any(String));
  return res.body.loginTicket;
}

describe('POST /login', () => {
  test('unknown account and wrong password return the same generic error', async () => {
    const unknown = await request(app).post('/login').send({ employeeNumber: '9999', password: 'x' });
    const wrong = await request(app)
      .post('/login')
      .send({ employeeNumber: mockUser.employeeNumber, password: 'wrong' });
    expect(unknown.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.loginTicket).toBeUndefined();
  });
});

describe('POST /complete-2fa-login', () => {
  test('rejects employeeNumber + email without a ticket (the original bypass)', async () => {
    const res = await request(app)
      .post('/complete-2fa-login')
      .send({ employeeNumber: mockUser.employeeNumber, email: mockUser.email });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test('rejects a forged ticket signed with the session JWT secret', async () => {
    const forged = jwt.sign(
      { purpose: 'login-ticket', stage: 'mfa', employeeNumber: mockUser.employeeNumber, email: mockUser.email },
      process.env.JWT_SECRET,
      { jwtid: 'x' },
    );
    const res = await request(app).post('/complete-2fa-login').send({ loginTicket: forged });
    expect(res.status).toBe(401);
  });

  test('a password-only ticket is rejected while MFA is required', async () => {
    const ticket = await passwordStep();
    const res = await request(app).post('/complete-2fa-login').send({ loginTicket: ticket });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test('a password-only ticket is accepted when MFA is disabled globally', async () => {
    mockState.globalMfa = 'false';
    const ticket = await passwordStep();
    const res = await request(app).post('/complete-2fa-login').send({ loginTicket: ticket });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('a password-only ticket is accepted when the user disabled MFA', async () => {
    mockState.userMfa = 0;
    const ticket = await passwordStep();
    const res = await request(app).post('/complete-2fa-login').send({ loginTicket: ticket });
    expect(res.status).toBe(200);
  });
});

describe('full password + OTP flow', () => {
  async function otpStep() {
    const ticket = await passwordStep();
    const sent = await request(app).post('/send-2fa-code').send({ loginTicket: ticket });
    expect(sent.status).toBe(200);
    return { ticket, code: twoFACodes[mockUser.email].code };
  }

  test('issues a working session token and the ticket is single-use', async () => {
    const { ticket, code } = await otpStep();
    const verified = await request(app).post('/verify-2fa-code').send({ loginTicket: ticket, code });
    expect(verified.status).toBe(200);
    const mfaTicket = verified.body.loginTicket;

    const done = await request(app).post('/complete-2fa-login').send({ loginTicket: mfaTicket });
    expect(done.status).toBe(200);
    expect(done.body.employeeNumber).toBe(mockUser.employeeNumber);

    const ok = await request(app).get('/protected').set('Authorization', `Bearer ${done.body.token}`);
    expect(ok.status).toBe(200);

    const replay = await request(app).post('/complete-2fa-login').send({ loginTicket: mfaTicket });
    expect(replay.status).toBe(401);
  });

  test('a login ticket is not accepted as a session token', async () => {
    const ticket = await passwordStep();
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${ticket}`);
    expect(res.status).toBe(403);
  });

  test('the OTP code is single-use', async () => {
    const { ticket, code } = await otpStep();
    await request(app).post('/verify-2fa-code').send({ loginTicket: ticket, code });
    const again = await request(app).post('/verify-2fa-code').send({ loginTicket: ticket, code });
    expect(again.status).toBe(400);
  });

  test('the OTP is invalidated after 5 wrong guesses', async () => {
    const { ticket, code } = await otpStep();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/verify-2fa-code').send({ loginTicket: ticket, code: wrong });
    }
    const res = await request(app).post('/verify-2fa-code').send({ loginTicket: ticket, code });
    expect(res.status).toBe(400);
  });
});

describe('POST /send-2fa-code', () => {
  test('cannot send OTP emails for an arbitrary account without a ticket', async () => {
    const res = await request(app)
      .post('/send-2fa-code')
      .send({ employeeNumber: mockUser.employeeNumber, email: mockUser.email });
    expect(res.status).toBe(401);
    expect(transporter.sendMail).not.toHaveBeenCalled();
  });
});
