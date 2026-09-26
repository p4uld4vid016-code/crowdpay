const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getCredentialActivity } = require('../services/auditService');

/**
 * @openapi
 * /api/users/me/credentials/activity:
 *   get:
 *     tags: [Credentials]
 *     summary: Get credential activity for the current user
 *     description: >
 *       Returns an append-only activity feed for the user's API keys
 *       and webhook credentials. Raw keys, webhook secrets, ciphertext,
 *       and decrypted values are never included.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Credential activity feed }
 */
router.get('/me/credentials/activity', requireAuth, asyncHandler(async (req, res) => {
  const { limit, offset } = req.query;
  const activity = await getCredentialActivity(req.user.userId, {
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  res.json({ activity });
}));

module.exports = router;
