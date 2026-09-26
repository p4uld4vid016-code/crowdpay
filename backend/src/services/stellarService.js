/**
 * stellarService.js
 *
 * Core Stellar operations:
 *   - Create campaign wallets (multisig)
 *   - Establish trustlines
 *   - Build and submit contribution transactions
 *   - Path payment (cross-currency contributions)
 */

const {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
  Claimant,
  xdr,
} = require('@stellar/stellar-sdk');
const {
  server,
  networkPassphrase,
  USDC,
  isTestnet,
  configuredAssets,
} = require('../config/stellar');
const Sentry = require("@sentry/node");
const {
  TX_TIMEOUT_CONTRIBUTION_S,
  TX_TIMEOUT_WITHDRAWAL_S,
  CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM,
  CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM,
} = require("../config/constants");

const logger = require('../config/logger');
const db = require('../config/database');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const { getPlatformFee } = require('./feeRegistry');
const { toStroops, fromStroops, splitFee, mulBpsCeil } = require('../utils/stroops');

function loadKeypair(envVar) {
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`${envVar} is not configured`);
  }
  return Keypair.fromSecret(secret);
}

function getPlatformKeypair() {
  return loadKeypair('PLATFORM_SECRET_KEY');
}

function getArbitratorKeypair() {
  return loadKeypair('ARBITRATOR_SECRET_KEY');
}

function getPlatformPublicKey() {
  return getPlatformKeypair().publicKey();
}

function getArbitratorPublicKey() {
  return getArbitratorKeypair().publicKey();
}

// Lazily resolved at use-sites via getPlatformKeypair()/getArbitratorKeypair()
// (previously eager Keypair.fromSecret at import time crashed boot/tests).

/**
 * Split a contribution into campaign share and platform fee in exact stroops
 * (#840). Amounts are returned as canonical 7-decimal strings (safe to hand
 * to Horizon operations and to persist) plus their BigInt stroop values;
 * feeStroops + campaignStroops always equals amountStroops.
 */
async function calcFee(amount) {
  const bps = Number(await getPlatformFee()) || 0;
  const amountStroops = toStroops(amount);
  const { feeStroops, campaignStroops } = splitFee(amountStroops, bps);
  return {
    feeAmount: fromStroops(feeStroops),
    campaignAmount: fromStroops(campaignStroops),
    amountStroops,
    feeStroops,
    campaignStroops,
    bps,
  };
}

function toStellarAsset(assetCode) {
  if (assetCode === 'XLM') return Asset.native();
  if (assetCode === 'USDC') return USDC;
  if (configuredAssets[assetCode]?.issuer) {
    return new Asset(assetCode, configuredAssets[assetCode].issuer);
  }
  throw new Error(`Unsupported asset: ${assetCode}`);
}

function getSupportedAssetCodes() {
  return Object.keys(configuredAssets);
}

/** Issued assets CrowdPay may move on-chain (requires trustlines on custodial accounts). */
function listCreditAssetCodes() {
  return getSupportedAssetCodes().filter((code) => code !== 'XLM');
}

function accountHasCreditTrustline(account, assetCode) {
  if (assetCode === 'XLM') return true;
  const asset = toStellarAsset(assetCode);
  return account.balances.some(
    (b) =>
      b.asset_type !== 'native' &&
      b.asset_code === asset.code &&
      b.asset_issuer === asset.issuer
  );
}

/** Minimum starting XLM for a new account that will hold `trustlineCount` trust lines (approximate). */
function suggestedFundingXlmForCustodialAccount(trustlineCount) {
  return (
    CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM +
    Math.max(0, trustlineCount) * CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM
  ).toFixed(7);
}

async function accountExistsOnLedger(publicKey) {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) return false;
    if (err?.response?.data?.status === 404) return false;
    throw err;
  }
}

/**
 * Create and fund a custodial account on the ledger (platform pays createAccount fee + reserve).
 * No-op if the account already exists.
 */
async function fundCustodialAccountFromPlatformIfNeeded(publicKey) {
  if (await accountExistsOnLedger(publicKey)) return false;
  const trustlineCount = listCreditAssetCodes().length;
  const startingBalance = suggestedFundingXlmForCustodialAccount(trustlineCount);
  const platformAccount = await server.loadAccount(getPlatformKeypair().publicKey());
  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: publicKey,
        startingBalance,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(getPlatformKeypair());
  await server.submitTransaction(tx);
  return true;
}

/**
 * Top up an existing campaign wallet's native XLM reserve from the platform
 * account. Used by ops wallet-audit approve-funding (#811).
 */
