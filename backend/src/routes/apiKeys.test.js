const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'user-1';

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({ apiKeyService = {}, authed = true } = {}) {
  const calls = {};

  const router = proxyquire('./apiKeys', {
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID };
            next();
          }
        : denyAuth(),
    },
    '../services/apiKeyService': {
      listApiKeysForUser: async (userId) => {
        calls.listUserId = userId;
        return [{ id: 'k1', name: 'Default' }];
      },
      createApiKeyForUser: async (userId, body) => {
        calls.createArgs = [userId, body];
        return { id: 'k2', api_key: 'live_sk_123' };
      },
      revokeApiKeyForUser: async (userId, id) => {
        calls.revokeArgs = [userId, id];
        return { id: 'k2' };
      },
      rotateApiKey: async (userId, keyId, body) => {
        calls.rotateArgs = [userId, keyId, body];
        return { id: 'k3', api_key: 'live_sk_new', predecessor_id: keyId };
      },
      ...apiKeyService,
    },
    '../services/auditService': {
      logCredentialEvent: async () => {},
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users/api-keys', router);

  return { app, calls };
}

test('GET /api/users/api-keys lists keys for the user', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/users/api-keys');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 'k1', name: 'Default' }]);
  assert.equal(calls.listUserId, USER_ID);
});

test('POST /api/users/api-keys creates a key with request body', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/users/api-keys').send({ name: 'CI' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'k2', api_key: 'live_sk_123' });
  assert.deepEqual(calls.createArgs, [USER_ID, { name: 'CI' }]);
});

test('POST /api/users/api-keys tolerates an empty body', async () => {
  const { app, calls } = buildApp();

  await request(app).post('/api/users/api-keys');

  assert.deepEqual(calls.createArgs, [USER_ID, {}]);
});

test('DELETE /api/users/api-keys/:id revokes the key', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).delete('/api/users/api-keys/k2');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { revoked: true, id: 'k2' });
  assert.deepEqual(calls.revokeArgs, [USER_ID, 'k2']);
});

test('DELETE /api/users/api-keys/:id returns 404 for unknown key', async () => {
  const { app } = buildApp({ apiKeyService: { revokeApiKeyForUser: async () => null } });

  const res = await request(app).delete('/api/users/api-keys/missing');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'API key not found' });
});

test('endpoints return 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const list = await request(app).get('/api/users/api-keys');
  assert.equal(list.status, 401);

  const create = await request(app).post('/api/users/api-keys').send({ name: 'CI' });
  assert.equal(create.status, 401);

  const revoke = await request(app).delete('/api/users/api-keys/k2');
  assert.equal(revoke.status, 401);
});