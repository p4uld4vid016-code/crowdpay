const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  listApiKeysForUser,
  createApiKeyForUser,
  revokeApiKeyForUser,
  rotateApiKey,
} = require('../services/apiKeyService');
const { logCredentialEvent } = require('../services/auditService');

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const keys = await listApiKeysForUser(req.user.userId);
  res.json(keys);
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const created = await createApiKeyForUser(req.user.userId, req.body || {});
  await logCredentialEvent({
    actorId: req.user.userId,
    action: 'api_key_create',
    resourceType: 'api_key',
    resourceId: created.id,
    req,
    metadata: { scopes: created.scopes, label: created.label },
  });
  res.status(201).json(created);
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const revoked = await revokeApiKeyForUser(req.user.userId, req.params.id);
  if (!revoked) return res.status(404).json({ error: 'API key not found' });
  await logCredentialEvent({
    actorId: req.user.userId,
    action: 'api_key_revoke',
    resourceType: 'api_key',
    resourceId: revoked.id,
    req,
    metadata: { label: revoked.label },
  });
  res.json({ revoked: true, id: revoked.id });
}));

/**
 * @openapi
 * /api/users/api-keys/:id/rotate:
 *   post:
 *     tags: [API Keys]
 *     summary: Rotate an API key with a bounded grace period
 *     description: >
 *       Issues a one-time replacement key with inherited or explicitly chosen
 *       label and scopes. The predecessor remains valid for the grace period.
 *       Returns the replacement key exactly once and records predecessor/successor IDs.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string }
 *               scopes: { type: array, items: { type: string } }
 *               expires_at: { type: string, format: date-time }
 *     responses:
 *       201: { description: Replacement key issued }
 *       404: { description: Key not found or cannot be rotated }
 */
router.post('/:id/rotate', requireAuth, asyncHandler(async (req, res) => {
  const rotated = await rotateApiKey(req.user.userId, req.params.id, req.body || {});
  if (!rotated) return res.status(404).json({ error: 'Key not found or cannot be rotated' });
  res.status(201).json(rotated);
}));

module.exports = router;
