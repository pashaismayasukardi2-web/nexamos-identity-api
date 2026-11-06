'use strict';

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');

const usersRouter         = require('./modules/users/users.routes');
const organizationsRouter = require('./modules/organizations/organizations.routes');
const entitlementsRouter  = require('./modules/entitlements/entitlements.routes');
const legacyRouter        = require('./modules/legacy/legacy.routes');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Izinkan request tanpa origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    // Izinkan localhost port berapapun untuk development
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ── Rate Limiter Global ───────────────────────────────────────
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { status: 'error', message: 'Too many requests. Please try again later.' },
});
app.use(limiter);

// ── Body Parser ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'nexamos-identity-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── API v1 Routes ─────────────────────────────────────────────
app.use('/api/v1/users',         usersRouter);
app.use('/api/v1/organizations', organizationsRouter);
app.use('/api/v1/entitlements',  entitlementsRouter);
app.use('/api/v1/legacy',        legacyRouter);   // internal — legacy CRM linking

// ── 404 Handler ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ status: 'error', message: 'Endpoint not found.' });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Identity API Error]', err.message);
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NexaMOS Identity API] Running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

module.exports = app;