async function submitWalletTopUpPayment({ destinationPublicKey, amountXlm }) {
  const platformAccount = await server.loadAccount(getPlatformKeypair().publicKey());
  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount: String(amountXlm),
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(getPlatformKeypair());
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Add missing trustlines for all configured credit assets; signed by the custodial account master.
 * Returns the last transaction hash if a transaction was submitted, otherwise null.
 */
async function submitMissingTrustlinesForCustodialAccount(signerSecret) {
  const keypair = Keypair.fromSecret(signerSecret);
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  let missing = 0;
  for (const code of listCreditAssetCodes()) {
    if (!accountHasCreditTrustline(account, code)) {
      builder.addOperation(Operation.changeTrust({ asset: toStellarAsset(code) }));
      missing += 1;
    }
  }

  if (!missing) return null;

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Ensure a custodial user (or any funded keypair we hold) can hold and send all supported issued assets.
 * Creates the ledger account via platform if missing, then establishes any missing trustlines.
 */
async function ensureCustodialAccountFundedAndTrusted({ publicKey, secret }) {
  await fundCustodialAccountFromPlatformIfNeeded(publicKey);
  return submitMissingTrustlinesForCustodialAccount(secret);
}

function normalizeAsset(record) {
  if (!record) return null;
  if (record.asset_type === 'native') return 'XLM';
  return record.asset_code;
}

/**
 * Create a new Stellar account for a campaign.
 * The platform funds the minimum reserve (1 XLM on testnet).
 * Both the creator's key and the platform key are added as signers.
 * Medium threshold is set to 2 — both must sign to move funds.
 */
async function createCampaignWallet(creatorPublicKey, campaignKeypair) {
  if (!campaignKeypair) campaignKeypair = Keypair.random();
  const platformAccount = await server.loadAccount(getPlatformKeypair().publicKey());

  const creditCodes = listCreditAssetCodes();
  const campaignStartingBalance = suggestedFundingXlmForCustodialAccount(creditCodes.length + 1);

  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: campaignKeypair.publicKey(),
        startingBalance: campaignStartingBalance,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(getPlatformKeypair());
  await server.submitTransaction(tx);

  // Now configure the campaign account: trustline + multisig
  const campaignAccount = await server.loadAccount(campaignKeypair.publicKey());

  const setupBuilder = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });
  for (const code of creditCodes) {
    setupBuilder.addOperation(Operation.changeTrust({ asset: toStellarAsset(code) }));
  }
  const setupTx = setupBuilder
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: creatorPublicKey, weight: 1 },
      })
    )
    // Add platform as signer (weight 1)
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: getPlatformKeypair().publicKey(), weight: 1 },
      })
    )
    // Set thresholds: medium ops (payments) require weight 2 (both signers)
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,     // disable the campaign keypair itself
        lowThreshold: 1,
        medThreshold: 2,
        highThreshold: 2,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  setupTx.sign(campaignKeypair);
  await server.submitTransaction(setupTx);

  return {
    publicKey: campaignKeypair.publicKey(),
    secret: campaignKeypair.secret(),
  };
}

async function loadDecryptedCreatorSecret(creatorId) {
  const { rows } = await db.query(
    'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [creatorId]
  );
  const userRow = rows[0];
  if (!userRow || !userRow.wallet_secret_encrypted) {
    throw new Error('Creator wallet secret is unavailable');
  }
  let creatorSecret = null;
  await withDecryptedWalletSecret(
    userRow.wallet_secret_encrypted,
    { userId: userRow.id, walletPublicKey: userRow.wallet_public_key },
    async (secret) => {
      creatorSecret = secret;
    }
  );
  return creatorSecret;
}

/**
 * Dispute escrow freeze: adds the platform arbitrator as a third signer
 * (weight 1) and raises the medium/high thresholds from 2 to 3, so that any
 * further movement of funds requires creator + platform + arbitrator
 * agreement. This is a high-threshold SetOptions op, so it needs signatures
 * meeting the *current* (pre-freeze) high threshold of 2 — creator and
 * platform. Both secrets are held custodially, so this is built, signed and
 * submitted in one shot rather than routed through the async
 * creator-approval flow used for withdrawals.
 */
async function freezeCampaignEscrow({ campaignWalletPublicKey, creatorId }) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const creatorSecret = await loadDecryptedCreatorSecret(creatorId);

  const tx = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: getArbitratorKeypair().publicKey(), weight: 1 },
      })
    )
    .addOperation(
      Operation.setOptions({
        medThreshold: 3,
        highThreshold: 3,
      })
    )
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S)
    .build();

  tx.sign(Keypair.fromSecret(creatorSecret));
  tx.sign(getPlatformKeypair());

  const result = await server.submitTransaction(tx);
  return { hash: result.hash };
}

/**
 * Reverses freezeCampaignEscrow: removes the arbitrator signer and restores
 * thresholds to 2. The account currently requires all three signers (weight
 * 3 threshold) to authorize this, so creator + platform + arbitrator all
 * sign here.
 */
async function releaseEscrowFreeze({ campaignWalletPublicKey, creatorId }) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const creatorSecret = await loadDecryptedCreatorSecret(creatorId);

  const tx = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: getArbitratorKeypair().publicKey(), weight: 0 },
      })
    )
    .addOperation(
      Operation.setOptions({
        medThreshold: 2,
        highThreshold: 2,
      })
    )
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S)
    .build();

  tx.sign(Keypair.fromSecret(creatorSecret));
  tx.sign(getPlatformKeypair());
  tx.sign(getArbitratorKeypair());

  const result = await server.submitTransaction(tx);
  return { hash: result.hash };
}

