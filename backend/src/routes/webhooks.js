const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const {
  ALL_WEBHOOK_EVENTS,
  processDelivery,
  isValidBackoffStrategy,
} = require('../services/webhookDispatcher');
const {
  processIncomingWebhook,
  verifyWebhookSignature,
  WebhookError,
} = require('../services/webhookService');
const asyncHandler = require('../utils/asyncHandler');
const { isSafeUrl } = require('../utils/ssrfGuard');
const { logCredentialEvent } = require('../services/auditService');

const isTest = process.env.NODE_ENV === 'test';

// Per-IP: 30 req/min on the public webhook ingress endpoint. This route has
// no auth (any caller with a valid webhook id + signature can post to it),
// so it's a DoS vector without its own limiter — the global 100 req/15min
// limit is far too permissive for a single public endpoint.
const incomingWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 30,
  message: { error: 'Too many webhook deliveries from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

async function isValidWebhookUrl(urlString) {
  const result = await isSafeUrl(urlString);
  return result.safe;
}

function normalizeEvents(events) {
  if (!events || !Array.isArray(events)) return [];
  const allowed = new Set(ALL_WEBHOOK_EVENTS);
  return [...new Set(events.filter((e) => typeof e === 'string' && allowed.has(e)))];
}

// KYC webhooks are handled at POST /api/webhooks/kyc (raw body + Persona signature verification).

router.post('/incoming/:id', incomingWebhookLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, secret FROM webhooks WHERE id = $1 AND revoked_at IS NULL`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const webhook = rows[0];
    const rawBody = req.body;

    // Some services might use variations like X-Signature-256 or x-signature
    const headerSig = req.headers['x-signature-256'] || req.headers['x-signature'];

    if (!headerSig) {
      return res.status(401).json({ error: 'Missing signature header' });
    }

    // Constant-time HMAC-SHA256 comparison (tolerates a `sha256=` prefix).
    if (!verifyWebhookSignature(webhook.secret, rawBody, headerSig)) {
      logger.warn('Failed webhook signature verification', { webhookId: req.params.id });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const result = await processIncomingWebhook(webhook.id, payload, {
      ownerUserId: webhook.user_id,
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    if (err instanceof WebhookError) {
      logger.warn('Rejected incoming webhook', {
        webhookId: req.params.id,
        status: err.status,
        error: err.message,
      });
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('Error processing incoming webhook', { error: err.message, webhookId: req.params.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public webhook ingress is POST-only. Reject every other method (GET/HEAD/
// DELETE/...) with an explicit 405 instead of letting it fall through to the
// 404 handler — senders and scanners probing during setup get a clearer answer (#799).
// Registered after the POST handler above so valid POSTs are never affected.
router.all('/incoming/:id', (req, res) => {
  res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
});

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, url, events,
            CONCAT(LEFT(secret, 10), '…', RIGHT(secret, 4)) AS secret_hint,
            created_at, revoked_at
     FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { url, events, backoff_strategy } = req.body || {};
  if (!url || !events) {
    return res.status(400).json({ error: 'url and events array are required' });
  }
  if (!(await isValidWebhookUrl(url))) {
    return res.status(400).json({ error: 'url must be https, or http://localhost for development' });
  }
  const ev = normalizeEvents(events);
  if (!ev.length) {
    return res.status(400).json({ error: `events must include at least one of: ${ALL_WEBHOOK_EVENTS.join(', ')}` });
  }
  if (backoff_strategy !== undefined && backoff_strategy !== null && !isValidBackoffStrategy(backoff_strategy)) {
    return res.status(400).json({
      error: 'backoff_strategy must be { base_ms, max_ms, multiplier } with positive numbers',
    });
  }

  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
  const { rows } = await db.query(
    `INSERT INTO webhooks (user_id, url, events, secret, backoff_strategy)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, url, events, backoff_strategy, created_at`,
    [req.user.userId, url, ev, secret, backoff_strategy ? JSON.stringify(backoff_strategy) : null]
  );

  await logCredentialEvent({
    actorId: req.user.userId,
    action: 'webhook_create',
    resourceType: 'webhook',
    resourceId: rows[0].id,
    req,
    metadata: { url, events: ev },
  });

  res.status(201).json({
    ...rows[0],
    secret,
    message: 'Store the signing secret; it is only shown once.',
  });
}));

router.patch('/:id/backoff-strategy', requireAuth, asyncHandler(async (req, res) => {
  const { backoff_strategy } = req.body || {};
  if (backoff_strategy !== null && !isValidBackoffStrategy(backoff_strategy)) {
    return res.status(400).json({
      error: 'backoff_strategy must be { base_ms, max_ms, multiplier } with positive numbers, or null to reset to defaults',
    });
  }

  const { rows } = await db.query(
    `UPDATE webhooks SET backoff_strategy = $1::jsonb
     WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
     RETURNING id, url, events, backoff_strategy`,
    [backoff_strategy ? JSON.stringify(backoff_strategy) : null, req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Webhook not found' });
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, url FROM webhooks WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Webhook not found' });
  await db.query(
    `UPDATE webhooks SET revoked_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  await logCredentialEvent({
    actorId: req.user.userId,
    action: 'webhook_revoke',
    resourceType: 'webhook',
    resourceId: rows[0].id,
    req,
    metadata: { url: rows[0].url },
  });
  res.json({ revoked: true, id: rows[0].id });
}));

router.get('/deliveries', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const webhookId = req.query.webhook_id || null;

  const params = [req.user.userId];
  let whClause = '';
  if (webhookId) {
    params.push(webhookId);
    whClause = ` AND w.id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
            d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
            d.delivered_at, d.created_at, d.updated_at, w.url AS webhook_url
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE w.user_id = $1 ${whClause}
     ORDER BY d.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

// Replay is a conditional state transition, so it serializes with the
// dispatcher's atomic claim (#838): a delivery can only be reset while it is
// terminal-failed or waiting for a retry, never while a worker holds it. The
// actual send still goes through the claim, so a replay racing the poller (or
// a double-clicked replay) results in exactly one attempt.
router.post('/deliveries/:id/replay', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE webhook_deliveries d
     SET status = 'pending', attempt_count = 0, last_error = NULL,
         response_status = NULL, response_body_snippet = NULL,
         next_retry_at = NULL, delivered_at = NULL,
         lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
     FROM webhooks w
     WHERE d.id = $1 AND d.webhook_id = w.id AND w.user_id = $2
       AND w.revoked_at IS NULL
       AND d.status IN ('failed', 'retrying')
     RETURNING d.id`,
    [req.params.id, req.user.userId]
  );

  if (!rows.length) {
    const { rows: current } = await db.query(
      `SELECT d.id AS delivery_id, d.status
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1 AND w.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    const existing = current[0];
    // Already queued or in flight (e.g. a repeated replay request): no-op.
    if (existing && (existing.status === 'pending' || existing.status === 'delivering')) {
      return res.json({ message: 'Replay already in progress', id: existing.delivery_id });
    }
    if (existing && existing.status === 'delivered') {
      return res.status(409).json({ error: 'Delivery already succeeded', id: existing.delivery_id });
    }
    return res.status(404).json({ error: 'Failed delivery not found or not replayable' });
  }

  setImmediate(() => {
    processDelivery(rows[0].id).catch((err) => {
      logger.error('Failed to replay webhook delivery', { err });
    });
  });

  res.json({ message: 'Replay queued', id: rows[0].id });
}));

module.exports = router;
