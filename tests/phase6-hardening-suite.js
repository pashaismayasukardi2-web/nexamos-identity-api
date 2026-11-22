'use strict';

/**
 * NexaMOS Identity & Access Platform — Phase 6 Hardening, Security Pen-Test,
 * Acceptance Tests (AT-011, AT-013, AT-014, AT-015) & Performance Load Test (< 200ms p99)
 */

require('dotenv').config();
const http   = require('http');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getPool }    = require('../src/config/database');
const { invalidateUserCache, setCustomSigningKeyResolver } = require('../src/middleware/requireOIDC');

// Generate ephemeral RSA keypair untuk menandatangani token OIDC uji coba secara lokal
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

setCustomSigningKeyResolver(header => {
  if (header && header.kid === 'phase6-test-kid') {
    return publicKey;
  }
  return null;
});

const app = require('../src/app');

function signTestToken({ sub, email, email_verified = true, roles = ['user'] }) {
  return jwt.sign(
    {
      sub,
      email,
      email_verified,
      name: 'Phase 6 Test User',
      preferred_username: 'phase6tester',
      realm_access: { roles },
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid:     'phase6-test-kid',
      issuer:    'https://nexamos.cloud/identity/realms/nexamos',
      expiresIn: '15m',
    }
  );
}

function httpRequest(port, { method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const payloadStr = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      ...headers,
      ...(payloadStr
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payloadStr),
          }
        : {}),
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders,
      },
      res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json || raw,
            durationMs,
          });
        });
      }
    );

    req.on('error', reject);
    if (payloadStr) req.write(payloadStr);
    req.end();
  });
}

