const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

/**
 * Short-lived "login ticket" that chains the login steps together:
 *   /login (password ok)        -> ticket stage 'password'
 *   /verify-2fa-code (code ok)  -> ticket stage 'mfa'
 *   /complete-2fa-login         -> consumes the ticket, issues the session JWT
 *
 * Without it, /complete-2fa-login minted a session token for anyone who knew an
 * employee number + email. Signed with a secret derived from JWT_SECRET so a
 * ticket can never be accepted by authenticateToken as a session token.
 */
const TICKET_SECRET = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('login-ticket')
  .digest('hex');
const TICKET_TTL_SECONDS = 15 * 60;

/** jti -> expiry (ms) of tickets already exchanged for a session token. */
const consumedTickets = new Map();

function pruneConsumed() {
  const now = Date.now();
  for (const [jti, exp] of consumedTickets) {
    if (exp <= now) consumedTickets.delete(jti);
  }
}

function issueLoginTicket({ userId, employeeNumber, email }, stage) {
  return jwt.sign(
    { purpose: 'login-ticket', uid: userId, employeeNumber, email, stage },
    TICKET_SECRET,
    { expiresIn: TICKET_TTL_SECONDS, jwtid: crypto.randomUUID() },
  );
}

/** Returns the ticket payload, or null when missing/invalid/expired/consumed. */
function verifyLoginTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return null;
  try {
    const payload = jwt.verify(ticket, TICKET_SECRET);
    if (payload.purpose !== 'login-ticket') return null;
    if (consumedTickets.has(payload.jti)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Marks a ticket single-use once it has been exchanged for a session token. */
function consumeLoginTicket(payload) {
  pruneConsumed();
  consumedTickets.set(payload.jti, payload.exp * 1000);
}

module.exports = {
  issueLoginTicket,
  verifyLoginTicket,
  consumeLoginTicket,
};
