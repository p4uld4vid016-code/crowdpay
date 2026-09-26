const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const requestContext = require('./config/requestContext');
const { requestLogger } = require('./middleware/requestLogger');
const logger = require('./config/logger');
const { normalizeErrorResponse, errorHandler } = require('./middleware/errorHandler');
const compression = require('./middleware/compression');
const Sentry = require('@sentry/node');
const db = require('./config/database');

const { validateEnv } = require('./config/env');

const app = express();

if (process.env.NODE_ENV !== 'test') {
  validateEnv();
}

function buildCorsOrigin() {
  const raw = [process.env.FRONTEND_URL, process.env.CORS_ALLOWED_ORIGINS]
    .filter(Boolean)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    return process.env.NODE_ENV === 'production' ? [] : true;
  }
  return raw;
}

app.use(requestContext);
app.use(requestLogger);
app.use(helmet());
app.use(cors({ origin: buildCorsOrigin(), credentials: true }));
app.use(compression);

// Preserve the exact raw request bytes for signature-verified webhook callbacks
// (Persona KYC + user webhooks). The global JSON parser below would otherwise
// consume the request stream and destroy the ability to recompute the HMAC the
// sender signed, so raw parsers MUST run first (#799). Each handler verifies
// the signature before parsing the JSON body itself.
app.use('/api/webhooks/kyc', express.raw({ type: () => true, limit: '1mb' }));
app.use('/api/webhooks/incoming', express.raw({ type: () => true, limit: '1mb' }));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(require('./middleware/csrf').csrfProtection);

app.use('/api/v1', require('./routes/v1'));
// NOTE: adminAuditLogs.js is deprecated — audit logs are served via admin.js -> auditLogs.js.
// Do not mount it here; it would shadow GET /api/admin/audit-logs.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/anchor', require('./routes/anchor'));
app.use('/api/announcements', require('./routes/announcement'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/featureFlags'));
app.use('/api/campaigns', require('./routes/campaignComments'));
app.use('/api/campaigns', require('./routes/campaignFollowers'));
app.use('/api/campaigns/:campaignId/contribution/preview', require('./routes/pathPaymentPreview'));
app.use('/api/campaigns', require('./routes/campaignUpdates'));
app.use('/api/campaigns', require('./routes/translations'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns', require('./routes/campaignRequirements'));
app.use('/api/campaign-pools', require('./routes/contributionPools'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/contributor-identity', require('./routes/contributorIdentity'));
app.use('/api/creator', require('./routes/creatorAnalytics'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/emails', require('./routes/emails'));
app.use('/api/embed', require('./routes/embed'));
app.use('/api/governance', require('./routes/governance'));
app.use('/api/impact-reports', require('./routes/impactReports'));
app.use('/api/invites', require('./routes/invites'));
app.use('/api/webhooks/kyc', require('./routes/kycWebhook'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/nft-rewards', require('./routes/nftRewards'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ops', require('./routes/ops'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/refunds', require('./routes/creatorRefunds'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/sponsor-matching', require('./routes/sponsorMatching'));
app.use('/api/stellar-transactions', require('./routes/stellarTransactions'));
app.use('/api', require('./routes/subscriptions'));
app.use('/api/thank-you', require('./routes/thankYou'));
app.use('/api/translations', require('./routes/translations'));
app.use('/api/treasury', require('./routes/treasury'));
app.use('/api/users', require('./routes/users'));
app.use('/api/credentials', require('./routes/credentialActivity'));
app.use('/api/wallets', require('./routes/wallets'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/withdrawals', require('./routes/withdrawals'));

function getPoolMetrics() {
  if (typeof db.getPoolMetrics === 'function') return db.getPoolMetrics();
  return {
    total: db.totalCount || 0,
    idle: db.idleCount || 0,
    waiting: db.waitingCount || 0,
    max: db.poolMax || 0,
    utilisation: 0,
  };
}

app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    const metrics = getPoolMetrics();
    const { utilisation, ...pool } = metrics;
    res.json({
      status: 'ok',
      db: { pool, utilisation },
    });
    if (utilisation > 90) {
      Sentry.captureMessage(
        `Database pool utilisation exceeds 90% (current: ${utilisation}%)`,
        'warning'
      );
    }
  } catch (err) {
    logger.error('Health check database query failed', { error: err.message });
    res.status(503).json({
      error: {
        code: 'ERROR',
        message: err.message,
      },
    });
  }
});

app.use(normalizeErrorResponse);
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

module.exports = app;
