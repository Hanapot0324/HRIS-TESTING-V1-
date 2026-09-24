const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

let io;

/**
 * Initialize Socket.IO server with authentication
 * @param {http.Server} server - HTTP server instance
 * @returns {SocketIO.Server} Socket.IO server instance
 */
function initializeSocket(server) {
  const allowedOrigins = [
    'http://localhost:5137',
    'http://192.168.50.36:5137',
    'http://192.168.50.45:5137',
    'http://136.239.248.42:5137',
    'http://192.168.50.49:5137',
  ];

  function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.indexOf(origin) !== -1) return true;
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
      if (u.hostname.startsWith('192.168.')) return true;
    } catch (_) {}
    return false;
  }

  io = socketIO(server, {
    cors: {
      origin: function (origin, callback) {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      console.error('Socket authentication failed: No token provided');
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.employeeNumber;
      socket.userRole = decoded.role;
      socket.username = decoded.username;

      console.log(
        `Socket authenticated: ${socket.userId} (${socket.userRole})`,
      );
      next();
    } catch (err) {
      console.error('Socket authentication failed:', err.message);
      next(new Error('Invalid token'));
    }
  });

  // Connection handler
  io.on('connection', (socket) => {
    console.log(`✓ User connected: ${socket.userId} [${socket.id}]`);

    // Join user-specific room based on employeeNumber (raw + normalized)
    socket.join(String(socket.userId || ''));
    const { normalizeEmployeeNumber } = require('../middleware/auth');
    const normalizedId = normalizeEmployeeNumber(socket.userId);
    if (normalizedId && normalizedId !== String(socket.userId || '')) {
      socket.join(normalizedId);
    }
    console.log(`  → User ${socket.userId} joined room: ${socket.userId}`);

    // Optional: Join role-based room
    if (socket.userRole) {
      socket.join(`role:${socket.userRole}`);
      console.log(
        `  → User ${socket.userId} joined role room: ${socket.userRole}`,
      );
    }

    // Handle client ping for testing
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date(), userId: socket.userId });
    });

    // Disconnect handler
    socket.on('disconnect', (reason) => {
      console.log(
        `✗ User disconnected: ${socket.userId} [${socket.id}] - Reason: ${reason}`,
      );
    });

    // Error handler
    socket.on('error', (error) => {
      console.error(`Socket error for user ${socket.userId}:`, error);
    });
  });

  console.log('Socket.IO server initialized successfully');
  return io;
}

/**
 * Get the Socket.IO server instance
 * @returns {SocketIO.Server} Socket.IO server instance
 */
function getIO() {
  if (!io) {
    throw new Error(
      'Socket.IO has not been initialized. Call initializeSocket() first.',
    );
  }
  return io;
}

module.exports = { initializeSocket, getIO };
