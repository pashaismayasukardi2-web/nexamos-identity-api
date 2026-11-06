'use strict';

const express = require('express');
const ctrl    = require('./legacy.controller');

const router = express.Router();

// Endpoint ini dipanggil server-to-server dari nexa-os
// Di Phase 6 Hardening akan ditambahkan validasi Internal API Key
router.post('/link',    ctrl.linkLegacyAccount);
router.get('/resolve',  ctrl.resolveBySubject);

module.exports = router;

