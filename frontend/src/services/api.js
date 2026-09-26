import axios from 'axios';

function resolveApiBaseUrl() {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (import.meta.env.VITE_API_BASE_URL) {
    return `${import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '')}/api`;
  }
  return '/api';
}

export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  withCredentials: true,
});

// --- CSRF (double-submit cookie) ---
// The server issues a readable `cp_csrf` cookie (set on the first GET) and the
// csrfProtection middleware requires every state-changing request to echo it in
// the `x-csrf-token` header (middleware/csrf.js). The interceptor does that
// automatically for mutating methods so the SPA stays protected with zero
// per-call boilerplate (#801).
const CSRF_COOKIE_NAME = 'cp_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

apiClient.interceptors.request.use((config) => {
  if (CSRF_MUTATING_METHODS.has(String(config.method || '').toLowerCase())) {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      config.headers[CSRF_HEADER_NAME] = csrfToken;
    }
  }
  return config;
});

// --- Offline retry queue ---
// Idempotent GET requests that fail with a network error while the app is
// offline are queued here and replayed when connectivity returns
// (NetworkStatusContext calls retryQueuedRequests on reconnect).
const retryQueue = [];

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const config = error.config;
    if (!error.response && config && config.method === 'get' && !config._retried) {
      config._retried = true;
      retryQueue.push(() => apiClient.request(config));
    }
    return Promise.reject(normalizeError(error));
  }
);

export function retryQueuedRequests() {
  const queue = [...retryQueue];
  retryQueue.length = 0;
  for (const replay of queue) {
    replay().catch(() => { /* replayed request failed again — drop it */ });
  }
}

function normalizeError(error) {
  if (error?.response?.data?.error) {
    const e = error.response.data.error;
    return { status: error.response.status, message: e.message, code: e.code, fields: e.fields };
  }
  return { status: error?.response?.status || 0, message: error.message || 'Network error' };
}