/**
 * Submits a batch refund transaction while a campaign is under an active
 * dispute freeze (3-of-3 threshold): creator + platform + arbitrator sign.
 */
async function submitDisputeRefund({ campaignWalletPublicKey, creatorId, refunds }) {
  const unsignedXdr = await buildBatchRefundTransaction({ campaignWalletPublicKey, refunds });
  const creatorSecret = await loadDecryptedCreatorSecret(creatorId);

  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(Keypair.fromSecret(creatorSecret));
  tx.sign(getPlatformKeypair());
  tx.sign(getArbitratorKeypair());

  const result = await server.submitTransaction(tx);
  return { hash: result.hash, xdr: tx.toXDR() };
}

/**
 * Build an unsigned payment contribution transaction.
 */
async function buildUnsignedContributionPayment({
  senderPublicKey,
  destinationPublicKey,
  asset,
  amount,
  memo,
  feeSplit,
}) {
  const senderAccount = await server.loadAccount(senderPublicKey);
  const stellarAsset = toStellarAsset(asset);
  // A caller that already persisted the split passes it in so the signed
  // operations are exactly the amounts it recorded (#840).
  const { feeAmount, campaignAmount, feeStroops } = feeSplit || await calcFee(amount);

  const builder = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: campaignAmount,
      })
    );

  if (feeStroops > 0n) {
    builder.addOperation(
      Operation.payment({
        destination: getPlatformKeypair().publicKey(),
        asset: stellarAsset,
        amount: feeAmount,
      })
    );
  }

  if (memo) {
    builder.addMemo(Memo.text(memo));
  }

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  return tx.toXDR();
}

/**
 * Build and sign a custodial payment contribution; returns XDR for audit + submission.
 */
async function prepareSignedContributionPayment({
  senderSecret,
  destinationPublicKey,
  asset,
  amount,
  memo,
  feeSplit,
}) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const split = feeSplit || await calcFee(amount);
  const { feeAmount } = split;
  const unsignedXdr = await buildUnsignedContributionPayment({
    senderPublicKey: senderKeypair.publicKey(),
    destinationPublicKey,
    asset,
    amount,
    memo,
    feeSplit: split,
  });
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(senderKeypair);
  const signedXdr = tx.toXDR();
  return { unsignedXdr, signedXdr, feeAmount };
}

/**
 * Submit a simple payment contribution (XLM or USDC direct).
 * For custodial users the backend signs on their behalf.
 */
async function submitPayment(params) {
  const { signedXdr } = await prepareSignedContributionPayment(params);
  return submitPreparedTransaction(signedXdr);
}

/**
 * Build an unsigned path payment contribution; `destAssetCode` is the asset the campaign receives.
 */
async function buildUnsignedContributionPathPayment({
  senderPublicKey,
  destinationPublicKey,
  sendAsset,
  sendMax,
  destAmount,
  destAssetCode,
  memo,
  feeSplit,
}) {
  const senderAccount = await server.loadAccount(senderPublicKey);
  const sourceStellarAsset = toStellarAsset(sendAsset);
  const destStellarAsset = toStellarAsset(destAssetCode);
  const { feeAmount, campaignAmount, feeStroops, bps } = feeSplit || await calcFee(destAmount);

  // Split the send maximum across the two operations in exact stroops: the
  // fee share is rounded up and the campaign share is the remainder, so the
  // two never exceed the sendMax the contributor approved.
  const sendMaxStroops = toStroops(sendMax);
  const feeSendMaxStroops = feeStroops > 0n ? mulBpsCeil(sendMaxStroops, bps) : 0n;
  const campaignSendMax = fromStroops(sendMaxStroops - feeSendMaxStroops);
  const feeSendMax = fromStroops(feeSendMaxStroops);

  const builder = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: sourceStellarAsset,
        sendMax: campaignSendMax,
        destination: destinationPublicKey,
        destAsset: destStellarAsset,
        destAmount: campaignAmount,
        path: [],
      })
    );

  if (feeStroops > 0n) {
    builder.addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: sourceStellarAsset,
        sendMax: feeSendMax,
        destination: getPlatformKeypair().publicKey(),
        destAsset: destStellarAsset,
        destAmount: feeAmount,
        path: [],
      })
    );
  }

  if (memo) {
    builder.addMemo(Memo.text(memo));
  }

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  return tx.toXDR();
}

/**
 * Build and sign a path payment contribution; `destAssetCode` is the asset the campaign receives.
 */
async function prepareSignedContributionPathPayment({
  senderSecret,
  destinationPublicKey,
  sendAsset,
  sendMax,
  destAmount,
  destAssetCode,
  memo,
  feeSplit,
}) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const split = feeSplit || await calcFee(destAmount);
  const { feeAmount } = split;
  const unsignedXdr = await buildUnsignedContributionPathPayment({
    senderPublicKey: senderKeypair.publicKey(),
    destinationPublicKey,
    sendAsset,
    sendMax,
    destAmount,
    destAssetCode,
    memo,
    feeSplit: split,
  });
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(senderKeypair);
  const signedXdr = tx.toXDR();
  return { unsignedXdr, signedXdr, feeAmount };
}