async function runPhase6Suite() {
  const pool = getPool();
  const server = app.listen(0);
  const port = server.address().port;

  const testSub        = `phase6_test_sub_${Date.now()}`;
  const testEmail      = `phase6.${Date.now()}@nexamos.cloud`;
  const superadminSub  = `phase6_superadmin_${Date.now()}`;
  const superadminMail = `superadmin.p6.${Date.now()}@nexamos.cloud`;
  let testUserId       = null;
  let superadminId     = null;

  const results = [];
  const record = (id, name, passed, detail) => {
    results.push({ id, name, passed, detail });
    const icon = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${icon} | ${id.padEnd(14)} | ${name} — ${detail}`);
    if (!passed) {
      throw new Error(`Test failed: ${id} (${name}) -> ${detail}`);
    }
  };

  console.log('==============================================================================');
  console.log(' 🔒 NexaMOS IAM Phase 6 — Security, Acceptance & Performance Verification Suite');
  console.log('==============================================================================');

  try {
    // 1. Setup Test User & Superadmin
    const unverifiedToken = signTestToken({ sub: testSub, email: testEmail, email_verified: false });
    const verifiedToken   = signTestToken({ sub: testSub, email: testEmail, email_verified: true });
    const superadminToken = signTestToken({
      sub: superadminSub,
      email: superadminMail,
      email_verified: true,
      roles: ['superadmin', 'user'],
    });

    // Provision test user (unverified email initially)
    const prov1 = await httpRequest(port, {
      method: 'POST',
      path: '/api/v1/users/provision',
      headers: { Authorization: `Bearer ${unverifiedToken}` },
      body: {
        identity_subject: testSub,
        display_name: 'Phase 6 Unverified User',
        email: testEmail,
        email_verified: false,
      },
    });
    testUserId = prov1.body?.data?.id;
    record('SEC-PROVISION', 'Internal/Bearer Provisioning', prov1.status === 201 && !!testUserId, `User ID: ${testUserId}`);

    const prov2 = await httpRequest(port, {
      method: 'POST',
      path: '/api/v1/users/provision',
      headers: { Authorization: `Bearer ${superadminToken}` },
      body: {
        identity_subject: superadminSub,
        display_name: 'Phase 6 Superadmin',
        email: superadminMail,
        email_verified: true,
      },
    });
    superadminId = prov2.body?.data?.id;

    // 2. AT-013: Unverified email restricted from creating organization
    const orgUnverified = await httpRequest(port, {
      method: 'POST',
      path: '/api/v1/organizations',
      headers: { Authorization: `Bearer ${unverifiedToken}` },
      body: { name: 'Illegal Unverified Org', slug: `illegal-org-${Date.now()}` },
    });
    record(
      'AT-013',
      'Unverified Email Restricted',
      orgUnverified.status === 403 && orgUnverified.body?.code === 'EMAIL_NOT_VERIFIED',
      `HTTP ${orgUnverified.status} (${orgUnverified.body?.code})`
    );

    // 3. Verify Email endpoint & retry check
    const verifyRes = await httpRequest(port, {
      method: 'POST',
      path: '/api/v1/users/me/verify-email',
      headers: { Authorization: `Bearer ${unverifiedToken}` },
    });
    record(
      'AT-013-VERIFY',
      'Email Verification Endpoint',
      verifyRes.status === 200 && verifyRes.body?.data?.email_verified === true,
      `HTTP ${verifyRes.status} (email_verified=true)`
    );

    // 4. AT-011: Logout All Sessions (Session Revocation + Audit Event)
    const revokeRes = await httpRequest(port, {
      method: 'POST',
      path: '/api/v1/users/me/sessions/revoke',
      headers: { Authorization: `Bearer ${verifiedToken}` },
    });
    const [[auditRevoke]] = await pool.query(
      "SELECT id, event_type FROM iam_audit_events WHERE actor_id = ? AND event_type = 'USER_SESSIONS_REVOKED' LIMIT 1",
      [testUserId]
    );
    record(
      'AT-011',
      'Logout All Sessions & Audit Log',
      revokeRes.status === 200 && !!auditRevoke,
      `HTTP ${revokeRes.status}, Audit ID: ${auditRevoke?.id}`
    );

    // 5. AT-015: Suspended User Denied
    const suspendRes = await httpRequest(port, {
      method: 'PATCH',
      path: `/api/v1/users/${testUserId}/status`,
      headers: { Authorization: `Bearer ${superadminToken}` },
      body: { status: 'suspended' },
    });
    const meWhileSuspended = await httpRequest(port, {
      method: 'GET',
      path: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${verifiedToken}` },
    });
    record(
      'AT-015',
      'Suspended User Denied',
      suspendRes.status === 200 && meWhileSuspended.status === 403 && meWhileSuspended.body?.code === 'USER_SUSPENDED',
      `HTTP ${meWhileSuspended.status} (${meWhileSuspended.body?.code})`
    );

    // Re-activate user for performance load test
    await httpRequest(port, {
      method: 'PATCH',
      path: `/api/v1/users/${testUserId}/status`,
      headers: { Authorization: `Bearer ${superadminToken}` },
      body: { status: 'active' },
    });

    // 6. Penetration Test: CORS Arbitrary Origin Blocked
    const corsEvil = await httpRequest(port, {
      method: 'GET',
      path: '/health',
      headers: { Origin: 'https://evil-phishing.com' },
    });
    record(
      'PEN-CORS',
      'Reject Unauthorized CORS Origin',
      corsEvil.status === 403 && String(corsEvil.body?.message || '').includes('CORS blocked'),
      `HTTP ${corsEvil.status} (${corsEvil.body?.message})`
    );

    // 7. Penetration Test: Forged/Tampered JWT Token Blocked
    const forgedToken = jwt.sign({ sub: testSub }, 'wrong-secret', { algorithm: 'HS256' });
    const forgedRes = await httpRequest(port, {
      method: 'GET',
      path: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${forgedToken}` },
    });
    record(
      'PEN-JWT',
      'Reject Forged/HS256 Downgrade JWT',
      forgedRes.status === 401,
      `HTTP ${forgedRes.status} (${forgedRes.body?.message})`
    );

    // 8. Monitoring: Deep Health Check Endpoint (/health)
    const healthRes = await httpRequest(port, { method: 'GET', path: '/health' });
    record(
      'MON-HEALTH',
      'Deep Health Check & Metrics',
      healthRes.status === 200 && healthRes.body?.checks?.database?.status === 'ok',
      `DB Latency: ${healthRes.body?.checks?.database?.latency_ms}ms, Cache Entries: ${healthRes.body?.checks?.user_cache?.entries}`
    );

    // 9. Performance Load Test: 50 requests to GET /api/v1/users/me (Target: p99 < 200ms)
    // Warm-up request (populates TTL cache)
    await httpRequest(port, {
      method: 'GET',
      path: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${verifiedToken}` },
    });

    const latencies = [];
    for (let i = 0; i < 50; i++) {
      const r = await httpRequest(port, {
        method: 'GET',
        path: '/api/v1/users/me',
        headers: { Authorization: `Bearer ${verifiedToken}` },
      });
      if (r.status !== 200) throw new Error(`Load test request #${i} failed with status ${r.status}`);
      latencies.push(r.durationMs);
    }

    latencies.sort((a, b) => a - b);
    const avgMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95Ms = latencies[Math.floor(latencies.length * 0.95)];
    const p99Ms = latencies[Math.floor(latencies.length * 0.99)];

    record(
      'PERF-LOAD',
      'Load Test /users/me (50 reqs, target p99 < 200ms)',
      p99Ms < 200,
      `avg=${avgMs.toFixed(2)}ms | p95=${p95Ms.toFixed(2)}ms | p99=${p99Ms.toFixed(2)}ms`
    );

    console.log('==============================================================================');
    console.log(` 🎉 ALL ${results.length}/${results.length} PHASE 6 HARDENING CHECKS PASSED!`);
    console.log('==============================================================================');
  } finally {
    // Cleanup ephemeral test records from DB
    if (testUserId || superadminId) {
      const ids = [testUserId, superadminId].filter(Boolean);
      const placeholders = ids.map(() => '?').join(',');
      await pool.query(`DELETE FROM iam_audit_events WHERE actor_id IN (${placeholders}) OR target_id IN (${placeholders})`, [...ids, ...ids]).catch(() => {});
      await pool.query(`DELETE FROM iam_user_emails WHERE user_id IN (${placeholders})`, ids).catch(() => {});
      await pool.query(`DELETE FROM iam_users WHERE id IN (${placeholders})`, ids).catch(() => {});
      invalidateUserCache({ userId: testUserId, sub: testSub });
      invalidateUserCache({ userId: superadminId, sub: superadminSub });
    }
    server.close();
    await pool.end();
  }
}

runPhase6Suite().catch(err => {
  console.error('\n❌ [Phase 6 Verification Failed]:', err.message);
  process.exit(1);
});
