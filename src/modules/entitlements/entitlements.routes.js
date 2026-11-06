'use strict';

const express = require('express');
const ctrl    = require('./entitlements.controller');
const { requireOIDC, requireSuperadmin } = require('../../middleware/requireOIDC');

const router = express.Router();

// Per-org entitlements (member dapat lihat, hanya Superadmin bisa grant)
router.get('/organizations/:id/entitlements',  requireOIDC, ctrl.getOrgEntitlements);
router.post('/organizations/:id/entitlements', requireOIDC, requireSuperadmin, ctrl.grantEntitlement);
router.get('/organizations/:id/applications',  requireOIDC, ctrl.getOrgApplications);

// Update entitlement (Superadmin only)
router.patch('/:id', requireOIDC, requireSuperadmin, ctrl.updateEntitlement);

module.exports = router;