/**
 * Submit a path payment contribution.
 * The contributor sends `sendAsset`; the campaign receives exactly `destAmount` of `destAssetCode`.
 */
async function submitPathPayment(params) {
  const destAssetCode = params.destAssetCode || 'USDC';
  const { signedXdr } = await prepareSignedContributionPathPayment({
    ...params,
    destAssetCode,
  });
  return submitPreparedTransaction(signedXdr);
}

/**
 * Get a path payment quote for strict-receive contribution flow.
 * Returns candidate conversion paths from Stellar DEX.
 */
async function getPathPaymentQuote({ sendAsset, destAsset, destAmount }) {
  const sourceStellarAsset = toStellarAsset(sendAsset);
  const destinationStellarAsset = toStellarAsset(destAsset);

  const response = await server
    .strictReceivePaths(sourceStellarAsset, destinationStellarAsset, String(destAmount))
    .call();

  return (response.records || []).map((record) => ({
    source_asset: normalizeAsset({
      asset_type: record.source_asset_type,
      asset_code: record.source_asset_code,
    }),
    destination_asset: normalizeAsset({
      asset_type: record.destination_asset_type,
      asset_code: record.destination_asset_code,
    }),
    destination_amount: record.destination_amount,
    source_amount: record.source_amount,
    path: (record.path || []).map((pathAsset) => normalizeAsset(pathAsset)),
  }));
}

/**
 * Build a withdrawal transaction for a campaign wallet.
 * Returns the unsigned XDR — both the creator and platform must sign it.
 * 
 * @param {object} params - Transaction parameters
 * @param {string} params.campaignWalletPublicKey - Campaign wallet public key
 * @param {string} params.destinationPublicKey - Destination public key (creator's withdrawal destination)
 * @param {number} params.amount - Withdrawal amount
 * @param {string} params.asset - Asset type (XLM, USDC, etc.)
 * @param {number} params.collectedFees - Total platform fees collected for this campaign
 * @param {string} params.creatorPublicKey - Creator's public key (for revenue share)
 */
async function buildWithdrawalTransaction({
  campaignWalletPublicKey,
  destinationPublicKey,
  amount,
  asset,
  commissions = [],
  collectedFees = 0,
  creatorPublicKey = null,
}) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const stellarAsset = toStellarAsset(asset);

  const payableCommissions = commissions.filter(
    (commission) => commission.destinationPublicKey && parseFloat(commission.amount) > 0
  );

  const builder = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  // Main withdrawal payment to destination
  builder.addOperation(
    Operation.payment({
      destination: destinationPublicKey,
      asset: stellarAsset,
      amount: String(amount),
    })
  );

  for (const commission of payableCommissions) {
    builder.addOperation(
      Operation.payment({
        destination: commission.destinationPublicKey,
        asset: stellarAsset,
        amount: String(commission.amount),
      })
    );
  }

  // Creator revenue share payment (if applicable)
  if (collectedFees > 0 && creatorPublicKey) {
    const { calculateCreatorShare } = require('./feeRegistry');
    const creatorShare = await calculateCreatorShare(collectedFees);
    
    if (creatorShare > 0) {
      builder.addOperation(
        Operation.payment({
          destination: creatorPublicKey,
          asset: stellarAsset,
          amount: String(creatorShare),
        })
      );
    }
  }

  const tx = builder
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S) // platform approver may not be available immediately (see issue #128)
    .build();

  return tx.toXDR();
}

/**
 * Build a batch refund transaction for a campaign wallet returning funds to multiple contributors.
 * Returns the unsigned XDR.
 */
async function buildBatchRefundTransaction({
  campaignWalletPublicKey,
  refunds,
}) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const builder = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  for (const refund of refunds) {
    const stellarAsset = toStellarAsset(refund.asset);
    builder.addOperation(
      Operation.payment({
        destination: refund.destinationPublicKey,
        asset: stellarAsset,
        amount: String(refund.amount),
      })
    );
  }

  const tx = builder
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S) // 7 days
    .build();

  return tx.toXDR();
}

async function getAccountMultisigConfig(publicKey) {
  const account = await server.loadAccount(publicKey);
  return {
    thresholds: account.thresholds,
    signers: account.signers || [],
  };
}

function signTransactionXdr({ xdr, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function signatureCountFromXdr(xdr) {
  const tx = new Transaction(xdr, networkPassphrase);
  return tx.signatures.length;
}

/**
 * Returns true if the XDR transaction's maxTime has already passed.
 * Returns false if the XDR cannot be parsed or has no time bounds set.
 */
function isXdrExpired(xdr) {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    const { timeBounds } = tx;
    return !!(timeBounds && Math.floor(Date.now() / 1000) > Number(timeBounds.maxTime));
  } catch {
    return false;
  }
}

class WithdrawalValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WithdrawalValidationError';
    this.statusCode = 422;
    this.isValidationError = true;
  }
}

function assetMatches(asset, expectedAssetCode) {
  if (!asset || !expectedAssetCode) return true;
  if (expectedAssetCode === 'XLM') {
    return typeof asset.isNative === 'function' ? asset.isNative() : asset.code === 'XLM' || asset.type === 'native';
  }
  const code = typeof asset.getCode === 'function' ? asset.getCode() : asset.code;
  return code === expectedAssetCode;
}

