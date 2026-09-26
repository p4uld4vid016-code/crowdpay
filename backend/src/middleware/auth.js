const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const Sentry = require('@sentry/node');
const { authenticateCpkApiKey } = require('../services/apiKeyService');

const ACCESS_TOKEN_COOKIE_NAME = 'cp_token';
const IMPERSONATION_TOKEN_COOKIE_NAME = 'cp_impersonation_token';

function apiKeyPepper() {
  return process.env.API_KEY_PEPPER;
}

function hashApiKey(rawKey) {
  return crypto.createHmac('sha256', apiKeyPepper()).update(rawKey, 'utf8').digest('hex');
}

function getRequestPath(req) {
  return (req.originalUrl || req.url || '').split('?')[0];
}

function getTokenFromRequest(req) {
  const header = req.headers.authorization;
  return (
    req.cookies?.[IMPERSONATION_TOKEN_COOKIE_NAME] ||
    req.cookies?.[ACCESS_TOKEN_COOKIE_NAME] ||
    (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null)
  );
}

async function authenticate(req) {
  const token = getTokenFromRequest(req);
  if (!token) throw new Error('Missing token');

  if (token.startsWith('cpk_')) {
    const auth = await authenticateCpkApiKey(token);
    if (!auth) throw new Error('Invalid API key');
    req.user = {
      userId: auth.userId,
      role: auth.role,
      is_admin: auth.is_admin,
    };
    req.auth = {
      kind: 'api_key',
      apiKeyId: auth.apiKeyId,
      scopes: auth.scopes,
    };
    return;
  }

    if (token.startsWith('cp_live_')) {
     const keyHash = hashApiKey(token);
     const { rows } = await db.query(
       `SELECT id, user_id, scopes, expires_at, rotation_state FROM api_keys WHERE key_hash = $1`,
       [keyHash],
     );
     if (!rows.length) throw new Error('Invalid API key');
     const key = rows[0];
     if (key.rotation_state === 'revoked' || key.rotation_state === 'expired') {
       throw new Error('Invalid API key');
     }
     if (key.expires_at && new Date(key.expires_at) < new Date()) {
       const err = new Error('API key expired');
       err.statusCode = 401;
       err.code = 'API_KEY_EXPIRED';
       throw err;
     }
     await db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [rows[0].id]);
     const { rows: userRows } = await db.query(
       'SELECT id, role, is_admin FROM users WHERE id = $1',
       [rows[0].user_id],
     );
     const user = userRows[0] || {};
     req.user = {
       userId: rows[0].user_id,
       role: user.is_admin ? 'admin' : user.role || 'contributor',
       is_admin: user.is_admin,
     };
     req.auth = {
       kind: 'api_key',
       apiKeyId: rows[0].id,
       scopes: rows[0].scopes || [],
     };
     return;
   }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const isImpersonation = Boolean(payload.impersonated_by);

    // Validate JWT standard claims (sub, iss, aud)
    if (!payload.sub || !payload.iss || !payload.aud) {
      logger.warn('JWT missing standard claims - re-login required', {
        userId: payload.userId,
        hasSub: Boolean(payload.sub),
        hasIss: Boolean(payload.iss),
        hasAud: Boolean(payload.aud),
      });
      throw new Error('Session expired - please log in again');
    }
    if (payload.iss !== 'https://crowdpay.io') {
      logger.warn('JWT invalid issuer', { iss: payload.iss });
      throw new Error('Session expired - please log in again');
    }
    if (payload.aud !== 'crowdpay-api') {
      logger.warn('JWT invalid audience', { aud: payload.aud });
      throw new Error('Session expired - please log in again');
    }

    req.user = { ...payload };
    req.auth = { kind: 'jwt', scopes: null, impersonated: isImpersonation };
    if (isImpersonation) {
      req.impersonation = {
        adminUserId: payload.impersonated_by,
        targetUserId: payload.userId,
      };
    }

    // Load admin status from database
    if (req.user.userId) {
      const { rows } = await db.query('SELECT role, is_admin, is_banned FROM users WHERE id = $1', [
        req.user.userId,
      ]);
      if (rows.length) {
        const loadedRole = rows[0].role || req.user.role || 'contributor';
        req.user.role =
          isImpersonation && (rows[0].is_admin || loadedRole === 'admin')
            ? 'contributor'
            : loadedRole;
        req.user.is_admin = isImpersonation ? false : rows[0].is_admin;
        req.user.is_banned = rows[0].is_banned;
        if (!isImpersonation && rows[0].is_admin) {
          req.user.role = 'admin';
        }
      }
    }
  } catch (err) {
    if (err.message === 'Session expired - please log in again') {
      throw err;
    }
    throw new Error('Invalid token');
  }
}

function isImpersonatedRequest(req) {
  return Boolean(req.auth?.impersonated || req.impersonation || req.user?.impersonated_by);
}

function isImpersonationExitPath(req) {
  return req.method === 'POST' && getRequestPath(req) === '/api/admin/impersonate/exit';
}

