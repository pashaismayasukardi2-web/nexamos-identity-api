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

// Custom signing key resolver hook (used for offline unit/pen-test verification)
let _customSigningKeyResolver = null;
function setCustomSigningKeyResolver(fn) {
  _customSigningKeyResolver = fn;
}

function getSigningKey(header) {
  if (_customSigningKeyResolver) {
    const customKey = _customSigningKeyResolver(header);
    if (customKey) return Promise.resolve(customKey);
  }
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

// ── Phase 6 Performance: In-Memory TTL Cache untuk User Profile Resolution (< 200ms p99) ──
const USER_CACHE_TTL_MS = Number(process.env.USER_CACHE_TTL_MS) || 30 * 1000; // 30 detik
const _userCacheBySub = new Map();
const _subByUserId = new Map();

function getCachedUserBySub(sub) {
  const entry = _userCacheBySub.get(sub);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _userCacheBySub.delete(sub);
    return null;
  }
  return entry.user;
}

function setCachedUserBySub(sub, user) {
  if (!sub || !user) return;
  _userCacheBySub.set(sub, {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
  if (user.id) {
    _subByUserId.set(user.id, sub);
  }
}

function invalidateUserCache({ sub = null, userId = null } = {}) {
  if (sub) {
    _userCacheBySub.delete(sub);
  }
  if (userId) {
    const mappedSub = _subByUserId.get(userId);
    if (mappedSub) {
      _userCacheBySub.delete(mappedSub);
      _subByUserId.delete(userId);
    }
    for (const [k, v] of _userCacheBySub.entries()) {
      if (v.user && v.user.id === userId) {
        _userCacheBySub.delete(k);
      }
    }
  }
}

function getUserCacheStats() {
  return {
    entries: _userCacheBySub.size,
    ttl_ms: USER_CACHE_TTL_MS,
  };
}

/**
 * Middleware: requireOIDC
 *
 * 1. Ambil Bearer token dari header Authorization.
 * 2. Verifikasi signature + expiry + issuer menggunakan JWKS Keycloak.
 * 3. Resolve Global User dari cache TTL / tabel iam_users (by identity_subject / 'sub').
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
      'https://identity.nexamos.cloud/realms/nexamos',
      'http://localhost:8180/realms/nexamos',
      'http://127.0.0.1:8180/realms/nexamos',
      'http://127.0.0.1:8180/identity/realms/nexamos',
    ].filter(Boolean);

    const payload = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      issuer:     validIssuers,
    });

    const sub = payload.sub;
    if (!sub) {
      return res.status(401).json({ status: 'error', message: 'Token missing subject (sub).' });
    }

    // Resolve Global User dari In-Memory TTL Cache atau DB
    let user = getCachedUserBySub(sub);
    if (!user) {
      const pool = getPool();
      const [[dbUser]] = await pool.query(
        `SELECT u.id, u.display_name, u.status, u.created_at,
                e.id AS email_id, e.email, e.is_verified AS email_verified
         FROM iam_users u
         LEFT JOIN iam_user_emails e ON e.user_id = u.id AND e.is_primary = 1
         WHERE u.identity_subject = ?
         LIMIT 1`,
        [sub]
      );

      if (dbUser) {
        // Sinkronisasi klaim email_verified dari token Keycloak jika di Keycloak sudah verified
        if (payload.email_verified === true && !dbUser.email_verified && dbUser.email_id) {
          await pool.query('UPDATE iam_user_emails SET is_verified = 1 WHERE id = ?', [dbUser.email_id]).catch(() => {});
          dbUser.email_verified = 1;
        }
        user = dbUser;
        setCachedUserBySub(sub, user);
      }
    }

    if (!user) {
      // User belum pernah login via Identity API — perlu provisioning
      return res.status(403).json({
        status: 'error',
        code:   'USER_NOT_PROVISIONED',
        message: 'User identity not found. Please complete registration.',
      });
    }

    // AT-015 Compliance: Suspended user denied + audit log
    if (user.status === 'suspended') {
      await auditLog({
        eventType:  'SUSPENDED_USER_ACCESS_DENIED',
        actorId:    user.id,
        targetType: 'user',
        targetId:   user.id,
        payload:    { path: req.originalUrl, method: req.method, sub },
        req,
      });
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

    const isEmailVerified = Boolean(user.email_verified || payload.email_verified === true);

    // Inject ke request
    req.iamUser = {
      id:             user.id,
      display_name:   user.display_name,
      email:          user.email  || payload.email || null,
      email_verified: isEmailVerified,
      status:         user.status,
      created_at:     user.created_at,
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
 * requireVerifiedEmail — middleware tambahan setelah requireOIDC (AT-013 Compliance).
 * Mencegah user dengan email yang belum diverifikasi melakukan operasi sensitif
 * (seperti membuat organisasi B2B baru atau mengundang anggota eksternal).
 */
async function requireVerifiedEmail(req, res, next) {
  if (!req.iamUser?.email_verified) {
    await auditLog({
      eventType:  'UNVERIFIED_EMAIL_RESTRICTED',
      actorId:    req.iamUser?.id || null,
      targetType: 'user',
      targetId:   req.iamUser?.id || null,
      payload:    { path: req.originalUrl, method: req.method, email: req.iamUser?.email },
      req,
    });
    return res.status(403).json({
      status:  'error',
      code:    'EMAIL_NOT_VERIFIED',
      message: 'Alamat email Anda belum diverifikasi. Silakan verifikasi email terlebih dahulu untuk mengakses fitur ini.',
    });
  }
  next();
}

/**
 * requireInternalOrOIDC — proteksi endpoint internal (/users/provision, /legacy/link)
 * Menerima header X-Internal-Api-Key, request dari loopback (127.0.0.1 / ::1), atau Bearer token OIDC yang valid.
 */
async function requireInternalOrOIDC(req, res, next) {
  const internalKey = process.env.INTERNAL_API_KEY;
  const providedKey = req.headers['x-internal-api-key'];
  if (internalKey && providedKey && providedKey === internalKey) {
    return next();
  }

  const remoteIp = req.ip || req.socket?.remoteAddress || '';
  const isLoopback =
    remoteIp === '127.0.0.1' ||
    remoteIp === '::1' ||
    remoteIp === '::ffff:127.0.0.1';

  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.decode(token, { complete: true });
      if (decoded && decoded.header?.kid) {
        const signingKey = await getSigningKey(decoded.header);
        const validIssuers = [
          process.env.KEYCLOAK_ISSUER,
          'https://nexamos.cloud/identity/realms/nexamos',
          'https://identity.nexamos.cloud/realms/nexamos',
          'http://localhost:8180/realms/nexamos',
          'http://127.0.0.1:8180/realms/nexamos',
          'http://127.0.0.1:8180/identity/realms/nexamos',
        ].filter(Boolean);
        req.oidcPayload = jwt.verify(token, signingKey, {
          algorithms: ['RS256'],
          issuer: validIssuers,
        });
        return next();
      }
    } catch (_) {}
  }

  if (isLoopback) {
    return next();
  }

  await auditLog({
    eventType:  'UNAUTHORIZED_INTERNAL_ENDPOINT_ACCESS',
    targetType: 'endpoint',
    targetId:   req.originalUrl,
    payload:    { ip: remoteIp, method: req.method },
    req,
  });

  return res.status(401).json({
    status:  'error',
    code:    'INTERNAL_AUTH_REQUIRED',
    message: 'Internal service authentication required.',
  });
}

/**
 * requireSuperadmin — middleware tambahan setelah requireOIDC.
 * Hanya lolos jika user memiliki role SUPERADMIN di Keycloak realm.
 */
function requireSuperadmin(req, res, next) {
  const roles = (req.iamUser?.kcRoles || []).map(r => String(r).toLowerCase());
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

module.exports = {
  requireOIDC,
  requireVerifiedEmail,
  requireInternalOrOIDC,
  requireSuperadmin,
  auditLog,
  invalidateUserCache,
  getUserCacheStats,
  setCustomSigningKeyResolver,
};