/**
 * Validates that submitted signed XDR matches the server-generated unsigned XDR
 * and complies with all expected parameters (source, destination, asset, amount, sequence, network, operations, creator signature).
 */
function validateSubmittedWithdrawalXdr({
  signedXdr,
  unsignedXdr,
  creatorPublicKey,
  campaignWalletPublicKey,
  expectedDestination,
  expectedAsset,
  expectedAmount,
}) {
  if (!signedXdr) {
    throw new WithdrawalValidationError('signed_xdr is required for freighter users');
  }
  if (!unsignedXdr) {
    throw new WithdrawalValidationError('Server-generated unsigned_xdr is required to verify withdrawal');
  }

  let signedTx;
  try {
    signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch (err) {
    throw new WithdrawalValidationError('Invalid signed_xdr');
  }

  let unsignedTx;
  try {
    unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  } catch (err) {
    throw new WithdrawalValidationError('Invalid server-generated unsigned_xdr');
  }

  // 1. Compare the signed transaction body/hash to the server-generated unsigned XDR
  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    throw new WithdrawalValidationError('Signed transaction does not match the server-generated withdrawal transaction');
  }

  // 2. Validate source
  if (signedTx.source !== unsignedTx.source) {
    throw new WithdrawalValidationError('Signed transaction source does not match unsigned transaction');
  }
  if (campaignWalletPublicKey && signedTx.source !== campaignWalletPublicKey) {
    throw new WithdrawalValidationError('Transaction source account does not match campaign wallet');
  }

  // 3. Validate sequence
  if (String(signedTx.sequence) !== String(unsignedTx.sequence)) {
    throw new WithdrawalValidationError('Signed transaction sequence does not match unsigned transaction');
  }

  // 4. Validate operations
  if (!signedTx.operations || signedTx.operations.length === 0) {
    throw new WithdrawalValidationError('Transaction contains no operations');
  }

  for (const op of signedTx.operations) {
    if (op.type !== 'payment') {
      throw new WithdrawalValidationError(`Invalid operation type "${op.type}": only payment operations are allowed`);
    }
    if (expectedAsset && !assetMatches(op.asset, expectedAsset)) {
      throw new WithdrawalValidationError('Transaction operation asset does not match campaign asset');
    }
  }

  // Validate destination of primary payout
  if (expectedDestination && signedTx.operations[0].destination !== expectedDestination) {
    throw new WithdrawalValidationError('Transaction destination does not match approved withdrawal destination');
  }

  // Validate amounts
  const firstAmount = parseFloat(signedTx.operations[0].amount);
  if (isNaN(firstAmount) || firstAmount <= 0) {
    throw new WithdrawalValidationError('Transaction payment amount must be greater than 0');
  }

  const totalAmount = signedTx.operations.reduce((sum, op) => sum + parseFloat(op.amount), 0);
  if (expectedAmount && parseFloat(totalAmount.toFixed(7)) > parseFloat(expectedAmount)) {
    throw new WithdrawalValidationError('Transaction total amount exceeds approved withdrawal amount');
  }

  // 5. Validate creator signature
  if (!signedTx.signatures || signedTx.signatures.length === 0) {
    throw new WithdrawalValidationError('Signed transaction does not include any signatures');
  }

  if (creatorPublicKey) {
    let signer;
    try {
      signer = Keypair.fromPublicKey(creatorPublicKey);
    } catch (err) {
      throw new WithdrawalValidationError('Invalid creator public key');
    }
    const signatureValid = signedTx.signatures.some((decorated) => {
      try {
        return signer.verify(signedTx.hash(), decorated.signature());
      } catch (_err) {
        return false;
      }
    });
    if (!signatureValid) {
      throw new WithdrawalValidationError('Signed transaction does not include a valid signature by the creator');
    }
  }

  return true;
}

/**
 * Validates a withdrawal transaction before platform signs it.
 * Validates source, destination, asset, amount, sequence, network, operation set, and creator signature.
 */
