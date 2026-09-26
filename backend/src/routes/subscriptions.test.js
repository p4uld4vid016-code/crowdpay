const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const SUBSCRIPTION_ID = '33333333-3333-3333-3333-333333333333';

function buildApp(recurringStub) {
  const router = proxyquire('./subscriptions', {
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'contributor' };
        next();
      },
    },
    '../services/recurring': {
      createSubscription: async () => ({}),
      cancelSubscription: async () => ({}),
      listSubscriptionsForUser: async () => [],
      prepareSubscription: async () => ({ unsignedXdr: 'test' }),
      submitSubscription: async () => ({ subscriptionId: 'new' }),
      ...recurringStub,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

test('POST /campaigns/:id/subscriptions returns the balance schedule', async () => {
  let received = null;
  const app = buildApp({
    createSubscription: async (args) => {
      received = args;
      return {
        subscriptionId: SUBSCRIPTION_ID,
        balanceIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
        totalCommitment: 60,
        firstPaymentDate: '2026-09-17T00:00:00.000Z',
      };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`)
    .send({ amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 6 });

  assert.equal(res.status, 201);
  assert.equal(res.body.balanceIds.length, 6);
  assert.equal(received.campaignId, CAMPAIGN_ID);
  assert.equal(received.userId, 'user-1');
  assert.equal(received.totalPeriods, 6);
});

test('POST /campaigns/:id/subscriptions surfaces INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION as 400', async () => {
  const app = buildApp({
    createSubscription: async () => {
      const err = new Error('Wallet balance too low');
      err.statusCode = 400;
      err.code = 'INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION';
      throw err;
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`)
    .send({ amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 6 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION');
});

test('DELETE /campaigns/:id/subscriptions/:subscriptionId returns the cancellation summary', async () => {
  let received = null;
  const app = buildApp({
    cancelSubscription: async (args) => {
      received = args;
      return {
        cancelled: 4,
        nonCancellable: 2,
        non_cancellable_balances: [{ id: 'b1', reason: 'already_claimed' }],
        estimatedRefundDate: '2026-11-16T00:00:00.000Z',
      };
    },
  });

  const res = await request(app).delete(
    `/api/campaigns/${CAMPAIGN_ID}/subscriptions/${SUBSCRIPTION_ID}`
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.cancelled, 4);
  assert.equal(res.body.non_cancellable_balances[0].reason, 'already_claimed');
  assert.equal(received.subscriptionId, SUBSCRIPTION_ID);
});

test('DELETE /campaigns/:id/subscriptions/:subscriptionId 404s for an unknown subscription', async () => {
  const app = buildApp({
    cancelSubscription: async () => {
      const err = new Error('Subscription not found');
      err.statusCode = 404;
      throw err;
    },
  });

  const res = await request(app).delete(
    `/api/campaigns/${CAMPAIGN_ID}/subscriptions/${SUBSCRIPTION_ID}`
  );

  assert.equal(res.status, 404);
});

test('GET /subscriptions/mine lists the caller subscriptions', async () => {
  const app = buildApp({
    listSubscriptionsForUser: async (userId) => [
      { id: SUBSCRIPTION_ID, contributor: userId, campaign_title: 'Solar Grid', status: 'active' },
    ],
  });

  const res = await request(app).get('/api/subscriptions/mine');

  assert.equal(res.status, 200);
  assert.equal(res.body.subscriptions[0].contributor, 'user-1');
});

test('POST /campaigns/:id/subscriptions passes truncateToDeadline only when explicitly true (#837)', async () => {
  const received = [];
  const app = buildApp({
    createSubscription: async (args) => {
      received.push(args.truncateToDeadline);
      return { subscriptionId: SUBSCRIPTION_ID, totalPeriods: 3, requestedPeriods: 6, truncatedToDeadline: true };
    },
  });
  const body = { amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 6 };

  await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`).send(body).expect(201);
  await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`).send({ ...body, truncateToDeadline: 'yes' }).expect(201);
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`)
    .send({ ...body, truncateToDeadline: true })
    .expect(201);

  assert.deepEqual(received, [false, false, true]);
  assert.equal(res.body.truncatedToDeadline, true);
});

test('POST /campaigns/:id/subscriptions surfaces SUBSCRIPTION_EXCEEDS_DEADLINE as 400', async () => {
  const app = buildApp({
    createSubscription: async () => {
      const err = new Error('This schedule runs past the campaign deadline');
      err.statusCode = 400;
      err.code = 'SUBSCRIPTION_EXCEEDS_DEADLINE';
      throw err;
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions`)
    .send({ amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 6 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SUBSCRIPTION_EXCEEDS_DEADLINE');
});

test('POST /campaigns/:id/subscriptions/prepare returns unsigned XDR', async () => {
  const app = buildApp({
    prepareSubscription: async () => ({ unsignedXdr: 'test_unsigned' }),
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions/prepare`)
    .send({ amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 6 });

  assert.equal(res.status, 200);
  assert.equal(res.body.unsignedXdr, 'test_unsigned');
});

test('POST /api/campaigns/:id/subscriptions/submit returns subscription', async () => {
  const app = buildApp({
    submitSubscription: async () => ({ subscriptionId: 'new-sub' }),
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/subscriptions/submit`)
    .send({ unsignedXdr: 'test', signedXdr: 'signed' });

  assert.equal(res.status, 201);
});
