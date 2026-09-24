// db.js
const mysql = require('mysql2');
require('dotenv').config();

const getDbHost = () => {
  if (process.env.NODE_ENV === 'production') {
    return process.env.DB_HOST_PUBLIC;
  } else if (process.env.NODE_ENV === 'local') {
    return process.env.DB_HOST_LOCAL;
  } else {
    return 'localhost'; // fallback
  }
};

/** Pool sized for concurrent HRIS use (attendance + auth + sockets). */
const connectionLimit = Math.max(
  10,
  parseInt(process.env.DB_CONNECTION_LIMIT || '40', 10) || 40,
);
/**
 * Requests waiting for a free connection. Past this, queries fail immediately
 * with "Queue limit reached" (HTTP 500). 200 was hit by an ordinary burst of
 * users opening pages at once (each page load runs several queries), so allow
 * a deeper queue: a short wait is better than an error.
 */
const queueLimit = Math.max(
  0,
  parseInt(process.env.DB_QUEUE_LIMIT || '1000', 10) || 1000,
);

const pool = mysql.createPool({
  host: getDbHost(),
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit,
  queueLimit,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], // To avoide timezone issues
});

module.exports = pool;