function validateWithdrawalForPlatformSigning({
  xdr,
  creatorPublicKey,
  campaignWalletPublicKey,
  expectedDestination,
  expectedAsset,
  expectedAmount,
}) {
  if (!xdr) {
    throw new WithdrawalValidationError('Withdrawal transaction XDR is required');
  }

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch (err) {
    throw new WithdrawalValidationError('Invalid withdrawal transaction XDR');
  }

  // Validate source
  if (campaignWalletPublicKey && tx.source !== campaignWalletPublicKey) {
    throw new WithdrawalValidationError('Transaction source account does not match campaign wallet');
  }

  // Validate sequence
  if (!tx.sequence) {
    throw new WithdrawalValidationError('Transaction sequence number is missing');
  }

  // Validate operations
  if (!tx.operations || tx.operations.length === 0) {
    throw new WithdrawalValidationError('Transaction contains no operations');
  }

  for (const op of tx.operations) {
    if (op.type !== 'payment') {
      throw new WithdrawalValidationError(`Invalid operation type "${op.type}": only payment operations are allowed`);
    }
    if (expectedAsset && !assetMatches(op.asset, expectedAsset)) {
      throw new WithdrawalValidationError('Transaction operation asset does not match campaign asset');
    }
  }

  // Validate primary destination
  if (expectedDestination && tx.operations[0].destination !== expectedDestination) {
    throw new WithdrawalValidationError('Transaction destination does not match approved withdrawal destination');
  }

  // Validate amounts
  const firstAmount = parseFloat(tx.operations[0].amount);
  if (isNaN(firstAmount) || firstAmount <= 0) {
    throw new WithdrawalValidationError('Transaction payment amount must be greater than 0');
  }

  const totalAmount = tx.operations.reduce((sum, op) => sum + parseFloat(op.amount), 0);
  if (expectedAmount && parseFloat(totalAmount.toFixed(7)) > parseFloat(expectedAmount)) {
    throw new WithdrawalValidationError('Transaction total amount exceeds approved withdrawal amount');
  }

  // Validate creator signature
  if (creatorPublicKey) {
    let signer;
    try {
      signer = Keypair.fromPublicKey(creatorPublicKey);
    } catch (err) {
      throw new WithdrawalValidationError('Invalid creator public key');
    }
    const signatureValid = tx.signatures && tx.signatures.some((decorated) => {
      try {
        return signer.verify(tx.hash(), decorated.signature());
      } catch (_err) {
        return false;
      }
    });
    if (!signatureValid) {
      throw new WithdrawalValidationError('Transaction is missing a valid creator signature');
    }
  }

  return true;
}

async function submitPreparedTransaction(xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function submitSignedWithdrawal({ xdr }) {
  return submitPreparedTransaction(xdr);
}

/**
 * Get the current balance of a campaign wallet.
 */
async function getCampaignBalance(publicKey) {
  const account = await server.loadAccount(publicKey);
  const balances = {};
  for (const b of account.balances) {
    const key = b.asset_type === 'native' ? 'XLM' : b.asset_code;
    balances[key] = b.balance;
  }
  return balances;
}

/**
 * Fund a new account on testnet using Friendbot.

/**
 * Recover campaign wallet from encrypted secret.
 */
function recoverWalletFromSecret(secret) {
  const keypair = Keypair.fromSecret(secret);
  return {
    publicKey: keypair.publicKey(),
    secret: keypair.secret(),
  };
}

/**
 * Get transaction history for a campaign wallet.
 */
async function getWalletTransactionHistory(publicKey, limit = 50) {
  const txs = await server.transactions()
    .forAccount(publicKey)
    .order('desc')
    .limit(limit)
    .call();
  
  return txs.records.map(tx => ({
    hash: tx.hash,
    created_at: tx.created_at,
    source_account: tx.source_account,
    fee_charged: tx.fee_charged,
    operation_count: tx.operation_count,
    memo: tx.memo,
  }));
}

/**
 * Get payment operations for a campaign wallet (audit trail).
 */
async function getWalletPayments(publicKey, limit = 100) {
  const payments = await server.payments()
    .forAccount(publicKey)
    .order('desc')
    .limit(limit)
    .call();
  
  return payments.records.map(p => ({
    id: p.id,
    type: p.type,
    created_at: p.created_at,
    transaction_hash: p.transaction_hash,
    from: p.from,
    to: p.to,
    amount: p.amount,
    asset_type: p.asset_type === 'native' ? 'XLM' : p.asset_code,
  }));
}

/** Balance IDs of the claimable balances created by a submitted transaction, in operation order. */
function parseCreatedClaimableBalanceIds(resultXdrBase64) {
  const results = xdr.TransactionResult.fromXDR(resultXdrBase64, 'base64').result().results();
  const balanceIds = [];
  for (const opResult of results) {
    if (opResult.switch().name !== 'opInner') continue;
    const tr = opResult.tr();
    if (tr.switch().name !== 'createClaimableBalance') continue;
    balanceIds.push(tr.createClaimableBalanceResult().balanceId().toXDR('hex'));
  }
  return balanceIds;
}

/**
 * Build an unsigned transaction for creating subscription claimable balances.
 * Returns unsigned XDR without signing or submitting.
 */
async function buildUnsignedSubscriptionTransaction({ sourcePublicKey, asset, entries }) {
  const stellarAsset = toStellarAsset(asset);
  const fakeKeypair = Keypair.fromPublicKey(sourcePublicKey);
  const sourceAccount = await server.loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase });

  for (const entry of entries) {
    builder.addOperation(
      Operation.createClaimableBalance({
        asset: stellarAsset,
        amount: String(entry.amount),
        claimants: [
          new Claimant(getPlatformKeypair().publicKey(), Claimant.predicateUnconditional()),
          new Claimant(
            fakeKeypair.publicKey(),
            Claimant.predicateNot(
              Claimant.predicateBeforeAbsoluteTime(String(entry.reclaimAfterUnix))
            )
          ),
        ],
      })
    );
  }

  const tx = builder.setTimeout(30).build();
  return { unsignedXdr: tx.toXDR(), balanceEntries: entries };
}

