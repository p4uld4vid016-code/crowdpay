const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const SUBSCRIPTION_ID = '33333333-3333-3333-3333-333333333333';
const CAMPAIGN_WALLET = 'GCAMPAIGNWALLETPUBLICKEY';
const CONTRIBUTOR_WALLET = 'GCONTRIBUTORWALLETPUBLICKEY';

const DAY_MS = 24 * 60 * 60 * 1000;

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function buildService({ queryImpl, stellar = {}, clientQueryImpl, closeImpl }) {
  const calls = [];
  const notifications = [];
  const record = (text, params) => calls.push({ text, params });

  const client = {
    query: async (text, params) => {
      record(text, params);
      return clientQueryImpl ? clientQueryImpl(text, params) : { rows: [] };
    },
    release: () => {},
  };

  const service = proxyquire('./recurring', {
    '../config/database': {
      query: async (text, params) => {
        record(text, params);
        // Closure of ineligible installments (#837) is answered separately so
        // tests about claiming are not affected by it.
        if (text.includes("SET status = 'closed'")) {
          return closeImpl ? closeImpl(text, params) : { rows: [] };
        }
        return queryImpl ? queryImpl(text, params) : { rows: [] };
      },
      connect: async () => client,
    },
    '../config/logger': silentLogger,
'./stellarService': {
       getSupportedAssetCodes: () => ['XLM', 'USDC'],
       getCampaignBalance: async () => ({ XLM: '1000' }),
       ensureCustodialAccountFundedAndTrusted: async () => null,
       createSubscriptionClaimableBalances: async () => ({ txHash: 'tx', balanceIds: [] }),
       claimSubscriptionBalanceToCampaign: async () => 'claim-tx-hash',
       getClaimableBalance: async () => ({ id: 'balance' }),
       isClaimableBalanceGoneError: () => false,
       buildUnsignedSubscriptionTransaction: async () => ({ unsignedXdr: 'test' }),
       submitPreparedSubscriptionTransaction: async () => ({ txHash: 'tx', balanceIds: [] }),
       ...stellar,
    },
    './walletSecrets': {
      withDecryptedWalletSecret: async (_encrypted, _ctx, fn) => fn('SCONTRIBUTORSECRET'),
    },
    './contributionService': { buildContributionMemo: () => 'cp-memo' },
    './notifications': {
      createNotification: async (userId, message) => {
        notifications.push({ userId, ...message });
      },
    },
  });

  return { service, calls, notifications };
}

function campaignRow(overrides = {}) {
  return {
    id: CAMPAIGN_ID,
    wallet_public_key: CAMPAIGN_WALLET,
    asset_type: 'XLM',
    ...overrides,
  };
}

function userRow() {
  return {
    id: USER_ID,
    wallet_public_key: CONTRIBUTOR_WALLET,
    wallet_secret_encrypted: 'encrypted-secret',
  };
}

test('createSubscription creates one claimable balance per period with a 30-day reclaim predicate', async () => {
  let createArgs = null;
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes('INSERT INTO subscriptions')) return { rows: [{ id: SUBSCRIPTION_ID }] };
      return { rows: [] };
    },
    stellar: {
      createSubscriptionClaimableBalances: async (args) => {
        createArgs = args;
        return {
          txHash: 'tx',
          balanceIds: args.entries.map((_e, i) => `balance-${i + 1}`),
        };
      },
    },
  });

  const before = Date.now();
  const result = await service.createSubscription({
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    amountPerPeriod: 10,
    asset: 'XLM',
    periodMonths: 1,
    totalPeriods: 6,
  });

  assert.equal(createArgs.entries.length, 6);
  assert.equal(result.balanceIds.length, 6);
  assert.equal(result.totalCommitment, 60);
  assert.equal(result.subscriptionId, SUBSCRIPTION_ID);

  // Period N is due at now + N * periodMonths * 30 days, and reclaimable 30 days later.
  const inserted = calls.filter((c) => c.text.includes('INSERT INTO subscription_balances'));
  assert.equal(inserted.length, 6);
  inserted.forEach((call, index) => {
    const scheduledMs = new Date(call.params[2]).getTime();
    const expectedMs = before + (index + 1) * 30 * DAY_MS;
    assert.ok(Math.abs(scheduledMs - expectedMs) < 5000);
    assert.equal(createArgs.entries[index].reclaimAfterUnix, Math.floor((scheduledMs + 30 * DAY_MS) / 1000));
  });

  assert.equal(new Date(result.firstPaymentDate).getTime(), new Date(inserted[0].params[2]).getTime());
});

