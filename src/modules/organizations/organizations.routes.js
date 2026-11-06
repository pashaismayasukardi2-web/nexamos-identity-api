'use strict';

const express = require('express');
const ctrl    = require('./organizations.controller');
const entCtrl = require('../entitlements/entitlements.controller');
const { requireOIDC } = require('../../middleware/requireOIDC');

const router = express.Router();

router.post('/',                             requireOIDC, ctrl.createOrganization);
router.get('/:id',                           requireOIDC, ctrl.getOrganization);
router.patch('/:id',                         requireOIDC, ctrl.updateOrganization);
router.get('/:id/members',                   requireOIDC, ctrl.getMembers);
router.post('/:id/members',                  requireOIDC, ctrl.addMember);
router.patch('/:id/members/:userId',         requireOIDC, ctrl.updateMember);
router.delete('/:id/members/:userId',        requireOIDC, ctrl.removeMember);
router.get('/:id/entitlements',              requireOIDC, entCtrl.getOrgEntitlements);

module.exports = router;