function isImpersonatedRestrictedAction(req) {
  if (!isImpersonatedRequest(req)) return false;
  if (isImpersonationExitPath(req)) return false;

  const method = String(req.method || '').toUpperCase();
  const path = getRequestPath(req);

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return false;
  }

  if (method === 'DELETE') {
    return true;
  }

  if (path.startsWith('/api/admin')) {
    return true;
  }

  if (
    path.startsWith('/api/withdrawals') ||
    path.startsWith('/api/contributions') ||
    path.startsWith('/api/anchor') ||
    path.startsWith('/api/wallets') ||
    path.startsWith('/api/governance')
  ) {
    return true;
  }

  if (
    path.startsWith('/api/users/me') ||
    path.startsWith('/api/auth/2fa') ||
    path.startsWith('/api/auth/kyc') ||
    path.startsWith('/api/users/api-keys') ||
    path.startsWith('/api/api-keys') ||
    path.startsWith('/api/webhooks')
  ) {
    return true;
  }

  if (
    path.startsWith('/api/milestones') ||
    path.includes('/milestones/') ||
    path.includes('/trigger-refunds') ||
    path.includes('/refund')
  ) {
    return true;
  }

  return false;
}

async function logImpersonatedRequest(req) {
  if (!isImpersonatedRequest(req) || !req.impersonation?.adminUserId || !req.user?.userId) {
    return;
  }

  try {
    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        req.impersonation.adminUserId,
        'impersonated_request',
        'user',
        req.user.userId,
        JSON.stringify({
          method: req.method,
          path: getRequestPath(req),
        }),
      ],
    );
  } catch (err) {
    logger.error('Failed to log impersonated request', {
      error: err.message,
      adminUserId: req.impersonation.adminUserId,
      targetUserId: req.user.userId,
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Requires admin privileges' });
  }
  next();
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ error: 'Requires authenticated user role' });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    next();
  };
}

/**
 * API keys carry scope arrays. JWT sessions retain full access.
 * @returns {boolean} false if response was sent (403)
 */
function assertApiKeyScopes(req, res) {
  if (!req.auth || req.auth.kind !== 'api_key') return true;
  const scopes = req.auth.scopes || [];
  if (scopes.includes('full')) return true;

  const path = req.originalUrl.split('?')[0];
  const method = req.method;

  if (path.startsWith('/api/v1') || path.startsWith('/v1/')) {
    if (!scopes.includes('read')) {
      res.status(403).json({ error: 'API key requires read scope' });
      return false;
    }
    if (method !== 'GET' && method !== 'HEAD' && !scopes.includes('write')) {
      res.status(403).json({ error: 'API key requires write scope' });
      return false;
    }
    return true;
  }

  if (
    path.startsWith('/api/api-keys') ||
    path.startsWith('/api/users/api-keys') ||
    path.startsWith('/api/webhooks')
  ) {
    if (!scopes.includes('developer')) {
      res.status(403).json({ error: 'API key requires developer scope for this resource' });
      return false;
    }
    return true;
  }

  if (path.startsWith('/api/withdrawals')) {
    if (method === 'GET') {
      if (!scopes.includes('read')) {
        res.status(403).json({ error: 'API key requires read scope' });
        return false;
      }
      return true;
    }
    if (!scopes.includes('withdrawals')) {
      res.status(403).json({
        error: 'API key requires withdrawals scope for withdrawal actions',
      });
      return false;
    }
    return true;
  }

  if (method === 'GET' || method === 'HEAD') {
    if (!scopes.includes('read')) {
      res.status(403).json({ error: 'API key requires read scope' });
      return false;
    }
    return true;
  }

  if (!scopes.includes('write')) {
    res.status(403).json({ error: 'API key requires write scope' });
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  authenticate(req)
    .then(async () => {
      if (req.user?.is_banned) {
        res.status(403).json({ error: 'Account suspended' });
        return;
      }
      if (!assertApiKeyScopes(req, res)) return;
      if (req.user?.userId) Sentry.setUser({ id: req.user.userId });
      await logImpersonatedRequest(req);
      if (isImpersonatedRestrictedAction(req)) {
        res.status(403).json({ error: 'Impersonation mode cannot perform this action' });
        return;
      }
      next();
    })
    .catch((err) => {
      const msg = err.message === 'Missing token' ? err.message : 'Unauthorized';
      const errBody = { error: msg };
      if (err.code) errBody.code = err.code;
      res.status(err.statusCode || 401).json(errBody);
    });
}

/**
 * Identifies the caller if a valid token is present, but never blocks the
 * request — used by routes that want to prefer a stable per-user identity
 * for abuse protection (dedup/throttling) while still serving anonymous
 * visitors normally, e.g. the public campaign share endpoint.
 */
function optionalAuth(req, res, next) {
  authenticate(req)
    .then(() => next())
    .catch(() => next());
}

module.exports = {
  ACCESS_TOKEN_COOKIE_NAME,
  IMPERSONATION_TOKEN_COOKIE_NAME,
  requireAuth,
  authenticateToken: requireAuth,
  optionalAuth,
  authenticate,
  assertApiKeyScopes,
  isImpersonatedRestrictedAction,
  hashApiKey,
  requireAdmin,
  requireRole,
};
