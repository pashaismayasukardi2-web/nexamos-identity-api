'use strict';

const express    = require('express');
const ctrl       = require('./users.controller');
const { requireOIDC, requireSuperadmin } = require('../../middleware/requireOIDC');

const router = express.Router();

// ── Current User (Mendukung baik rute /me maupun /) ───────────
router.get(['/', '/me'],                               requireOIDC, ctrl.getMe);
router.patch(['/', '/me'],                             requireOIDC, ctrl.updateMe);
router.get(['/organizations', '/me/organizations'],   requireOIDC, ctrl.getMyOrganizations);
router.get(['/products', '/me/products'],             requireOIDC, ctrl.getMyProducts);
router.get(['/audit-events', '/me/audit-events'],     requireOIDC, ctrl.getMyAuditEvents);
router.post(['/sessions/revoke', '/me/sessions/revoke'], requireOIDC, ctrl.revokeMySessions);

// ── Provisioning (dipanggil internal setelah register Keycloak) ──
// Endpoint ini harus diproteksi — hanya boleh dipanggil dari server (service key / internal IP).
// Untuk sekarang, endpoint ini terbuka tapi akan ditambahkan API key validation di Phase 6 Hardening.
router.post('/provision',              ctrl.provisionUser);

// ── Superadmin Operations ─────────────────────────────────────
router.patch('/:userId/status',        requireOIDC, requireSuperadmin, ctrl.updateUserStatus);

module.exports = router;

