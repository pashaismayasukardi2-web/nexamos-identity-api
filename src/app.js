'use strict';

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { getPool } = require('./config/database');
const { getUserCacheStats } = require('./middleware/requireOIDC');

const usersRouter         = require('./modules/users/users.routes');
const organizationsRouter = require('./modules/organizations/organizations.routes');
const entitlementsRouter  = require('./modules/entitlements/entitlements.routes');
const legacyRouter        = require('./modules/legacy/legacy.routes');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Trust Proxy & Security Headers ────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── Phase 6 Observability: Request Metrics & Error Rate Tracker ──
const _metrics = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  totalErrors5xx: 0,
  totalAuthFailures4xx: 0,
  recentWindowStart: Date.now(),
  windowRequests: 0,
  windowErrors5xx: 0,
};

const ERROR_RATE_THRESHOLD_PERCENT = Number(process.env.ERROR_RATE_ALERT_THRESHOLD) || 5; // 5%

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    _metrics.totalRequests += 1;

    // Reset sliding 5-minute window
    if (Date.now() - _metrics.recentWindowStart > 5 * 60 * 1000) {
      _metrics.recentWindowStart = Date.now();
      _metrics.windowRequests = 0;
      _metrics.windowErrors5xx = 0;
    }
    _metrics.windowRequests += 1;

    if (res.statusCode >= 500) {
      _metrics.totalErrors5xx += 1;
      _metrics.windowErrors5xx += 1;
      const errRate = (_metrics.windowErrors5xx / Math.max(_metrics.windowRequests, 1)) * 100;
      if (_metrics.windowRequests >= 10 && errRate > ERROR_RATE_THRESHOLD_PERCENT) {
        console.error(
          `[ALERT][HIGH_ERROR_RATE] Identity API 5xx error rate is ${errRate.toFixed(1)}% (${_metrics.windowErrors5xx}/${_metrics.windowRequests}) > ${ERROR_RATE_THRESHOLD_PERCENT}% threshold!`
        );
      }
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      _metrics.totalAuthFailures4xx += 1;
    }

    if (req.path !== '/health') {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          service: 'nexamos-identity-api',
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          duration_ms: durationMs,
          ip: req.headers['x-forwarded-for'] || req.ip,
        })
      );
    }
  });
  next();
});

// ── Phase 6 Security: Strict CORS Allowlist (Zero Wildcard `*`) ──
const defaultAllowedOrigins = [
  'https://nexamos.cloud',
  'https://workspace.nexamos.cloud',
  'https://crm.nexamos.cloud',
  'https://studio.nexamos.cloud',
  'https://demo.nexamos.cloud',
  'https://superadmin.nexamos.cloud',
  'https://identity.nexamos.cloud',
];

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(o => Boolean(o) && o !== '*'); // Tolak wildcard '*'

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envOrigins]));

app.use(cors({
  origin: (origin, callback) => {
    // Izinkan request server-to-server tanpa header Origin
    if (!origin) return callback(null, true);
    // Izinkan localhost hanya saat development
    if (
      process.env.NODE_ENV !== 'production' &&
      (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
    ) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ── Phase 6 Security: Layered Rate Limiting ────────────────────
const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX) || 150,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { status: 'error', message: 'Too many requests. Please try again later.' },
});

const strictWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { status: 'error', message: 'Rate limit exceeded for sensitive identity operation.' },
});

app.use(globalLimiter);

// ── Body Parser ───────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// ── Phase 6 Monitoring: Deep Health Check (/health & /api/v1/health) ──
async function healthCheckHandler(_req, res) {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  try {
    const dbStart = Date.now();
    const pool = getPool();
    await pool.query('SELECT 1');
    dbLatencyMs = Date.now() - dbStart;
  } catch (dbErr) {
    dbStatus = 'down';
    console.error('[ALERT][DB_DOWN] IAM Database check failed:', dbErr.message);
  }

  let keycloakStatus = 'ok';
  let keycloakLatencyMs = 0;
  const kcCheckUrl =
    process.env.KEYCLOAK_INTERNAL_REALM_URL ||
    'http://127.0.0.1:8180/identity/realms/nexamos';

  try {
    const kcStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const kcRes = await fetch(kcCheckUrl, { signal: controller.signal });
    clearTimeout(timer);
    keycloakLatencyMs = Date.now() - kcStart;
    if (!kcRes.ok) {
      keycloakStatus = 'degraded';
    }
  } catch (kcErr) {
    keycloakStatus = 'unreachable';
  }

  const windowErrorRate =
    _metrics.windowRequests > 0
      ? Number(((_metrics.windowErrors5xx / _metrics.windowRequests) * 100).toFixed(2))
      : 0;

  const isHealthy = dbStatus === 'ok';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: 'nexamos-identity-api',
    version: '1.0.0-phase6',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    checks: {
      database: { status: dbStatus, latency_ms: dbLatencyMs },
      keycloak: { status: keycloakStatus, latency_ms: keycloakLatencyMs },
      user_cache: getUserCacheStats(),
    },
    metrics: {
      total_requests: _metrics.totalRequests,
      total_5xx_errors: _metrics.totalErrors5xx,
      total_4xx_auth_failures: _metrics.totalAuthFailures4xx,
      window_5m_requests: _metrics.windowRequests,
      window_5m_error_rate_percent: windowErrorRate,
      error_rate_alert_threshold_percent: ERROR_RATE_THRESHOLD_PERCENT,
      alert_firing: windowErrorRate > ERROR_RATE_THRESHOLD_PERCENT && _metrics.windowRequests >= 10,
    },
    response_time_ms: Date.now() - start,
  });
}

app.get('/health', healthCheckHandler);
app.get('/api/v1/health', healthCheckHandler);

// ── API v1 Routes ─────────────────────────────────────────────
app.use('/api/v1/users/provision',          strictWriteLimiter);
app.use('/api/v1/users/sessions/revoke',    strictWriteLimiter);
app.use('/api/v1/users/me/sessions/revoke', strictWriteLimiter);
app.use('/api/v1/users',         usersRouter);
app.use('/api/v1/organizations', organizationsRouter);
app.use('/api/v1/entitlements',  entitlementsRouter);
app.use('/api/v1/legacy',        strictWriteLimiter, legacyRouter);

// ── 404 Handler ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ status: 'error', message: 'Endpoint not found.' });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Identity API Error]', err.message);
  const isCorsError = String(err.message || '').startsWith('CORS blocked:');
  res.status(isCorsError ? 403 : err.status || 500).json({
    status: 'error',
    message: isCorsError
      ? err.message
      : process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[NexaMOS Identity API] Running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

module.exports = app;


