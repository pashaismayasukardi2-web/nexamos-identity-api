'use strict';

const express = require('express');
const ctrl    = require('./legacy.controller');
const { requireInternalOrOIDC } = require('../../middleware/requireOIDC');

const router = express.Router();

// Endpoint ini dipanggil server-to-server dari nexa-os
// Phase 6 Hardening: Diproteksi dengan requireInternalOrOIDC (X-Internal-Api-Key / Loopback / OIDC Bearer)
router.post('/link',    requireInternalOrOIDC, ctrl.linkLegacyAccount);
router.get('/resolve',  requireInternalOrOIDC, ctrl.resolveBySubject);

module.exports = router;