test('createSubscription rejects a commitment larger than the wallet balance', async () => {
  const { service } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      return { rows: [] };
    },
    stellar: { getCampaignBalance: async () => ({ XLM: '50' }) },
  });

  await assert.rejects(
    () =>
      service.createSubscription({
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        amountPerPeriod: 10,
        asset: 'XLM',
        periodMonths: 1,
        totalPeriods: 6,
      }),
    (err) => {
      assert.equal(err.code, 'INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test('createSubscription rejects a period count outside 2–24', async () => {
  const { service } = buildService({});

  await assert.rejects(
    () =>
      service.createSubscription({
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        amountPerPeriod: 10,
        asset: 'XLM',
        periodMonths: 1,
        totalPeriods: 25,
      }),
    /totalPeriods must be an integer between 2 and 24/
  );
});

test('cancelSubscription cancels distant periods and reports the rest as non-cancellable', async () => {
  const soon = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const distant = new Date(Date.now() + 40 * DAY_MS).toISOString();

  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscriptions'))
        return { rows: [{ id: SUBSCRIPTION_ID, status: 'active' }] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("status = 'cancellation_requested'")) {
        return { rows: [{ id: 'b3', stellar_balance_id: 'balance-3', scheduled_date: distant, amount: '10' }] };
      }
      if (text.includes('FROM subscription_balances')) {
        return {
          rows: [
            { id: 'b1', stellar_balance_id: 'balance-1', scheduled_date: soon, amount: '10', status: 'claimed' },
            { id: 'b2', stellar_balance_id: 'balance-2', scheduled_date: soon, amount: '10', status: 'pending' },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await service.cancelSubscription({
    campaignId: CAMPAIGN_ID,
    subscriptionId: SUBSCRIPTION_ID,
    userId: USER_ID,
  });

  assert.equal(result.cancelled, 1);
  assert.equal(result.nonCancellable, 2);
  assert.deepEqual(
    result.non_cancellable_balances.map((b) => b.reason),
    ['already_claimed', 'within_notice_period']
  );
  assert.equal(
    new Date(result.estimatedRefundDate).getTime(),
    new Date(distant).getTime() + 30 * DAY_MS
  );
  assert.ok(calls.some((c) => c.text.includes("UPDATE subscriptions SET status = 'cancelled'")));
});

test('cancelSubscription 404s for a subscription belonging to someone else', async () => {
  const { service } = buildService({ queryImpl: async () => ({ rows: [] }) });

  await assert.rejects(
    () =>
      service.cancelSubscription({
        campaignId: CAMPAIGN_ID,
        subscriptionId: SUBSCRIPTION_ID,
        userId: USER_ID,
      }),
    (err) => err.statusCode === 404
  );
});

function dueBalanceRow(overrides = {}) {
  return {
    id: 'sb-1',
    subscription_id: SUBSCRIPTION_ID,
    stellar_balance_id: 'balance-1',
    amount: '10',
    scheduled_date: new Date(Date.now() - DAY_MS).toISOString(),
    asset: 'XLM',
    campaign_id: CAMPAIGN_ID,
    campaign_public_key: CAMPAIGN_WALLET,
    contributor_public_key: CONTRIBUTOR_WALLET,
    ...overrides,
  };
}

test('the claim worker claims a due balance and records it as a contribution', async () => {
  let claimArgs = null;
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contribution-1' }] };
      if (text.includes("FILTER (WHERE status = 'pending')")) {
        return { rows: [{ pending: 0, reclaimed: 0, total: 6, claimed: 6 }] };
      }
      return { rows: [] };
    },
    stellar: {
      claimSubscriptionBalanceToCampaign: async (args) => {
        claimArgs = args;
        return 'claim-tx-hash';
      },
    },
  });

  const result = await service.processDueSubscriptionBalances();

  assert.deepEqual(result, { claimed: 1, reclaimed: 0, failed: 0, closed: 0 });
  assert.equal(claimArgs.balanceId, 'balance-1');
  assert.equal(claimArgs.destinationPublicKey, CAMPAIGN_WALLET);

  const contribution = calls.find((c) => c.text.includes('INSERT INTO contributions'));
  assert.equal(contribution.params[4], 'claim-tx-hash');
  assert.ok(contribution.text.includes('subscription_claim'));
  assert.ok(calls.some((c) => c.text.includes('raised_amount = raised_amount + $1')));
});

test('the claim worker completes a subscription once every period has been claimed', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contribution-1' }] };
      if (text.includes("FILTER (WHERE status = 'pending')")) {
        return { rows: [{ pending: 0, reclaimed: 0, total: 6, claimed: 6 }] };
      }
      return { rows: [] };
    },
  });

  await service.processDueSubscriptionBalances();

  const settle = calls.find((c) => c.text.includes('UPDATE subscriptions SET status = $2'));
  assert.equal(settle.params[1], 'completed');
});