export const api = {
  async getMe() {
    const res = await apiClient.get('/users/me');
    return res.data;
  },
  async login(email, password) {
    const res = await apiClient.post('/auth/login', { email, password });
    return res.data;
  },
  async login2FA(data) {
    const res = await apiClient.post('/auth/2fa/challenge', data);
    return res.data;
  },
  async register(data) {
    const res = await apiClient.post('/auth/register', data);
    return res.data;
  },
  async logout() {
    const res = await apiClient.post('/auth/logout');
    return res.data;
  },
  async forgotPassword(data) {
    const res = await apiClient.post('/auth/forgot-password', data);
    return res.data;
  },
  async resetPassword(data) {
    const res = await apiClient.post('/auth/reset-password', data);
    return res.data;
  },
  async adminExitImpersonation() {
    const res = await apiClient.post('/admin/impersonate/exit');
    return res.data;
  },
  async adminImpersonateUser(userId) {
    const res = await apiClient.post(`/admin/impersonate/${userId}`);
    return res.data;
  },
  async adminSuspendCampaign(id, data) {
    const res = await apiClient.patch(`/admin/campaigns/${id}/suspend`, data);
    return res.data;
  },
  async getCampaignRequirements(campaignId) {
    const res = await apiClient.get(`/campaigns/${campaignId}/requirements`);
    return res.data;
  },
  async setCampaignRequirements(campaignId, data) {
    const res = await apiClient.post(`/campaigns/${campaignId}/requirements`, data);
    return res.data;
  },
  async approveMilestone(id) {
    const res = await apiClient.post(`/milestones/${id}/approve`);
    return res.data;
  },
  async rejectMilestone(id, data) {
    const res = await apiClient.post(`/milestones/${id}/reject`, data);
    return res.data;
  },
  async voteMilestone(id, data) {
    const res = await apiClient.post(`/milestones/${id}/votes`, data);
    return res.data;
  },
  async submitMilestoneEvidence(id, formData) {
    const res = await apiClient.post(`/milestones/${id}/upload-evidence`, formData);
    return res.data;
  },
  async getPlatformConfig() {
    const res = await apiClient.get('/governance/fee');
    return res.data;
  },
  async getFeaturedCampaigns() {
    const res = await apiClient.get('/campaigns/featured');
    return res.data;
  },
  async getCampaigns(params) {
    const res = await apiClient.get('/campaigns', { params });
    return res.data;
  },
  async getCampaignCategories() {
    const res = await apiClient.get('/campaigns/categories');
    return res.data;
  },
  async getCampaignFacets() {
    const res = await apiClient.get('/campaigns/facets');
    return res.data;
  },
  async getRecommendedCampaigns(params) {
    const res = await apiClient.get('/campaigns/recommended', { params });
    return res.data;
  },
  async getCampaign(id, params) {
    const res = await apiClient.get(`/campaigns/${id}`, { params });
    return res.data;
  },
  async getMilestones(id, params) {
    const res = await apiClient.get(`/campaigns/${id}/milestones`, { params });
    return res.data;
  },
  async getCampaignTranslations(campaignId) {
    const res = await apiClient.get(`/campaigns/${campaignId}/translations`);
    return res.data?.data || res.data || [];
  },
  async getCampaignTranslation(campaignId, locale) {
    const res = await apiClient.get(`/campaigns/${campaignId}/translations/${locale}`);
    return res.data?.data || res.data;
  },
  async saveCampaignTranslation(campaignId, data) {
    const res = await apiClient.post(`/campaigns/${campaignId}/translations`, data);
    return res.data?.data || res.data;
  },
  async deleteCampaignTranslation(campaignId, locale) {
    const res = await apiClient.delete(`/campaigns/${campaignId}/translations/${locale}`);
    return res.data;
  },
  async updateCampaign(campaignId, updates, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await apiClient.patch(`/campaigns/${campaignId}`, updates, { headers });
    return res.data;
  },
  async createCampaign(data) {
    const res = await apiClient.post('/campaigns', data);
    return res.data;
  },
  async getReferralProgram(id) {
    const res = await apiClient.get(`/campaigns/${id}/referrals/program`);
    return res.data;
  },
  async createReferralLink(id) {
    const res = await apiClient.post(`/campaigns/${id}/referrals/links`);
    return res.data;
  },
  async getCreatorCampaignAnalytics(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}`);
    return res.data;
  },
  async exportCreatorCampaignData(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-export.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async exportCampaignReport(campaignId) {
    const res = await apiClient.get(`/campaigns/${campaignId}/report/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-report.pdf';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async getCampaignVelocity(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/velocity`);
    return res.data;
  },
  async updateVelocityThreshold(campaignId, threshold) {
    const res = await apiClient.patch(`/creator/campaigns/${campaignId}/velocity/threshold`, { threshold });
    return res.data;
  },
  async getNotificationPreferences() {
    const res = await apiClient.get('/users/me/notification-preferences');
    return res.data;
  },
  async updateNotificationPreference(data) {
    const res = await apiClient.patch('/users/me/notification-preferences', data);
    return res.data;
  },
  async unsubscribeEmail(data) {
    const res = await apiClient.get('/emails/unsubscribe', { params: data });
    return res.data;
  },
  async getChannelSettings() {
    const res = await apiClient.get('/users/me/channel-settings');
    return res.data;
  },
  async updateChannelSettings(data) {
    const res = await apiClient.patch('/users/me/channel-settings', data);
    return res.data;
  },
  async getPushSubscriptionStatus() {
    const res = await apiClient.get('/users/me/push-subscription');
    return res.data;
  },
  async registerPushSubscription(token) {
    const res = await apiClient.post('/users/me/push-subscription', { token });
    return res.data;
  },
  async removePushSubscription(token) {
    const res = await apiClient.delete('/users/me/push-subscription', { data: { token } });
    return res.data;
  },
  async getMyCampaigns(params) {
    const res = await apiClient.get('/users/me/campaigns', { params });
    return res.data;
  },

  async getAdminAuditLogs(params) {
    const res = await apiClient.get('/admin/audit-logs', { params });
    return res.data;
  },

  async exportAdminAuditLogsCsv(params) {
    const res = await apiClient.get('/admin/audit-logs/export.csv', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },

  async exportAdminAuditLogsJson(params) {
    const res = await apiClient.get('/admin/audit-logs/export.json', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.json';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async getNotifications() {
    const res = await apiClient.get('/users/me/notifications');
    return res.data;
  },
  async markNotificationRead(id) {
    const res = await apiClient.patch(`/users/me/notifications/${id}/read`);
    return res.data;
  },
  async markAllNotificationsRead() {
    const res = await apiClient.patch('/users/me/notifications/read-all');
    return res.data;
  },
  async getMyBadges() {
    const res = await apiClient.get('/users/me/badges');
    return res.data;
  },
  async updateMyProfile(data) {
    const res = await apiClient.patch('/users/me', data);
    return res.data;
  },
  async getMyNftRewards() {
    const res = await apiClient.get('/users/me/nft-rewards');
    return res.data;
  },
  async setup2FA() {
    const res = await apiClient.post('/users/me/2fa/setup');
    return res.data;
  },
  async verify2FA({ code }) {
    const res = await apiClient.post('/users/me/2fa/verify', { code });
    return res.data;
  },
  async listCampaignPools(campaignId) {
    const res = await apiClient.get(`/campaign-pools/campaign/${campaignId}`);
    return res.data;
  },
  async createPool({ campaign_id, title, description, target_amount, expires_at }) {
    const res = await apiClient.post('/campaign-pools', {
      campaign_id,
      title,
      description,
      target_amount,
      expires_at,
    });
    return res.data;
  },
  async joinPool(poolId, shareAmount, displayName) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/join`, {
      share_amount: shareAmount,
      display_name: displayName,
    });
    return res.data;
  },
  async leavePool(poolId) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/leave`);
    return res.data;
  },
  async submitPool(poolId) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/submit`);
    return res.data;
  },

  // --- Contributions (#688: preview-backed cross-asset flow) ---
  async previewContribution(campaignId, { send_asset, amount }) {
    const res = await apiClient.post(`/campaigns/${campaignId}/contribution/preview`, {
      send_asset,
      amount,
    });
    return res.data;
  },
  async quoteContribution(campaignId, { send_asset, dest_amount }) {
    const res = await apiClient.post(`/campaigns/${campaignId}/contribution/preview`, {
      send_asset,
      amount: dest_amount,
    });
    return res.data;
  },
  async contribute(payload, referralQuery) {
    const config = referralQuery?.query ? { params: referralQuery.query } : undefined;
    const res = await apiClient.post('/contributions', payload, config);
    return res.data;
  },
  async prepareContribution(payload, referralQuery) {
    const config = referralQuery?.query ? { params: referralQuery.query } : undefined;
    const res = await apiClient.post('/contributions/prepare', payload, config);
    return res.data;
  },
  async submitSignedContribution(payload) {
    const res = await apiClient.post('/contributions/submit-signed', payload);
    return res.data;
  },
  async getContributionDiagnosis(contributionId) {
    const res = await apiClient.get(`/contributions/${contributionId}/diagnosis`);
    return res.data;
  },
  async getAnchorInfo() {
    const res = await apiClient.get('/anchor/info');
    return res.data;
  },
  async startAnchorDeposit(payload) {
    const res = await apiClient.post('/anchor/deposits/start', payload);
    return res.data;
  },
  async getAnchorDepositStatus(depositId) {
    const res = await apiClient.get(`/anchor/deposits/${depositId}`);
    return res.data;
  },
  async getContributionFinalization(txHash) {
    const res = await apiClient.get(`/contributions/finalization/${txHash}`);
    return res.data;
  },

  // --- Subscriptions (Freighter support #821) ---
  async prepareSubscription(campaignId, { amountPerPeriod, asset, periodMonths, totalPeriods }) {
    const res = await apiClient.post(`/campaigns/${campaignId}/subscriptions/prepare`, {
      amountPerPeriod, asset, periodMonths, totalPeriods,
    });
    return res.data;
  },
  async submitSubscription(campaignId, { unsignedXdr, signedXdr, amountPerPeriod, asset, periodMonths, totalPeriods }) {
    const res = await apiClient.post(`/campaigns/${campaignId}/subscriptions/submit`, {
      unsignedXdr, signedXdr, amountPerPeriod, asset, periodMonths, totalPeriods,
    });
    return res.data;
  },

  // --- Credential activity (#833) ---
  async getCredentialActivity() {
    const res = await apiClient.get('/users/me/credentials/activity');
    return res.data.activity;
  },

  // --- API key rotation (#823) ---
  async rotateApiKey(id, { label, scopes, expires_at }) {
    const res = await apiClient.post(`/users/api-keys/${id}/rotate`, { label, scopes, expires_at });
    return res.data;
  },

  // --- Governance (#801: mutating calls moved onto the shared client so the
  // CSRF header is attached and session cookies are used instead of a
  // localStorage token that no longer exists) ---
  async getGovernanceFee() {
    const res = await apiClient.get('/governance/fee');
    return res.data;
  },
  async getGovernanceProposals() {
    const res = await apiClient.get('/governance/proposals');
    return res.data;
  },
  async getGovernanceUserTokenBalance() {
    const res = await apiClient.get('/governance/user/token-balance');
    return res.data;
  },
  async getGovernanceProposal(id) {
    const res = await apiClient.get(`/governance/proposals/${id}`);
    return res.data;
  },
  async createGovernanceProposal(data) {
    const res = await apiClient.post('/governance/proposals', data);
    return res.data;
  },
  async voteGovernanceProposal(proposalId, inFavor) {
    const res = await apiClient.post(`/governance/proposals/${proposalId}/vote`, { in_favor: inFavor });
    return res.data;
  },
  async executeGovernanceProposal(proposalId) {
    const res = await apiClient.post(`/governance/proposals/${proposalId}/execute`);
    return res.data;
  },
  async submitSignedGovernance(url, prepareToken, signedXdr) {
    const res = await apiClient.post(url, { prepare_token: prepareToken, signed_xdr: signedXdr });
    return res.data;
  },

  // Governance sync run history — operators only (#839).
  getGovernanceSyncRuns: (params = {}) =>
    apiClient.get('/governance/sync/runs', { params }).then((r) => r.data),

  getGovernanceSyncRun: (runId) =>
    apiClient.get(`/governance/sync/runs/${runId}`).then((r) => r.data),

  triggerGovernanceSync: () =>
    apiClient.post('/governance/sync').then((r) => r.data),

  retryGovernanceSyncRun: (runId) =>
    apiClient.post(`/governance/sync/runs/${runId}/retry`).then((r) => r.data),

  getEligibleRefunds: (campaignId) =>
    apiClient.get(`/campaigns/${campaignId}/refunds/eligible`).then((r) => r.data),

  getCampaignRefunds: (campaignId, params = {}) =>
    apiClient.get(`/campaigns/${campaignId}/refunds`, { params }).then((r) => r.data),

  processRefund: (campaignId, payload) =>
    apiClient.post(`/campaigns/${campaignId}/refunds`, payload).then((r) => r.data),
};

