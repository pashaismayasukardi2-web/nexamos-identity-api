'use strict';

const jwksClient = require('jwks-rsa');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../config/database');

/**
 * JWKS client — mengambil public key dari Keycloak untuk verifikasi token.
 * Cache key selama 10 menit agar tidak spam endpoint Keycloak.
 */
const jwks = jwksClient({
  jwksUri: process.env.KEYCLOAK_JWKS_URI || 'https://nexamos.cloud/identity/realms/nexamos/protocol/openid-connect/certs',
  cache:         true,
  cacheMaxAge:   10 * 60 * 1000,
  rateLimit:     true,
  jwksRequestsPerMinute: 10,
});

function getSigningKey(header) {
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

/**
 * Middleware: requireOIDC
 *
 * 1. Ambil Bearer token dari header Authorization.
 * 2. Verifikasi signature + expiry + issuer menggunakan JWKS Keycloak.
 * 3. Resolve Global User dari tabel iam_users (by identity_subject / 'sub').
 * 4. Inject req.iamUser ke request.
 *
 * Usage:
 *   router.get('/me', requireOIDC, controller.getMe);
 */
async function requireOIDC(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Authorization token required.' });
    }

    // Decode header dulu untuk ambil kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header?.kid) {
      return res.status(401).json({ status: 'error', message: 'Invalid token format.' });
    }

    const signingKey = await getSigningKey(decoded.header);

    // Verifikasi signature, expiry, issuer, audience
    const validIssuers = [
      process.env.KEYCLOAK_ISSUER,
      'https://nexamos.cloud/identity/realms/nexamos',
      'http://localhost:8180/realms/nexamos',
      'http://127.0.0.1:8180/realms/nexamos',
    ].filter(Boolean);

    const payload = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      issuer:     validIssuers,
    });

    const sub = payload.sub;
    if (!sub) {
      return res.status(401).json({ status: 'error', message: 'Token missing subject (sub).' });
    }

    // Resolve Global User dari DB
    const pool = getPool();
    const [[user]] = await pool.query(
      `SELECT u.id, u.display_name, u.status,
              e.email, e.is_verified AS email_verified
       FROM iam_users u
       LEFT JOIN iam_user_emails e ON e.user_id = u.id AND e.is_primary = 1
       WHERE u.identity_subject = ?
       LIMIT 1`,
      [sub]
    );

    if (!user) {
      // User belum pernah login via Identity API — perlu provisioning
      // Ini terjadi pada user baru yang baru saja register di Keycloak
      return res.status(403).json({
        status: 'error',
        code:   'USER_NOT_PROVISIONED',
        message: 'User identity not found. Please complete registration.',
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({
        status: 'error',
        code:   'USER_SUSPENDED',
        message: 'Your account has been suspended.',
      });
    }

    if (user.status === 'deleted') {
      return res.status(403).json({
        status: 'error',
        code:   'USER_DELETED',
        message: 'Account not found.',
      });
    }

    // Inject ke request
    req.iamUser = {
      id:             user.id,
      display_name:   user.display_name,
      email:          user.email  || null,
      email_verified: !!user.email_verified,
      status:         user.status,
      sub,
      // Forward claim Keycloak yang berguna
      kcRoles:        payload.realm_access?.roles || [],
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'error', message: 'Token expired.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ status: 'error', message: 'Invalid token: ' + err.message });
    }
    console.error('[requireOIDC]', err);
    res.status(500).json({ status: 'error', message: 'Authentication error: ' + err.message });
  }
}

/**
 * requireSuperadmin — middleware tambahan setelah requireOIDC.
 * Hanya lolos jika user memiliki role SUPERADMIN di Keycloak realm.
 */
function requireSuperadmin(req, res, next) {
  const roles = req.iamUser?.kcRoles || [];
  if (!roles.includes('superadmin')) {
    return res.status(403).json({
      status: 'error',
      message: 'Superadmin access required.',
    });
  }
  next();
}

/**
 * auditLog — helper untuk mencatat ke iam_audit_events
 */
async function auditLog({ eventType, actorId = null, targetType = null, targetId = null, payload = null, req = null }) {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO iam_audit_events
         (id, event_type, actor_id, target_type, target_id, payload, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        uuidv4(),
        eventType,
        actorId,
        targetType,
        targetId,
        payload ? JSON.stringify(payload) : null,
        req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null,
        req ? (req.headers['user-agent'] || null) : null,
      ]
    );
  } catch (err) {
    console.warn('[auditLog] Failed to write audit event:', err.message);
  }
}

module.exports = { requireOIDC, requireSuperadmin, auditLog };