test('the claim worker leaves a subscription active while periods are still pending', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contribution-1' }] };
      if (text.includes("FILTER (WHERE status = 'pending')")) {
        return { rows: [{ pending: 5, reclaimed: 0, total: 6, claimed: 1 }] };
      }
      return { rows: [] };
    },
  });

  await service.processDueSubscriptionBalances();

  assert.ok(!calls.some((c) => c.text.includes('UPDATE subscriptions SET status = $2')));
});

test('the claim worker records a contributor reclaim and cancels the subscription', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    stellar: { getClaimableBalance: async () => null },
  });

  const result = await service.processDueSubscriptionBalances();

  assert.deepEqual(result, { claimed: 0, reclaimed: 1, failed: 0, closed: 0 });
  assert.ok(calls.some((c) => c.text.includes("status = 'contributor_reclaimed'")));
  assert.ok(calls.some((c) => c.text.includes("UPDATE subscriptions SET status = 'cancelled'")));
});

test('the claim worker treats a vanished balance mid-claim as a contributor reclaim', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    stellar: {
      claimSubscriptionBalanceToCampaign: async () => {
        throw new Error('op_does_not_exist');
      },
      isClaimableBalanceGoneError: () => true,
    },
  });

  const result = await service.processDueSubscriptionBalances();

  assert.deepEqual(result, { claimed: 0, reclaimed: 1, failed: 0, closed: 0 });
  assert.ok(calls.some((c) => c.text.includes("status = 'contributor_reclaimed'")));
});

// --- Campaign closure (#837) --------------------------------------------------

function closedRow(overrides = {}) {
  return {
    id: 'sb-9',
    subscription_id: SUBSCRIPTION_ID,
    stellar_balance_id: 'balance-9',
    amount: '10.0000000',
    reclaimable_at: new Date('2026-12-14T00:00:00Z'),
    closure_reason: 'campaign_funded',
    contributor_user_id: USER_ID,
    campaign_id: CAMPAIGN_ID,
    asset: 'XLM',
    campaign_title: 'Clean water',
    ...overrides,
  };
}

test('the claim worker closes installments of a closed campaign instead of claiming them', async () => {
  let claims = 0;
  const { service, calls, notifications } = buildService({
    closeImpl: async (_text, params) => (params[0] === null ? { rows: [closedRow(), closedRow({ id: 'sb-10', stellar_balance_id: 'balance-10', reclaimable_at: new Date('2027-01-13T00:00:00Z') })] } : { rows: [] }),
    // The due query filters on the campaign predicate, so nothing is due.
    queryImpl: async () => ({ rows: [] }),
    clientQueryImpl: async (text) => {
      if (text.includes("FILTER (WHERE status = 'pending')")) {
        return { rows: [{ pending: 0, reclaimed: 0, closed: 2, total: 4, claimed: 2 }] };
      }
      return { rows: [] };
    },
    stellar: {
      claimSubscriptionBalanceToCampaign: async () => {
        claims += 1;
        return 'tx';
      },
    },
  });

  const result = await service.processDueSubscriptionBalances();

  assert.deepEqual(result, { claimed: 0, reclaimed: 0, failed: 0, closed: 2 });
  assert.equal(claims, 0, 'no claim transaction for a campaign that stopped accepting installments');

  // Ledger balance IDs are kept: closure is an UPDATE to 'closed', never a DELETE.
  assert.ok(!calls.some((c) => /DELETE FROM subscription_balances/.test(c.text)));
  const close = calls.find((c) => c.text.includes("SET status = 'closed'"));
  assert.match(close.text, /reclaimable_at = sb\.scheduled_date \+/);
  assert.equal(close.params[1], 30, 'reclaimable after the 30-day contributor predicate opens');

  // Closure never touches campaign totals, status, rewards or referrals.
  assert.ok(!calls.some((c) => /UPDATE campaigns/.test(c.text)));
  assert.ok(!calls.some((c) => /INSERT INTO contributions/.test(c.text)));
  assert.ok(!calls.some((c) => /reward|referral/i.test(c.text)));

  const settle = calls.find((c) => c.text.includes('UPDATE subscriptions SET status = $2'));
  assert.equal(settle.params[1], 'closed');
  assert.ok(calls.some((c) => c.text.includes('closure_reason = $2')));

  assert.equal(notifications.length, 1, 'one notification per subscription');
  assert.equal(notifications[0].userId, USER_ID);
  assert.equal(notifications[0].type, 'subscription_closed');
  assert.match(notifications[0].body, /reached its goal/);
  assert.match(notifications[0].body, /reclaimable to your wallet between 2026-12-14 and 2027-01-13/);
});