/**
 * Submit a pre-signed subscription transaction and extract balance IDs.
 */
async function submitPreparedSubscriptionTransaction({ signedXdr, sourcePublicKey, asset, entries }) {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const result = await server.submitTransaction(tx);
  const balanceIds = parseCreatedClaimableBalanceIds(result.result_xdr);
  if (balanceIds.length !== entries.length) {
    throw new Error(
      `Expected ${entries.length} claimable balances, ledger reported ${balanceIds.length}`
    );
  }
  return { txHash: result.hash, balanceIds };
}

/**
 * Lock one claimable balance per subscription period, all in a single transaction.
 *
 * Every balance names the platform as an unconditional claimant so the claim worker can
 * release it on its scheduled date, plus the contributor under a `not(before_absolute_time)`
 * predicate — an after-absolute-time window that lets them reclaim the funds themselves if
 * the platform never claims.
 *
 * @param {Object[]} entries - One per period: { amount, reclaimAfterUnix }.
 */
async function createSubscriptionClaimableBalances({
  sourceSecret,
  asset,
  entries,
}) {
  const sourceKeypair = Keypair.fromSecret(sourceSecret);
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  const stellarAsset = toStellarAsset(asset);

  const builder = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase });
  for (const entry of entries) {
    builder.addOperation(
      Operation.createClaimableBalance({
        asset: stellarAsset,
        amount: String(entry.amount),
        claimants: [
          new Claimant(getPlatformKeypair().publicKey(), Claimant.predicateUnconditional()),
          new Claimant(
            sourceKeypair.publicKey(),
            Claimant.predicateNot(
              Claimant.predicateBeforeAbsoluteTime(String(entry.reclaimAfterUnix))
            )
          ),
        ],
      })
    );
  }

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  tx.sign(sourceKeypair);
  const result = await server.submitTransaction(tx);

  const balanceIds = parseCreatedClaimableBalanceIds(result.result_xdr);
  if (balanceIds.length !== entries.length) {
    throw new Error(
      `Expected ${entries.length} claimable balances, ledger reported ${balanceIds.length}`
    );
  }
  return { txHash: result.hash, balanceIds };
}

