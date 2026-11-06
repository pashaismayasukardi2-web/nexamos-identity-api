'use strict';

const express    = require('express');
const ctrl       = require('./users.controller');
const { requireOIDC, requireSuperadmin } = require('../../middleware/requireOIDC');

const router = express.Router();

// ── Current User (Mendukung baik rute /me maupun /) ───────────
router.get('/',                                        requireOIDC, ctrl.getMe);
router.get('/me',                                      requireOIDC, ctrl.getMe);
router.patch('/',                                      requireOIDC, ctrl.updateMe);
router.patch('/me',                                    requireOIDC, ctrl.updateMe);
router.get('/organizations',                           requireOIDC, ctrl.getMyOrganizations);
router.get('/me/organizations',                        requireOIDC, ctrl.getMyOrganizations);
router.get('/products',                                requireOIDC, ctrl.getMyProducts);
router.get('/me/products',                             requireOIDC, ctrl.getMyProducts);
router.get('/audit-events',                            requireOIDC, ctrl.getMyAuditEvents);
router.get('/me/audit-events',                         requireOIDC, ctrl.getMyAuditEvents);
router.post('/sessions/revoke',                        requireOIDC, ctrl.revokeMySessions);
router.post('/me/sessions/revoke',                     requireOIDC, ctrl.revokeMySessions);

// ── Provisioning (dipanggil internal setelah register Keycloak) ──
// Endpoint ini harus diproteksi — hanya boleh dipanggil dari server (service key / internal IP).
// Untuk sekarang, endpoint ini terbuka tapi akan ditambahkan API key validation di Phase 6 Hardening.
router.post('/provision',              ctrl.provisionUser);

// ── Superadmin Operations ─────────────────────────────────────
router.patch('/:userId/status',        requireOIDC, requireSuperadmin, ctrl.updateUserStatus);

module.exports = router;