test('the acceptance predicate covers status, soft-delete and deadline on every claim path', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      return { rows: [] };
    },
  });

  await service.processDueSubscriptionBalances();

  const predicateQueries = calls.filter((c) => c.text.includes("c.status = 'active'"));
  // Bulk closure, due selection, per-balance closure and per-balance re-check.
  assert.ok(predicateQueries.length >= 4);
  for (const q of predicateQueries) {
    assert.match(q.text, /c\.deleted_at IS NULL/);
    assert.match(q.text, /sb\.scheduled_date < \(c\.deadline \+ INTERVAL '1 day'\)/);
  }
});

test('a campaign funded by an earlier claim in the batch gets no further claims', async () => {
  const claimed = [];
  let funded = false;
  const { service } = buildService({
    closeImpl: async (_text, params) => {
      // After the first claim funds the campaign, the per-balance check closes sb-2.
      if (funded && params[0] === 'sb-2') return { rows: [closedRow({ id: 'sb-2' })] };
      return { rows: [] };
    },
    queryImpl: async (text) => {
      if (text.includes('SELECT 1')) return { rows: funded ? [] : [{ '?column?': 1 }] };
      if (text.includes('FROM subscription_balances sb')) {
        return { rows: [dueBalanceRow(), dueBalanceRow({ id: 'sb-2', stellar_balance_id: 'balance-2' })] };
      }
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      if (text.includes('INSERT INTO contributions')) {
        funded = true;
        return { rows: [{ id: 'contribution-1' }] };
      }
      if (text.includes("FILTER (WHERE status = 'pending')")) {
        return { rows: [{ pending: 1, reclaimed: 0, closed: 0, total: 2, claimed: 1 }] };
      }
      return { rows: [] };
    },
    stellar: {
      claimSubscriptionBalanceToCampaign: async (args) => {
        claimed.push(args.balanceId);
        return `tx-${args.balanceId}`;
      },
    },
  });

  const result = await service.processDueSubscriptionBalances();

  assert.deepEqual(claimed, ['balance-1']);
  assert.equal(result.claimed, 1);
  assert.equal(result.closed, 1);
});

test('recording a claim can only move an active campaign to funded', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM subscription_balances sb')) return { rows: [dueBalanceRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes("SET status = 'claimed'")) return { rows: [{ id: 'sb-1' }] };
      if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contribution-1' }] };
      return { rows: [] };
    },
  });

  await service.processDueSubscriptionBalances();

  const update = calls.find((c) => c.text.includes('raised_amount = raised_amount + $1'));
  assert.match(update.text, /WHEN status = 'active' AND raised_amount \+ \$1 >= target_amount THEN 'funded'/);
});

function deadlineService(deadline, onCreate) {
  return buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow({ deadline })] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      return { rows: [] };
    },
    clientQueryImpl: async (text) => {
      if (text.includes('INSERT INTO subscriptions')) return { rows: [{ id: SUBSCRIPTION_ID }] };
      return { rows: [] };
    },
    stellar: {
      createSubscriptionClaimableBalances: async (args) => {
        if (onCreate) onCreate(args);
        return { txHash: 'tx', balanceIds: args.entries.map((_e, i) => `balance-${i + 1}`) };
      },
    },
  });
}