/** Horizon record for a claimable balance, or null once it has been claimed or never existed. */
async function getClaimableBalance(balanceId) {
  try {
    return await server.claimableBalances().claimableBalance(balanceId).call();
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Claim a due subscription balance with the platform key and forward it to the campaign
 * wallet in the same transaction, so the funds never rest on the platform account.
 */
async function claimSubscriptionBalanceToCampaign({
  balanceId,
  asset,
  amount,
  destinationPublicKey,
  memo,
}) {
  const platformAccount = await server.loadAccount(getPlatformKeypair().publicKey());
  const stellarAsset = toStellarAsset(asset);

  const builder = new TransactionBuilder(platformAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: String(amount),
      })
    );

  if (memo) builder.addMemo(Memo.text(memo));

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  tx.sign(getPlatformKeypair());
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/** True when a failed claim is explained by the balance already being gone from the ledger. */
function isClaimableBalanceGoneError(err) {
  const codes = err?.response?.data?.extras?.result_codes?.operations;
  return Array.isArray(codes) && codes.includes('op_does_not_exist');
}

async function friendbotFund(publicKey) {
  if (!isTestnet) throw new Error('Friendbot only available on testnet');
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  return response.json();
}

/**
 * Revoke platform multisig, sweep non-native/native balances to platform, and close Stellar account.
 * Used during campaign deletion.
 * @param {Object} campaign - Campaign database row or object containing wallet_public_key, creator_id, etc.
 * @returns {Promise<Object>} Status object { cleanedUp: boolean, hash?: string, reason?: string }
 */
async function revokeAndCloseCampaignWallet(campaign) {
  const walletPublicKey = campaign?.wallet_public_key;
  if (!walletPublicKey) {
    return { cleanedUp: false, reason: 'no_wallet_public_key' };
  }

  const exists = await accountExistsOnLedger(walletPublicKey);
  if (!exists) {
    return { cleanedUp: false, reason: 'account_not_on_ledger' };
  }

  const account = await server.loadAccount(walletPublicKey);

  let creatorSecret = null;
  const creatorId = campaign.creator_id;
  if (creatorId) {
    try {
      const { rows: userRows } = await db.query(
        'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
        [creatorId]
      );
      if (userRows.length && userRows[0].wallet_secret_encrypted) {
        const userRow = userRows[0];
        await withDecryptedWalletSecret(
          userRow.wallet_secret_encrypted,
          { userId: userRow.id, walletPublicKey: userRow.wallet_public_key },
          async (secret) => {
            creatorSecret = secret;
          }
        );
      }
    } catch (err) {
      logger.warn('Failed to retrieve/decrypt creator secret during campaign deletion', {
        creatorId,
        error: err.message,
      });
    }
  }

  let campaignSecret = null;
  if (campaign.wallet_secret_encrypted) {
    try {
      await withDecryptedWalletSecret(
        campaign.wallet_secret_encrypted,
        { walletPublicKey: campaign.wallet_public_key },
        async (secret) => {
          campaignSecret = secret;
        }
      );
    } catch (_err) {
      // ignore if campaign wallet secret decryption fails
    }
  }

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  // 1. Sweep non-native credit assets to platform and remove trustlines (limit 0)
  for (const b of account.balances) {
    if (b.asset_type !== 'native') {
      const asset = new Asset(b.asset_code, b.asset_issuer);
      const balanceVal = parseFloat(b.balance);
      if (balanceVal > 0) {
        builder.addOperation(
          Operation.payment({
            destination: getPlatformKeypair().publicKey(),
            asset,
            amount: b.balance,
          })
        );
      }
      builder.addOperation(
        Operation.changeTrust({
          asset,
          limit: '0',
        })
      );
    }
  }

  // 2. Remove Platform Signer
  builder.addOperation(
    Operation.setOptions({
      signer: {
        ed25519PublicKey: getPlatformKeypair().publicKey(),
        weight: 0,
      },
    })
  );

  // 3. Account Merge (sweeps all native XLM and closes account entry on-chain)
  builder.addOperation(
    Operation.accountMerge({
      destination: getPlatformKeypair().publicKey(),
    })
  );

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();

  tx.sign(getPlatformKeypair());

  if (creatorSecret) {
    try {
      const creatorKeypair = Keypair.fromSecret(creatorSecret);
      tx.sign(creatorKeypair);
    } catch (_err) {
      // ignore invalid creator keypair
    }
  }

  if (campaignSecret) {
    try {
      const campaignKeypair = Keypair.fromSecret(campaignSecret);
      tx.sign(campaignKeypair);
    } catch (_err) {
      // ignore invalid campaign keypair
    }
  }

  const result = await server.submitTransaction(tx);
  return { cleanedUp: true, hash: result.hash };
}

/**
 * Close a just-created campaign wallet by submitting a merge transaction back
 * to the platform.  The wallet secret is known (fresh from createCampaignWallet)
 * so we can build and sign everything without needing a DB record.
 *
 * Used to clean up orphaned wallets when the campaign DB insert fails.
 */
async function closeCampaignWalletBySecret(walletPublicKey, walletSecret) {
  try {
    const account = await server.loadAccount(walletPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      // Remove campaign keypair as signer
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: walletPublicKey,
            weight: 0,
          },
        })
      )
      // Remove platform signer
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: getPlatformKeypair().publicKey(),
            weight: 0,
          },
        })
      )
      // Set low threshold to 1 so the merge can go through with just the
      // platform key when the campaign wallet signer is disabled.
      .addOperation(
        Operation.setOptions({
          lowThreshold: 1,
          medThreshold: 1,
          highThreshold: 1,
        })
      )
      .addOperation(
        Operation.accountMerge({
          destination: getPlatformKeypair().publicKey(),
        })
      )
      .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
      .build();

    const campaignKeypair = Keypair.fromSecret(walletSecret);
    tx.sign(getPlatformKeypair());
    tx.sign(campaignKeypair);
    await server.submitTransaction(tx);
    logger.info('Orphaned campaign wallet closed and merged back to platform', {
      walletPublicKey,
    });
    return true;
  } catch (err) {
    logger.error('Failed to close orphaned campaign wallet', {
      walletPublicKey,
      error: err.message,
    });
    return false;
  }
}

module.exports = {
  calcFee,
  createCampaignWallet,
  toStellarAsset,
  getSupportedAssetCodes,
  listCreditAssetCodes,
  ensureCustodialAccountFundedAndTrusted,
  fundCustodialAccountFromPlatformIfNeeded,
  submitWalletTopUpPayment,
  submitMissingTrustlinesForCustodialAccount,
  buildUnsignedContributionPayment,
  buildUnsignedContributionPathPayment,
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitPayment,
  submitPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  isXdrExpired,
  submitSignedWithdrawal,
  recoverWalletFromSecret,
  getWalletTransactionHistory,
  getWalletPayments,
  revokeAndCloseCampaignWallet,
  closeCampaignWalletBySecret,

  createSubscriptionClaimableBalances,
  claimSubscriptionBalanceToCampaign,
  getClaimableBalance,
  isClaimableBalanceGoneError,
  parseCreatedClaimableBalanceIds,
  buildUnsignedSubscriptionTransaction,
  submitPreparedSubscriptionTransaction,

  accountExistsOnLedger,
  getCampaignBalance,
  friendbotFund,
  getPlatformKeypair,
  getArbitratorKeypair,
  getPlatformPublicKey,
  getArbitratorPublicKey,

  freezeCampaignEscrow,
  releaseEscrowFreeze,
  submitDisputeRefund,
  buildBatchRefundTransaction,
  validateSubmittedWithdrawalXdr,
  validateWithdrawalForPlatformSigning,
  WithdrawalValidationError,
};

// Backward-compat lazy properties (resolved on access, not at require time).
Object.defineProperties(module.exports, {
  PLATFORM_PUBLIC_KEY: { enumerable: true, get: getPlatformPublicKey },
  ARBITRATOR_PUBLIC_KEY: { enumerable: true, get: getArbitratorPublicKey },
});