function isoDateInDays(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

test('createSubscription rejects a schedule that runs past the campaign deadline', async () => {
  let locked = false;
  const { service } = deadlineService(isoDateInDays(100), () => { locked = true; });

  await assert.rejects(
    service.createSubscription({
      campaignId: CAMPAIGN_ID,
      userId: USER_ID,
      amountPerPeriod: 10,
      asset: 'XLM',
      periodMonths: 1,
      totalPeriods: 6,
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'SUBSCRIPTION_EXCEEDS_DEADLINE');
      assert.match(err.message, /at most 3 period/);
      return true;
    }
  );
  assert.equal(locked, false, 'no funds are locked for a rejected schedule');
});

test('createSubscription truncates to the funding window only when asked explicitly', async () => {
  let createArgs = null;
  const { service, calls } = deadlineService(isoDateInDays(100), (args) => { createArgs = args; });

  const result = await service.createSubscription({
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    amountPerPeriod: 10,
    asset: 'XLM',
    periodMonths: 1,
    totalPeriods: 6,
    truncateToDeadline: true,
  });

  assert.equal(createArgs.entries.length, 3);
  assert.equal(result.totalPeriods, 3);
  assert.equal(result.requestedPeriods, 6);
  assert.equal(result.truncatedToDeadline, true);
  assert.equal(result.totalCommitment, 30);
  const subscriptionInsert = calls.find((c) => c.text.includes('INSERT INTO subscriptions'));
  assert.equal(subscriptionInsert.params[5], 3, 'persisted total_periods matches the truncated schedule');
  assert.ok(new Date(result.lastPaymentDate) < new Date(`${isoDateInDays(101)}T00:00:00Z`));
});

test('createSubscription rejects truncation that would leave fewer than the minimum periods', async () => {
  const { service } = deadlineService(isoDateInDays(45));

  await assert.rejects(
    service.createSubscription({
      campaignId: CAMPAIGN_ID,
      userId: USER_ID,
      amountPerPeriod: 10,
      asset: 'XLM',
      periodMonths: 1,
      totalPeriods: 4,
      truncateToDeadline: true,
    }),
    (err) => err.code === 'SUBSCRIPTION_EXCEEDS_DEADLINE' && /needs at least 2/.test(err.message)
  );
});

test('createSubscription accepts a schedule that ends on the deadline day, or with no deadline', async () => {
  // Period 2 is due in 60 days; a deadline on that day still accepts it.
  const onDeadline = deadlineService(isoDateInDays(60));
  const result = await onDeadline.service.createSubscription({
    campaignId: CAMPAIGN_ID, userId: USER_ID, amountPerPeriod: 10, asset: 'XLM', periodMonths: 1, totalPeriods: 2,
  });
  assert.equal(result.totalPeriods, 2);
  assert.equal(result.truncatedToDeadline, false);

  const noDeadline = deadlineService(null);
  const open = await noDeadline.service.createSubscription({
    campaignId: CAMPAIGN_ID, userId: USER_ID, amountPerPeriod: 10, asset: 'XLM', periodMonths: 6, totalPeriods: 24,
  });
  assert.equal(open.totalPeriods, 24);
});

test('periodsWithinFundingWindow counts periods due on or before the deadline date', () => {
  const { service } = buildService({});
  const start = new Date('2026-09-26T12:00:00Z');
  assert.equal(service.periodsWithinFundingWindow(start, 1, 6, null), 6);
  assert.equal(service.periodsWithinFundingWindow(start, 1, 6, '2026-10-26'), 1);
  assert.equal(service.periodsWithinFundingWindow(start, 1, 6, '2026-10-25'), 0);
  assert.equal(service.periodsWithinFundingWindow(start, 3, 6, '2027-06-30'), 3);
});

test('listSubscriptionsForUser reports closed installments and when they become reclaimable', async () => {
  const { service, calls } = buildService({ queryImpl: async () => ({ rows: [] }) });
  await service.listSubscriptionsForUser(USER_ID);
  const q = calls[0].text;
  assert.match(q, /periods_closed/);
  assert.match(q, /closed_amount/);
  assert.match(q, /reclaimable_from/);
  assert.match(q, /s\.closure_reason/);
});
