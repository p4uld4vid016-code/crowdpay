import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import * as Sentry from '@sentry/react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import ContributeModal from '../components/ContributeModal';
import RefundsSection from '../components/RefundsSection';

const SUPPORTED_LOCALES = [
  { code: 'fr', label: 'French (Français)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'de', label: 'German (Deutsch)' },
];

/**
 * CampaignRequirementsNotice — shown to non-logged-in visitors when the
 * campaign has KYC or reputation requirements set.
 */
function CampaignRequirementsNotice({ campaignId }) {
  const [req, setReq] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getCampaignRequirements(campaignId)
      .then((data) => { if (!cancelled) setReq(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [campaignId]);

  if (!req) return null;
  const attestations = req.required_attestations || [];
  const hasRequirements = req.min_reputation_score > 0 || attestations.length > 0;
  if (!hasRequirements) return null;

  const lines = [];
  if (attestations.length) {
    const label = attestations[attestations.length - 1].replace('kyc_', 'KYC ');
    lines.push(`This campaign requires ${label.charAt(0).toUpperCase() + label.slice(1)} verification`);
  }
  if (req.min_reputation_score > 0) {
    lines.push(`Minimum reputation score: ${req.min_reputation_score}`);
  }

  return (
    <div
      style={{
        padding: '0.5rem 0.75rem',
        borderRadius: '0.4rem',
        background: '#fffbeb',
        border: '1px solid #fde68a',
        fontSize: '0.8rem',
        color: '#92400e',
      }}
    >
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

/**
 * Shows a green "You're eligible" or red "Requirements not met" badge.
 * Fetches campaign requirements + contributor profile in parallel.
 */
function ContributorEligibilityBadge({ user, campaignId }) {
  const [status, setStatus] = useState(null); // null | 'loading' | 'eligible' | 'ineligible' | 'no-requirements'
  const [missing, setMissing] = useState([]);
  const [requirements, setRequirements] = useState(null);

  useEffect(() => {
    if (!user?.wallet_public_key || !campaignId) return;
    let cancelled = false;
    setStatus('loading');

    Promise.all([
      api.getCampaignRequirements(campaignId),
      api.getContributorIdentityProfile(user.wallet_public_key),
    ])
      .then(([req, profile]) => {
        if (cancelled) return;
        setRequirements(req);

        const noReq =
          (!req.min_reputation_score || req.min_reputation_score === 0) &&
          (!req.required_attestations || req.required_attestations.length === 0);

        if (noReq) {
          setStatus('no-requirements');
          return;
        }

        const gaps = [];

        if (req.min_reputation_score > 0 && profile.reputationScore < req.min_reputation_score) {
          gaps.push(
            `Reputation score ${profile.reputationScore} / ${req.min_reputation_score} required`
          );
        }

        for (const attType of req.required_attestations || []) {
          const hasAtt = profile.attestations.some(
            (a) => a.type === attType && !a.revoked && (!a.expiresAt || new Date(a.expiresAt) > new Date())
          );
          if (!hasAtt) {
            const label = attType.replace('kyc_', 'KYC ');
            gaps.push(`Missing ${label.charAt(0).toUpperCase() + label.slice(1)} verification`);
          }
        }

        setMissing(gaps);
        setStatus(gaps.length ? 'ineligible' : 'eligible');
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });

    return () => { cancelled = true; };
  }, [user?.wallet_public_key, campaignId]);

  if (!status || status === 'loading' || status === 'no-requirements') return null;

  if (status === 'eligible') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.45rem 0.75rem',
          borderRadius: '0.4rem',
          background: '#f0fff4',
          border: '1px solid #9ae6b4',
          fontSize: '0.82rem',
          color: '#276749',
          marginBottom: '0.5rem',
        }}
        role="status"
        aria-label="You are eligible to contribute"
      >
        <span aria-hidden="true">✅</span>
        <span>You&apos;re eligible to contribute</span>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '0.55rem 0.75rem',
        borderRadius: '0.4rem',
        background: '#fff5f5',
        border: '1px solid #fed7d7',
        fontSize: '0.82rem',
        color: '#c53030',
        marginBottom: '0.5rem',
      }}
      role="alert"
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        <span aria-hidden="true">🔒</span> Requirements not met
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {missing.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
import RecurringPledgeForm from '../components/RecurringPledgeForm';
import ReferralProgramSettings from '../components/ReferralProgramSettings';
import CampaignReferralsTab from '../components/CampaignReferralsTab';
import TreasuryPanel, { TreasuryTransparencyPanel } from '../components/TreasuryPanel';
import RelativeTime from '../components/RelativeTime';
import DisputeModal from '../components/DisputeModal';
import EvidenceForm from '../components/EvidenceForm';
import TransactionHistory from '../components/TransactionHistory';
import WithdrawalHistoryTimeline from '../components/WithdrawalHistoryTimeline';
import MilestoneTracker from '../components/MilestoneTracker';
import MilestoneVotePanel from '../components/MilestoneVotePanel';
import WithdrawalsSection from '../components/WithdrawalsSection';
import CampaignDetailSkeleton from '../components/skeletons/CampaignDetailSkeleton';
import ContributionListSkeleton from '../components/skeletons/ContributionListSkeleton';
import VerificationBadge from '../components/VerificationBadge';
import CampaignStatusBadge from '../components/CampaignStatusBadge';
import { stellarExpertTxUrl } from '../config/stellar';
import CampaignQRCode from '../components/CampaignQRCode';
import { getNetwork, signTransaction } from '@stellar/freighter-api';
import { isConnected, getPublicKey } from '@stellar/freighter-api';
const BackerInsightsCard = React.lazy(() => import('../components/BackerInsightsCard'));
import CampaignComments from '../components/CampaignComments';
import FollowCampaignButton from '../components/FollowCampaignButton';
import PoolManager from '../components/PoolManager';
import LanguageToggle from '../components/LanguageToggle';
import { addRecentlyViewed } from '../lib/recentlyViewed';


function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown || '');
  return escaped
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(
      /\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/\n/g, '<br />');
}

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return 'var(--color-teal)';
  if (status === 'closed' || status === 'withdrawn' || status === 'refunded' || status === 'failed')
    return 'var(--color-text-hint)';
  if (pct >= 75) return 'var(--color-accent-light)';
  return 'var(--color-accent)';
}

function FavoriteToggle({ campaignId }) {
  const [favorited, setFavorited] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      if (favorited) {
        await api.removeFavorite(campaignId);
        setFavorited(false);
      } else {
        await api.addFavorite(campaignId);
        setFavorited(true);
      }
    } catch {
      // no-op — leave state unchanged on failure
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      style={{
        background: 'none',
        border: '1px solid var(--color-border-lighter)',
        borderRadius: '999px',
        fontSize: '0.85rem',
        padding: '0.2rem 0.6rem',
        cursor: 'pointer',
        color: favorited ? 'var(--color-accent)' : 'var(--color-text-hint)',
      }}
    >
      {favorited ? '★ Favorited' : '☆ Favorite'}
    </button>
  );
}

const UPDATE_BODY_MAX = 5000;
const UPDATE_BODY_WARN_THRESHOLD = Math.round(UPDATE_BODY_MAX * 0.9);

function CampaignPublishControls({ campaign, isOwner, navigate }) {
  const [cloning, setCloning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [error, setError] = useState('');

  if (!isOwner) return null;

  async function clone() {
    setCloning(true);
    setError('');
    try {
      const newCampaign = await api.cloneCampaign(campaign.id);
      navigate(`/campaigns/${newCampaign.id}`);
    } catch (err) {
      setError(err.message || 'Could not clone campaign');
      setCloning(false);
    }
  }

  async function publishNow() {
    setPublishing(true);
    setError('');
    try {
      await api.publishCampaign(campaign.id);
      window.location.reload();
    } catch (err) {
      setError(err.message || 'Could not publish campaign');
      setPublishing(false);
    }
  }

  async function schedulePublish(e) {
    e.preventDefault();
    setScheduling(true);
    setError('');
    try {
      await api.scheduleCampaignPublish(campaign.id, { scheduled_publish_at: scheduledAt || null });
      window.location.reload();
    } catch (err) {
      setError(err.message || 'Could not schedule publishing');
      setScheduling(false);
    }
  }

  return (
    <div data-no-print style={{ marginBottom: '1.25rem' }}>
      {campaign.status === 'draft' && (
        <div
          className="campaign-card"
          style={{
            minHeight: 'auto',
            padding: '0.85rem',
            marginBottom: '0.75rem',
            display: 'grid',
            gap: '0.6rem',
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>This campaign is a draft</strong>
          <p style={{ fontSize: '0.82rem', color: 'var(--color-text-hint)', margin: 0 }}>
            No wallet or on-chain contracts exist yet. Publish now, or schedule an automatic
            publish time.
          </p>
          {campaign.scheduled_publish_at && (
            <p style={{ fontSize: '0.82rem', margin: 0 }}>
              Scheduled to auto-publish at {new Date(campaign.scheduled_publish_at).toLocaleString()}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" onClick={publishNow} disabled={publishing}>
              {publishing ? 'Publishing…' : 'Publish now'}
            </button>
          </div>
          <form onSubmit={schedulePublish} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              style={{ fontSize: '0.85rem' }}
            />
            <button type="submit" className="btn-secondary" disabled={scheduling} style={{ fontSize: '0.85rem' }}>
              {scheduling ? 'Saving…' : 'Schedule publish'}
            </button>
          </form>
          {error && (
            <p className="alert alert--error" style={{ fontSize: '0.8rem', margin: 0 }}>
              {error}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn-secondary"
        style={{ fontSize: '0.85rem' }}
        onClick={clone}
        disabled={cloning}
      >
        {cloning ? 'Cloning…' : 'Clone campaign'}
      </button>
      {campaign.status !== 'draft' && error && (
        <p className="alert alert--error" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function ContributionRow({ c }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(c.sender_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.row}>
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <div style={styles.avatar}>{(c.display_name || 'A')[0].toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <div style={styles.sender}>{c.display_name || 'Anonymous'}</div>
          <div style={styles.convHint}>
            <button
              type="button"
              onClick={handleCopy}
              title="Copy full public key"
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                fontFamily: 'monospace',
                fontSize: 'inherit',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {c.sender_public_key.slice(0, 4)}…{c.sender_public_key.slice(-4)}
            </button>
            {' • '}
            <RelativeTime date={c.created_at} />
          </div>
          {c.refund_status && (
            <div style={styles.refundTag}>
              {c.refund_status === 'pending' && 'Refund pending'}
              {c.refund_status === 'submitted' && 'Refunded'}
              {c.refund_status === 'indexed' && 'Refunded'}
              {c.refund_status === 'failed' && 'Refund failed'}
              {c.refund_status === 'denied' && 'Refund denied'}
            </div>
          )}
          {c.tx_hash && (
            <a
              href={stellarExpertTxUrl(c.tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.75rem', color: 'var(--color-accent)', fontWeight: 600 }}
            >
              View on chain ↗
            </a>
          )}
        </div>
      </div>
      {c.amount !== null && (
        <span style={styles.amount}>
          {Number(c.amount).toLocaleString()} {c.asset}
        </span>
      )}
    </div>
  );
}

export default function Campaign() {
  const contributeBtnRef = useRef(null);
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const toast = useToast();
  const { i18n } = useTranslation();
  const currentLocale = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];

  const [campaign, setCampaign] = useState(null);
  const [translation, setTranslation] = useState(null);
  const [translations, setTranslations] = useState([]);
  const [translationsLoading, setTranslationsLoading] = useState(false);
  const [translationForm, setTranslationForm] = useState(null);
  const [translationError, setTranslationError] = useState('');
  const [translationSuccess, setTranslationSuccess] = useState('');
  const [translationSaving, setTranslationSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [contributions, setContributions] = useState(null);
  const [totalContributions, setTotalContributions] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);
  const [activeDispute, setActiveDispute] = useState(null);
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);
  const [evidenceSubmitted, setEvidenceSubmitted] = useState(false);
  const [contributed, setContributed] = useState(false);

  const [freighterGuestMode, setFreighterGuestMode] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(!!location.state?.created);
  const [coverUploadError, setCoverUploadError] = useState(location.state?.coverUploadError || '');
  const [updates, setUpdates] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [stretchGoals, setStretchGoals] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: '', body: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [members, setMembers] = useState([]);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'viewer' });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showEmbedSection, setShowEmbedSection] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [badgeCopied, setBadgeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [isEditingCampaign, setIsEditingCampaign] = useState(false);
  const [editFormData, setEditFormData] = useState({
    title: '',
    description: '',
    deadline: '',
  });
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('contributions');
  const [editingUpdateId, setEditingUpdateId] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsTab, setAnalyticsTab] = useState('overview');
  const [backersAnalytics, setBackersAnalytics] = useState(null);
  const [analyticsBackersLoading, setAnalyticsBackersLoading] = useState(false);

  const [refundBusy, setRefundBusy] = useState(false);

  const [refundError, setRefundError] = useState('');
  const [refundSuccess, setRefundSuccess] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [hasPendingWithdrawal, setHasPendingWithdrawal] = useState(false);
  const [referralCode, setReferralCode] = useState(null);
  const [referralUrl, setReferralUrl] = useState(null);
  const [referralLeaderboard, setReferralLeaderboard] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [nftRewards, setNftRewards] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [milestonesLoading, setMilestonesLoading] = useState(false);
  const [contractStatus, setContractStatus] = useState(null);
  const [contractStatusError, setContractStatusError] = useState(null);
  const [contractAddress, setContractAddress] = useState(null);
  const [embedCode, setEmbedCode] = useState('');
  const [contributorRefundBusy, setContributorRefundBusy] = useState(false);
  const [contributorRefundError, setContributorRefundError] = useState('');
  const [contributorRefundSuccess, setContributorRefundSuccess] = useState('');
  const editModalRef = useRef(null);
  const deleteModalRef = useRef(null);

  const refParam = new URLSearchParams(location.search).get('ref');
  const presetAmount = new URLSearchParams(location.search).get('amount') || '';

  const currentUserId = user?.id || user?.userId;
  const userRole =
    campaign?.user_role ||
    (currentUserId && campaign && String(campaign.creator_id) === String(currentUserId)
      ? 'owner'
      : null);
  const isOwner = userRole === 'owner';

  useEffect(() => {
    if (!user || !id) return;
    api
      .getReferralCode(id)
      .then((data) => {
        setReferralCode(data.referral_code);
        setReferralUrl(data.referral_url);
      })
      .catch(() => { });
  }, [user, id]);

  useEffect(() => {
    if (!isEditingCampaign) return;
    const onKey = (e) => { if (e.key === 'Escape') handleCloseEditModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEditingCampaign, handleCloseEditModal]);

  useEffect(() => {
    if (!isEditingCampaign) return;
    const modal = editModalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }
    modal.addEventListener('keydown', trapTab);
    return () => modal.removeEventListener('keydown', trapTab);
  }, [isEditingCampaign]);

  useEffect(() => {
    if (!showDeleteDialog) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowDeleteDialog(false);
        setDeleteConfirmation('');
        setDeleteError('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showDeleteDialog]);

  useEffect(() => {
    if (!showDeleteDialog) return;
    const modal = deleteModalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }
    modal.addEventListener('keydown', trapTab);
    return () => modal.removeEventListener('keydown', trapTab);
  }, [showDeleteDialog]);

  useEffect(() => {
    if (!isOwner || !id) return;
    api
      .getReferralLeaderboard(id)
      .then(setReferralLeaderboard)
      .catch(() => { });
  }, [isOwner, id]);

  useEffect(() => {
    document.body.dataset.printUrl = window.location.href;
    document.body.dataset.printDate = new Date().toLocaleDateString();
    return () => {
      delete document.body.dataset.printUrl;
      delete document.body.dataset.printDate;
    };
  }, []);

  useEffect(() => {
    if (!campaign) return;
    const baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
    const ogImageUrl = campaign.og_image_url || `${baseUrl}/api/campaigns/${campaign.id}/og-image.png`;
    const setMeta = (property, content) => {
      let el = document.querySelector(`meta[property="${property}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute('property', property);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    setMeta('og:title', campaign.title);
    setMeta('og:description', (campaign.description || '').slice(0, 160));
    setMeta('og:image', ogImageUrl);
    setMeta('og:url', campaign.share_url || window.location.href);
    setMeta('og:type', 'website');
    return () => {
      ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'].forEach((p) => {
        document.querySelector(`meta[property="${p}"]`)?.remove();
      });
    };
  }, [campaign]);

  useEffect(() => {
    setLoadError('');
    const campaignOpts = {
      locale: currentLocale,
      ...(refParam ? { ref: refParam } : {}),
    };
    api
      .getCampaign(id, campaignOpts)
      .then((data) => {
        setCampaign(data);
        addRecentlyViewed(data.id);
        const role = data.user_role;
        if (role === 'owner' || role === 'manager') {
          setActiveTab('team');
          api
            .getCampaignMembers(id)
            .then(setMembers)
            .catch(() => setMembers([]));
        } else {
          setMembers([]);
        }
        if (role === 'owner' || role === 'manager' || role === 'viewer') {
          api
            .getCampaignAnalytics(id)
            .then(setAnalytics)
            .catch(() => setAnalytics(null))
            .finally(() => setAnalyticsLoading(false));
        } else {
          setAnalytics(null);
          setAnalyticsLoading(false);
        }

        // Reset analytics sub-tab per load
        setAnalyticsTab('overview');
        setBackersAnalytics(null);
        setAnalyticsBackersLoading(false);
      })
      .catch((err) => setLoadError(err.message || 'Could not load campaign.'));

    api
      .getContributions(id, { limit: showAll ? 100 : 10, offset: 0 })
      .then((data) => {
        setContributions(data.contributions || []);
        setTotalContributions(data.total || 0);
      })
      .catch(() => {
        setContributions([]);
        setTotalContributions(0);
      });
    setMilestonesLoading(true);
    api
      .getMilestones(id, { locale: currentLocale })
      .then(setMilestones)
      .catch(() => setMilestones([]))
      .finally(() => setMilestonesLoading(false));
    api.getStretchGoals(id).then(setStretchGoals).catch(() => setStretchGoals([]));
    api
      .getContractStatus(id)
      .then((data) => {
        setContractStatus(data);
        setContractStatusError('');
      })
      .catch((err) => {
        setContractStatus(null);
        setContractStatusError(err.message || 'Could not load on-chain status.');
      });
    api
      .getCampaignTiers(id)
      .then((data) => setTiers(Array.isArray(data) ? data : []))
      .catch(() => setTiers([]));
    api
      .getCampaignNftRewards(id)
      .then((data) => setNftRewards(Array.isArray(data?.rewards) ? data.rewards : []))
      .catch(() => setNftRewards([]));
    api
      .getCampaignUpdates(id, { limit: 20 })
      .then(setUpdates)
      .catch(() => setUpdates([]));

    // Check for pending withdrawals
    if (token) {
      api
        .listWithdrawals(id)
        .then((withdrawals) => {
          const hasPending = withdrawals.some((w) => w.status === 'pending');
          setHasPendingWithdrawal(hasPending);
        })
        .catch(() => setHasPendingWithdrawal(false));
    }
  }, [id, token, contributed, showAll, currentLocale]);

  useEffect(() => {
    if (!id || !user || campaign?.status !== 'disputed') {
      setActiveDispute(null);
      return;
    }
    api
      .getCampaignDispute(id)
      .then((data) => setActiveDispute(data.dispute))
      .catch(() => setActiveDispute(null));
  }, [id, user, campaign?.status]);

  useEffect(() => {
    if (!campaign || !id || !user) return;
    const currentUserId = user.id || user.userId;
    const resolvedRole =
      campaign.user_role ||
      (currentUserId && String(campaign.creator_id) === String(currentUserId) ? 'owner' : null);
    if (resolvedRole !== 'owner') return;
    api
      .getReferralLeaderboard(id)
      .then(setReferralLeaderboard)
      .catch(() => { });
  }, [campaign, id, user]);

  useEffect(() => {
    if (!id) return;
    if (isLive) return;
    if (!campaign) return;

    const isCampaignClosed = [
      'funded',
      'closed',
      'withdrawn',
      'failed',
      'completed',
      'refunded',
    ].includes(campaign.status);
    if (isCampaignClosed) return;

    let intervalId = null;
    let aborted = false;

    const refresh = async () => {
      if (aborted) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const [nextCampaign, nextContributionsData] = await Promise.all([
          api.getCampaign(id),
          api.getContributions(id, { limit: showAll ? 100 : 10, offset: 0 }),
        ]);
        if (aborted) return;
        setCampaign(nextCampaign);
        setContributions(nextContributionsData.contributions || []);
        setTotalContributions(nextContributionsData.total || 0);
      } catch {
        // ignore transient polling errors
      }
    };

    const start = () => {
      if (intervalId !== null) return;
      refresh();
      intervalId = window.setInterval(refresh, 15_000);
    };

    const stop = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    return () => {
      aborted = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id, token, isLive, campaign, showAll]);

  useEffect(() => {
    if (!window.EventSource) return;

    let es = null;
    let retryDelay = 1000;
    let retryTimeout = null;
    let isUnmounted = false;

    function connect() {
      if (isUnmounted) return;

      es = new EventSource(`/api/campaigns/${id}/stream`);

      es.onopen = () => {
        setIsLive(true);
        retryDelay = 1000;
      };

      es.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === 'contribution') {
          setCampaign((prev) => (prev ? { ...prev, raised_amount: msg.raised_amount } : prev));
          setContributions((prev) => {
            const current = prev || [];
            const exists = current.some((c) => c.tx_hash === msg.contribution.tx_hash);
            if (exists) return current;

            setTotalContributions((t) => t + 1);

            const updated = [msg.contribution, ...current];
            if (!showAll && updated.length > 10) {
              return updated.slice(0, 10);
            }
            return updated;
          });
        }
      };

      es.onerror = () => {
        setIsLive(false);
        es.close();

        if (!isUnmounted) {
          retryTimeout = setTimeout(() => {
            connect();
            retryDelay = Math.min(retryDelay * 2, 30000);
          }, retryDelay);
        }
      };
    }

    connect();

    return () => {
      isUnmounted = true;
      if (es) es.close();
      if (retryTimeout) clearTimeout(retryTimeout);
      setIsLive(false);
    };
  }, [id, showAll]);

  useEffect(() => {
    if (location.state?.created) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  async function handleClone() {
    try {
      const data = await api.getCloneData(id);
      navigate('/campaigns/new', { state: { prefill: data } });
    } catch (err) {
      window.alert(err.message || 'Failed to fetch campaign clone data');
    }
  }

  async function handleInviteSubmit(e) {
    e.preventDefault();
    if (!inviteForm.email) {
      setInviteError('Email is required');
      return;
    }
    setInviteBusy(true);
    setInviteError('');
    setInviteSuccess(false);
    try {
      const newMember = await api.inviteCampaignMember(id, inviteForm);
      setMembers((prev) => [...prev, newMember]);
      setInviteForm({ email: '', role: 'viewer' });
      setInviteSuccess(true);
    } catch (err) {
      setInviteError(err.message || 'Failed to invite member');
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      const updated = await api.updateCampaignMemberRole(id, userId, { role: newRole });
      setMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role: updated.role } : m))
      );
    } catch (err) {
      window.alert(err.message || 'Failed to update role');
    }
  }

  async function handleRemoveMember(userId) {
    if (!window.confirm('Are you sure you want to remove this member?')) return;
    try {
      await api.removeCampaignMember(id, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      window.alert(err.message || 'Failed to remove member');
    }
  }

  async function handleResendInvite(memberId) {
    try {
      const updated = await api.resendCampaignInvite(id, memberId);
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, ...updated } : m)));
    } catch (err) {
      window.alert(err.message || 'Failed to resend invitation');
    }
  }

  async function handleCancelInvite(memberId) {
    if (!window.confirm('Cancel this pending invitation?')) return;
    try {
      await api.cancelCampaignInvite(id, memberId);
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch (err) {
      window.alert(err.message || 'Failed to cancel invitation');
    }
  }

  function handleOpenEditModal() {
    if (!campaign) return;
    setEditFormData({
      title: campaign.title || '',
      description: campaign.description || '',
      deadline: campaign.deadline ? campaign.deadline.split('T')[0] : '',
    });
    setEditError('');
    setEditSuccess('');
    setTranslationForm(null);
    setTranslationError('');
    setTranslationSuccess('');
    setIsEditingCampaign(true);
    setTranslationsLoading(true);
    api
      .getCampaignTranslations(campaign.id)
      .then((data) => setTranslations(Array.isArray(data) ? data : []))
      .catch(() => setTranslations([]))
      .finally(() => setTranslationsLoading(false));
  }

  function handleCloseEditModal() {
    setIsEditingCampaign(false);
    setEditFormData({ title: '', description: '', deadline: '' });
    setEditError('');
    setEditSuccess('');
    setTranslationForm(null);
    setTranslationError('');
    setTranslationSuccess('');
  }

  function handleStartAddTranslation(locale) {
    const existing = translations.find((t) => t.locale === locale || t.language === locale);
    setTranslationError('');
    setTranslationSuccess('');
    if (existing) {
      let mt = existing.milestone_titles || [];
      if (typeof mt === 'string') {
        try { mt = JSON.parse(mt); } catch { mt = []; }
      }
      setTranslationForm({
        locale,
        title: existing.title || '',
        description: existing.description || '',
        milestone_titles: Array.isArray(mt) ? [...mt] : [],
      });
    } else {
      setTranslationForm({
        locale,
        title: '',
        description: '',
        milestone_titles: (milestones || []).map(() => ''),
      });
    }
  }

  async function handleSaveTranslation() {
    if (!translationForm) return;
    if (!translationForm.title.trim()) {
      setTranslationError('Title is required for translation');
      return;
    }
    setTranslationSaving(true);
    setTranslationError('');
    try {
      const saved = await api.saveCampaignTranslation(campaign.id, {
        locale: translationForm.locale,
        title: translationForm.title.trim(),
        description: translationForm.description.trim() || null,
        milestone_titles: translationForm.milestone_titles || [],
      });
      setTranslations((prev) => {
        const filtered = prev.filter((t) => t.locale !== translationForm.locale && t.language !== translationForm.locale);
        return [...filtered, saved];
      });
      setTranslationSuccess(`Translation for ${translationForm.locale.toUpperCase()} saved!`);
      setTranslationForm(null);
      if (currentLocale === translationForm.locale) {
        api.getCampaign(id, { locale: currentLocale }).then(setCampaign).catch(() => {});
        api.getMilestones(id, { locale: currentLocale }).then(setMilestones).catch(() => {});
      }
      setTimeout(() => setTranslationSuccess(''), 3000);
    } catch (err) {
      setTranslationError(err.message || 'Failed to save translation');
    } finally {
      setTranslationSaving(false);
    }
  }

  async function handleDeleteTranslation(locale) {
    if (!window.confirm(`Are you sure you want to delete the ${locale.toUpperCase()} translation?`)) return;
    try {
      await api.deleteCampaignTranslation(campaign.id, locale);
      setTranslations((prev) => prev.filter((t) => t.locale !== locale && t.language !== locale));
      if (currentLocale === locale) {
        api.getCampaign(id, { locale: currentLocale }).then(setCampaign).catch(() => {});
        api.getMilestones(id, { locale: currentLocale }).then(setMilestones).catch(() => {});
      }
    } catch (err) {
      setTranslationError(err.message || 'Failed to delete translation');
    }
  }

  async function handleSaveEdit() {
    setEditError('');

    // Validate form
    if (!editFormData.title.trim()) {
      setEditError('Title is required');
      return;
    }
    if (editFormData.title.length > 100) {
      setEditError('Title must be at most 100 characters');
      return;
    }
    if (editFormData.description.length > 1000) {
      setEditError('Description must be at most 1000 characters');
      return;
    }
    if (editFormData.deadline) {
      const deadlineDate = new Date(editFormData.deadline);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      deadlineDate.setHours(0, 0, 0, 0);
      if (deadlineDate < today) {
        setEditError('Deadline cannot be in the past');
        return;
      }
    }

    try {
      setEditLoading(true);
      const updates = {};
      if (editFormData.title !== campaign.title) updates.title = editFormData.title;
      if (editFormData.description !== campaign.description)
        updates.description = editFormData.description;
      if (editFormData.deadline !== (campaign.deadline ? campaign.deadline.split('T')[0] : '')) {
        updates.deadline = editFormData.deadline || null;
      }

      if (Object.keys(updates).length === 0) {
        setEditError('No changes to save');
        setEditLoading(false);
        return;
      }

      const updated = await api.updateCampaign(campaign.id, updates, token);
      setCampaign(updated);
      setIsEditingCampaign(false);
      setEditFormData({ title: '', description: '', deadline: '' });
      setEditSuccess('Campaign updated successfully!');
      setTimeout(() => setEditSuccess(''), 3000);
    } catch (err) {
      setEditError(err.message || 'Failed to update campaign');
    } finally {
      setEditLoading(false);
    }
  }

  async function handleInitiateRefund() {
    setRefundBusy(true);
    setRefundError('');
    setRefundSuccess('');
    try {
      const initRes = await api.initiateRefund(campaign.id);
      const unsignedXdr = initRes.unsigned_xdr;

      let signedXdr = unsignedXdr;
      if (user?.wallet_type === 'freighter') {
        const network = await getNetwork();
        if (network?.error) throw new Error('Could not read Freighter network');

        const signed = await signTransaction(unsignedXdr, {
          networkPassphrase: network?.networkPassphrase,
          address: user?.wallet_public_key,
        });
        if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
        if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

        const approveRes = await api.approveRefundCreator(campaign.id, {
          signed_xdr: signed.signedTxXdr,
        });
        signedXdr = approveRes.signed_xdr;
      } else {
        const approveRes = await api.approveRefundCreator(campaign.id, {});
        signedXdr = approveRes.signed_xdr;
      }

      let isPlatformApprover = false;
      try {
        const capRes = await api.getWithdrawalCapabilities();
        if (capRes.can_approve_platform) {
          isPlatformApprover = true;
        }
      } catch (err) {
        // ignore
      }

      if (isPlatformApprover) {
        await api.approveRefundPlatform(campaign.id);
        setRefundSuccess('Campaign contributions successfully refunded!');
      } else {
        setRefundSuccess('Refund signed by creator. Awaiting platform release.');
      }

      const updatedCampaign = await api.getCampaign(campaign.id);
      setCampaign(updatedCampaign);
    } catch (err) {
      setRefundError(err.message || 'Failed to initiate refund.');
    } finally {
      setRefundBusy(false);
    }
  }

  async function handleContributorRefund(contributionId) {
    setContributorRefundBusy(true);
    setContributorRefundError('');
    setContributorRefundSuccess('');
    try {
      await api.requestContributionRefund(contributionId);
      setContributorRefundSuccess('Your on-chain refund has been submitted.');
      api
        .getContributions(id, { limit: showAll ? 100 : 10, offset: 0 })
        .then((data) => {
          setContributions(data.contributions || []);
          setTotalContributions(data.total || 0);
        })
        .catch(() => { });
    } catch (err) {
      setContributorRefundError(err.message || 'On-chain refund failed.');
    } finally {
      setContributorRefundBusy(false);
    }
  }

  async function handleDeleteCampaign() {
    setDeleteError('');
    if (!campaign) return;

    // Check if confirmation matches campaign title
    if (deleteConfirmation !== campaign.title) {
      setDeleteError('Confirmation does not match campaign title');
      return;
    }

    try {
      setDeleteLoading(true);
      await api.deleteCampaign(campaign.id, token);
      setShowDeleteDialog(false);
      setDeleteConfirmation('');
      // Redirect to home after successful deletion
      window.location.href = '/';
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete campaign');
    } finally {
      setDeleteLoading(false);
    }
  }

  useEffect(() => {
    if (!campaign) return;
    const tTitle = translation?.title || campaign.title;
    const tDesc = translation?.description || campaign.description || '';
    document.title = `${tTitle} | CrowdPay`;

    const updateMeta = (name, content, property = false) => {
      let el = document.querySelector(
        property ? `meta[property="${name}"]` : `meta[name="${name}"]`
      );
      if (!el) {
        el = document.createElement('meta');
        if (property) el.setAttribute('property', name);
        else el.setAttribute('name', name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    updateMeta('description', tDesc);
    updateMeta('og:title', tTitle, true);
    updateMeta('og:description', tDesc, true);
    updateMeta('og:url', window.location.href, true);
    if (campaign.cover_image_url) {
      updateMeta('og:image', campaign.cover_image_url, true);
      updateMeta('twitter:image', campaign.cover_image_url);
    }
    updateMeta('twitter:card', 'summary_large_image');
    updateMeta('twitter:title', tTitle);
    updateMeta('twitter:description', tDesc);
  }, [campaign, translation]);

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '2.5rem' }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          ← Back to campaigns
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return <CampaignDetailSkeleton />;
  }

  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const canManageTeam = userRole === 'owner' || userRole === 'manager';
  const canChangeRoles = userRole === 'owner';
  const canPostUpdate = userRole === 'owner' || userRole === 'manager';
  const canEditCampaign =
    (userRole === 'owner' || userRole === 'editor') &&
    ['active', 'funded'].includes(campaign.status);
  const canViewAnalytics = userRole === 'owner' || userRole === 'manager' || userRole === 'viewer';
  const acceptedMembers = members.filter((m) => m.accepted_at);
  const pendingInvites = members.filter((m) => !m.accepted_at);
  const campaignUrl = `${window.location.origin}/campaigns/${id}`;
  const apiBase = (import.meta.env.VITE_API_BASE_URL || `${window.location.origin}`).replace(/\/+$/, "");
  const widgetEmbedCode = `<iframe src="${window.location.origin}/widget/campaigns/${id}" width="320" height="140" frameborder="0" style="border-radius:10px" title="CrowdPay funding widget"></iframe>`;
  const fullEmbedCode = `<iframe src="${window.location.origin}/embed/campaigns/${id}" width="480" height="280" frameborder="0" title="CrowdPay campaign embed"></iframe>`;
  const badgeMarkdown = `[![CrowdPay](${apiBase}/api/campaigns/${id}/badge.svg)](${campaignUrl})`;

  function canEditUpdate(update) {
    return Date.now() - new Date(update.created_at).getTime() <= 24 * 60 * 60 * 1000;
  }

  function startEditUpdate(update) {
    setEditingUpdateId(update.id);
    setUpdateForm({ title: update.title, body: update.body });
    setUpdatesError('');
  }

  function cancelUpdateEdit() {
    setEditingUpdateId(null);
    setUpdateForm({ title: '', body: '' });
    setUpdatesError('');
  }

  async function handleFreighterContribute() {
    try {
      const connected = await isConnected()
        .then((r) => r?.isConnected ?? r)
        .catch(() => false);
      if (!connected) {
        window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
        return;
      }
      setFreighterGuestMode(true);
      setShowModal(true);
    } catch {
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  }


  async function submitUpdate(e) {
    e.preventDefault();
    setUpdatesError('');

    if (updateForm.body.length > UPDATE_BODY_MAX) {
      setUpdatesError(
        `Update body must be ${UPDATE_BODY_MAX} characters or fewer (currently ${updateForm.body.length})`
      );
      return;
    }

    setUpdateBusy(true);

    try {
      if (editingUpdateId) {
        const updated = await api.updateCampaignUpdate(campaign.id, editingUpdateId, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => prev.map((item) => (item.id === editingUpdateId ? updated : item)));
        setEditingUpdateId(null);
      } else {
        const created = await api.postCampaignUpdate(campaign.id, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => [created, ...prev]);
      }

      setUpdateForm({ title: '', body: '' });
    } catch (err) {
      setUpdatesError(err.message || 'Could not save update');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function deleteUpdate(updateId) {
    if (!confirm('Delete this campaign update?')) return;

    setUpdatesError('');
    try {
      await api.deleteCampaignUpdate(campaign.id, updateId);
      setUpdates((prev) => prev.filter((item) => item.id !== updateId));
    } catch (err) {
      setUpdatesError(err.message || 'Could not delete update');
    }
  }
  return (
    <main
      className="container"
      style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}
    >
      {showCreatedBanner && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign is live.</strong> Share the link — contributors can fund in XLM or USDC
          when conversion paths are available.
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: 'var(--color-success-text)',
              textDecoration: 'underline',
              fontWeight: 600,
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {coverUploadError && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Cover image upload failed:</strong> {coverUploadError}
        </div>
      )}
      {campaign.status === 'funded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Goal reached.</strong> This campaign has met its funding target. Contributions may
          still be open until the creator closes the campaign.
        </div>
      )}
      {campaign.status === 'failed' && (
        <div className="alert alert--error" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign ended.</strong> This campaign did not reach its goal. Contributions are
          closed and refunds can be requested.
        </div>
      )}
      {campaign.status === 'refunded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign refunded.</strong> This campaign was refunded — all contributions have
          been returned to their original senders.
        </div>
      )}
      {campaign.status === 'failed' && user && user.id === campaign.creator_id && (
        <div
          style={{
            background: 'var(--color-bg-card, #1e1e2f)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            marginBottom: '1.25rem',
          }}
        >
          <p
            style={{
              margin: '0 0 0.75rem',
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.55,
            }}
          >
            This campaign did not reach its goal. You can refund all contributors — this will build
            and sign a Stellar transaction that returns each contributor&apos;s exact amount.
          </p>
          {refundError && (
            <p
              className="alert alert--error"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="alert"
            >
              {refundError}
            </p>
          )}
          {refundSuccess && (
            <p
              className="alert alert--success"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="status"
            >
              {refundSuccess}
            </p>
          )}
          <button
            id="btn-refund-contributors"
            type="button"
            className="btn-primary"
            disabled={refundBusy}
            onClick={handleInitiateRefund}
            style={{
              background: refundBusy ? undefined : 'var(--color-status-error)',
              borderColor: refundBusy ? undefined : 'var(--color-status-error)',
              fontSize: '0.9rem',
            }}
          >
            {refundBusy ? 'Processing refund…' : 'Refund contributors'}
          </button>
        </div>
      )}
      {campaign.creator_kyc_status !== 'verified' && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Legacy campaign:</strong> this campaign was created before creator identity
          verification was required.
        </div>
      )}
      {editSuccess && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          {editSuccess}
        </div>
      )}
      {campaign.cover_image_url && (
        <img src={campaign.cover_image_url} alt={campaign.title} style={styles.detailCoverImage} />
      )}
      {!campaign.cover_image_url && (
        <div style={styles.detailCoverPlaceholder} aria-hidden="true">
          <span style={styles.detailCoverPlaceholderText}>No campaign image yet</span>
        </div>
      )}
      <div style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.asset}>{campaign.asset_type}</span>
          <CampaignStatusBadge status={campaign.status} />
          <VerificationBadge status={campaign.creator_kyc_status || campaign.creator_verification_status} tier={campaign.creator_verification_tier} showTier />
          {user && <FavoriteToggle campaignId={campaign.id} />}
          {user && <FollowCampaignButton campaignId={campaign.id} />}
          {campaign.contract_address && (
            <span
              title="This campaign is backed by a Soroban smart contract"
              style={{
                background: 'var(--color-success-bg)',
                color: 'var(--color-success-text)',
                borderRadius: '999px',
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '0.25rem 0.6rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <span aria-hidden="true">⛓️</span> On-chain verified
            </span>
          )}
        </div>
        <LanguageToggle
          campaignId={campaign.id}
          defaultLanguage="en"
          defaultTitle={campaign.title}
          defaultDescription={campaign.description || ''}
          onTranslationChange={setTranslation}
        />
        {campaign.status === 'disputed' && (
          <div
            className="alert alert--error"
            role="status"
            style={{ marginBottom: '1rem', display: 'grid', gap: '0.5rem' }}
          >
            <strong>This campaign has an open dispute.</strong>
            <span style={{ fontSize: '0.85rem' }}>
              New contributions are paused and the escrow is frozen while the platform reviews
              the case.
            </span>
            {activeDispute &&
              (evidenceSubmitted ? (
                <span style={{ fontSize: '0.85rem' }}>Your evidence has been submitted.</span>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.85rem', width: 'fit-content' }}
                  onClick={() => setShowEvidenceForm(true)}
                >
                  Submit evidence
                </button>
              ))}
          </div>
        )}
        <h1 style={styles.title}>{translation?.title || campaign.title}</h1>
        {campaign.creator_name && <p style={styles.creator}>by {campaign.creator_name}</p>}
        <div
          style={{ ...styles.desc, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(markdownToHtml(translation?.description || campaign.description)),
          }}
        />
      </div>

      {campaign.wallet_mode === 'contract' && (
        <div style={{ ...styles.card, marginBottom: '1rem' }}>
          <TreasuryTransparencyPanel
            campaignId={campaign.id}
            assetType={campaign.asset_type}
          />
        </div>
      )}

      <CampaignComments campaignId={campaign.id} campaign={campaign} />

      {nftRewards.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <h2 style={styles.sectionTitle}>NFT proof of support</h2>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {nftRewards.slice(0, 3).map((reward) => (
              <div key={reward.id} style={{ ...styles.card, marginBottom: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                  <strong>{reward.reward_tier_title || 'NFT reward'}</strong>
                  <span style={styles.small}>{reward.status || 'configured'}</span>
                </div>
                {reward.serial_number && (
                  <p style={{ ...styles.small, marginTop: '0.4rem' }}>Serial: {reward.serial_number}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tiers.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <h2 style={styles.sectionTitle}>Reward tiers</h2>
          <div style={{ display: "grid", gap: "0.85rem" }}>
            {tiers.map((tier) => (
              <div
                key={tier.id}
                style={{
                  ...styles.card,
                  marginBottom: 0,
                  opacity: tier.sold_out ? 0.65 : 1,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "baseline" }}>
                  <strong style={{ fontSize: "1.05rem" }}>{tier.title}</strong>
                  <span style={styles.asset}>
                    {Number(tier.min_amount).toLocaleString()}+ {tier.asset_type}
                  </span>
                </div>
                {tier.description && (
                  <p style={{ ...styles.small, marginTop: "0.5rem", lineHeight: 1.5 }}>
                    {tier.description}
                  </p>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
                  {tier.estimated_delivery && (
                    <span style={styles.small}>
                      Estimated delivery: {new Date(tier.estimated_delivery).toLocaleDateString()}
                    </span>
                  )}
                  <span style={{ ...styles.small, fontWeight: 700, marginLeft: "auto" }}>
                    {tier.sold_out
                      ? "Sold out"
                      : tier.remaining === null || tier.remaining === undefined
                        ? "Unlimited backers"
                        : `${Number(tier.remaining).toLocaleString()} remaining`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>
              {Number(campaign.raised_amount).toLocaleString()} {campaign.asset_type}
            </div>
            <div style={styles.small}>
              raised of {Number(campaign.target_amount).toLocaleString()} goal
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>
              funded by <strong>{campaign.contributor_count || 0}</strong> backers
            </div>
          </div>
        </div>
        <div
          role="progressbar"
          className="campaign-progress-bar"
          aria-valuenow={Number(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of goal raised`}
          style={styles.bar}
        >
          <div
            style={{
              ...styles.fill,
              background: progressColor(parseFloat(pct), campaign.status),
              width: `${pct}%`,
            }}
            aria-hidden="true"
          />
        </div>

        {campaign.status === 'refunded' ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            This campaign has been <strong>refunded</strong>. All contributions were returned to
            their original senders.
          </p>
        ) : ['failed', 'closed', 'withdrawn'].includes(campaign.status) ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Contributions are closed while this campaign is <strong>{campaign.status}</strong>.
          </p>
        ) : user ? (
          <>
            <ContributorEligibilityBadge
              user={user}
              campaignId={campaign.id}
            />
            <button
              type="button"
              className="btn-primary"
              style={styles.cta}
              ref={contributeBtnRef}
              aria-label={`Contribute to ${campaign.title}`}
              onClick={() => setShowModal(true)}
            >
              Contribute
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <CampaignRequirementsNotice campaignId={campaign.id} />
            <Link
              to="/login"
              state={{ from: `/campaigns/${id}` }}
              className="btn-primary"
              style={{
                ...styles.cta,
                textAlign: 'center',
                textDecoration: 'none',
                display: 'block',
              }}
            >
              Log in to contribute
            </Link>
            <button
              type="button"
              className="btn-secondary"
              style={styles.cta}
              onClick={handleFreighterContribute}
            >
              Contribute with Freighter
            </button>
          </div>
        )}

        {user && campaign.status === 'active' && (
          <RecurringPledgeForm
            campaignId={id}
            asset={campaign.asset_type}
            walletType={user.wallet_type}
            onSubscribed={() => setContributed((prev) => !prev)}
          />
        )}

        {campaign.status === 'active' && (
          <div style={{ marginTop: '1.5rem' }}>
            <PoolManager campaignId={id} campaignTitle={campaign.title} />
          </div>
        )}

        {user && (
          <button
            type="button"
            className="btn-secondary"
            style={{ ...styles.cta, marginTop: '0.75rem' }}
            onClick={handleClone}
          >
            Clone campaign
          </button>
        )}
      </div>

      <div
        data-no-print
        style={{
          display: 'flex',
          gap: '0.65rem',
          marginBottom: '1.75rem',
          flexWrap: 'wrap',
        }}
      >
        {navigator.share && (
          <button
            type="button"
            className="btn-secondary"
            style={{
              flex: 1,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
            onClick={async () => {
              try {
                api.trackShare(campaign.id, 'native').catch(() => {});
                await navigator.share({
                  title: campaign.title,
                  text: campaign.description,
                  url: referralUrl || window.location.href,
                });
              } catch (err) {
                if (err.name !== 'AbortError') {
                  toast?.('Could not share this campaign. Please try again.', 'error');
                  Sentry.captureException(err);
                }
              }
            }}
          >
            Share
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'twitter').catch(() => {});
            const shareUrl = referralUrl || window.location.href;
            const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
            const daysLeft = Math.max(0, Math.ceil((new Date(campaign.end_date) - new Date()) / (1000 * 60 * 60 * 24)));
            const text = encodeURIComponent(`Back ${campaign.title} on CrowdPay — ${pct}% funded, ${daysLeft} days left. Built on Stellar. ${shareUrl} #Stellar #CrowdPay`);
            window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
          }}
          aria-label="Share on X"
        >
          Share on X
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'whatsapp').catch(() => {});
            const shareUrl = referralUrl || window.location.href;
            const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
            const text = encodeURIComponent(`Hey! Check out this campaign on CrowdPay: ${campaign.title}. They're ${pct}% funded and need your help. ${shareUrl}`);
            window.open(`https://wa.me/?text=${text}`, '_blank');
          }}
          aria-label="Share on WhatsApp"
        >
          WhatsApp
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'linkedin').catch(() => {});
            const shareUrl = referralUrl || window.location.href;
            const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
            window.open(linkedInUrl, '_blank');
          }}
          aria-label="Share on LinkedIn"
        >
          LinkedIn
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'telegram').catch(() => {});
            const shareUrl = referralUrl || window.location.href;
            const text = encodeURIComponent(`Check out this campaign: ${campaign.title}`);
            window.open(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${text}`, '_blank');
          }}
          aria-label="Share on Telegram"
        >
          Telegram
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'discord').catch(() => {});
            navigator.clipboard.writeText(referralUrl || window.location.href);
            toast?.('Link copied! Paste it in Discord to share.', 'success');
            setTimeout(() => window.open('https://discord.com/app', '_blank'), 1500);
          }}
          aria-label="Share on Discord"
        >
          Discord
        </button>
        <div style={{ position: 'relative', flex: 1 }}>
          <button
            type="button"
            className="btn-secondary"
            style={{
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              background: linkCopied ? 'var(--color-success-text)' : undefined,
              borderColor: linkCopied ? 'var(--color-success-text)' : undefined,
              color: linkCopied ? 'var(--color-bg)' : undefined,
              transition: 'all 0.2s ease',
            }}
            onClick={() => {
              api.trackShare(campaign.id, 'copy').catch(() => {});
              navigator.clipboard.writeText(referralUrl || window.location.href);
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 2000);
            }}
          >
            {linkCopied ? 'Copied!' : 'Copy link'}
          </button>

          <Link
            to={`/campaigns/${campaign.id}/share`}
            className="btn-secondary"
            style={{
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              textDecoration: 'none',
            }}
          >
            Share page &amp; referral link
          </Link>
        </div>
      </div>

      {user && campaign && isOwner && (
        <CampaignPublishControls campaign={campaign} isOwner={isOwner} navigate={navigate} />
      )}

      {user && campaign && isOwner && (
        <div data-no-print style={{ marginBottom: '1.75rem' }}>
          <h2 style={styles.sectionTitle}>Referrals</h2>
          <ReferralProgramSettings campaignId={campaign.id} />
        </div>
      )}

      {/* Edit campaign — owner or editor */}
      {user && campaign && canEditCampaign && (
        <div
          data-no-print
          style={{
            display: 'flex',
            gap: '0.65rem',
            marginBottom: '1.75rem',
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            style={{
              flex: 1,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
            onClick={handleOpenEditModal}
          >
            Edit Campaign
          </button>
          {isOwner && campaign.status === 'active' && !hasPendingWithdrawal && (
            <button
              type="button"
              className="btn-secondary"
              style={{
                color: 'var(--color-status-error)',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
              onClick={() => setShowDeleteDialog(true)}
            >
              Delete campaign
            </button>
          )}
        </div>
      )}

      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      <div style={{ marginBottom: '1.75rem' }}>
        <button
          type="button"
          className="btn-secondary"
          data-no-print
          aria-expanded={showQR}
          onClick={() => setShowQR((v) => !v)}
        >
          {showQR ? 'Hide QR code' : 'Show QR code'}
        </button>
        {showQR && (
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
            <CampaignQRCode
              url={referralUrl || `${window.location.origin}/campaigns/${id}`}
              size={200}
            />
          </div>
        )}
      </div>

      <details style={{ ...styles.card, marginTop: '-0.75rem' }}>
        <summary style={styles.embedSummary}>Embed on your site</summary>
        <pre style={{ ...styles.embedCode, marginTop: '0.75rem' }}>{widgetEmbedCode}</pre>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(widgetEmbedCode).then(() => {
              setEmbedCopied(true);
              setTimeout(() => setEmbedCopied(false), 2000);
            });
          }}
          className="btn-secondary"
          style={{ marginTop: '0.75rem', fontSize: '0.85rem', minHeight: 'auto' }}
        >
          {embedCopied ? 'Copied!' : 'Copy snippet'}
        </button>
      </details>

      {/* Report a problem — visible to contributors who have backed this campaign */}
      {user &&
        contributions?.some((c) => c.sender_public_key) &&
        campaign.creator_id !== user.id && (
          <div style={{ marginBottom: '1.25rem' }} data-no-print>
            {disputeSubmitted ? (
              <p className="alert alert--success" role="status">
                Your dispute has been submitted. The platform team will review it shortly.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-status-error)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                ⚠ Report a problem with this campaign
              </button>
            )}
          </div>
        )}
      {canPostUpdate && (
        <div style={styles.card} data-no-print>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Embed this campaign</h3>
            <button
              type="button"
              aria-expanded={showEmbedSection}
              onClick={() => setShowEmbedSection(!showEmbedSection)}
              style={{
                background: 'transparent',
                color: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                padding: '0.4rem 0.8rem',
                fontSize: '0.85rem',
                minHeight: 'auto',
              }}
            >
              {showEmbedSection ? 'Hide' : 'Show'}
            </button>
          </div>

          {showEmbedSection && (
            <>
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  marginBottom: '1rem',
                  lineHeight: 1.5,
                }}
              >
                Add this embed code to your website or blog to display a live funding widget for
                this campaign.
              </p>

              <div style={{ marginBottom: '1rem' }}>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  Compact widget (iframe)
                </label>
                <div style={{ position: 'relative' }}>
                  <pre style={styles.embedCode}>{widgetEmbedCode}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(widgetEmbedCode).then(() => {
                        setEmbedCopied(true);
                        setTimeout(() => setEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      background: embedCopied ? 'var(--color-success-text)' : 'var(--color-accent)',
                      color: '#fff',
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      minHeight: 'auto',
                    }}
                  >
                    {embedCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.5rem",
                  }}
                >
                  Full embed (iframe)
                </label>
                <div style={{ position: "relative" }}>
                  <pre style={styles.embedCode}>{fullEmbedCode}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(fullEmbedCode).then(() => {
                        setEmbedCopied(true);
                        setTimeout(() => setEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: "absolute",
                      top: "0.5rem",
                      right: "0.5rem",
                      background: embedCopied
                        ? "var(--color-success-text)"
                        : "var(--color-accent)",
                      color: "#fff",
                      padding: "0.4rem 0.8rem",
                      fontSize: "0.8rem",
                      minHeight: "auto",
                    }}
                  >
                    {embedCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.5rem",
                  }}
                >
                  README badge (markdown)
                </label>
                <div style={{ position: "relative" }}>
                  <pre style={styles.embedCode}>{badgeMarkdown}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(badgeMarkdown).then(() => {
                        setBadgeCopied(true);
                        setTimeout(() => setBadgeCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: "absolute",
                      top: "0.5rem",
                      right: "0.5rem",
                      background: badgeCopied
                        ? "var(--color-success-text)"
                        : "var(--color-accent)",
                      color: "#fff",
                      padding: "0.4rem 0.8rem",
                      fontSize: "0.8rem",
                      minHeight: "auto",
                    }}
                  >
                    {badgeCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <div>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  Preview
                </label>
                <div style={styles.embedPreview}>
                  <iframe
                    src={`/widget/campaigns/${campaign.id}`}
                    width="100%"
                    height="140"
                    frameBorder="0"
                    title="Campaign widget preview"
                    style={{
                      border: '1px solid var(--color-border-light)',
                      borderRadius: '6px',
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {token && (
        <div id="withdrawals" data-no-print>
          <WithdrawalsSection
            campaign={campaign}
            milestones={milestones}
            user={user}
            token={token}
            onReleased={() => {
              api
                .getCampaign(id)
                .then(setCampaign)
                .catch(() => { });
              api
                .getMilestones(id)
                .then(setMilestones)
                .catch(() => { });
            }}
          />
        </div>
      )}

      <TransactionHistory
        campaignId={campaign.id}
        isCreator={!!(user?.id && campaign.creator_id === user.id)}
      />

      <WithdrawalHistoryTimeline campaignId={campaign.id} token={token} />

      <MilestoneTracker milestones={milestones} assetType={campaign.asset_type} />
      <MilestoneVotePanel milestones={milestones} />

      {/* Stretch Goals (#585) */}
      {stretchGoals.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 700 }}>
            🚀 Stretch Goals
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {stretchGoals.map((goal) => {
              const reached = Number(campaign.raised_amount) >= Number(goal.amount);
              return (
                <div
                  key={goal.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.65rem 0.9rem',
                    borderRadius: 8,
                    border: `1px solid ${reached ? 'var(--color-success, #22c55e)' : 'var(--color-border)'}`,
                    background: reached ? 'var(--color-success-bg, #f0fdf4)' : 'transparent',
                  }}
                >
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{reached ? '✅' : '🎯'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '0.9rem' }}>{goal.title}</strong>
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', fontWeight: 600, flexShrink: 0 }}>
                        {Number(goal.amount).toLocaleString()} {campaign.asset_type}
                      </span>
                    </div>
                    {goal.description && (
                      <p style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>
                        {goal.description}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {canManageTeam && (
        <div style={{ marginBottom: '2rem' }} data-no-print>
          <div
            role="tablist"
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1rem',
              borderBottom: '1px solid var(--color-border-lighter)',
              paddingBottom: '0.5rem',
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'team'}
              onClick={() => setActiveTab('team')}
              style={{
                background: activeTab === 'team' ? 'var(--color-accent)' : 'transparent',
                color: activeTab === 'team' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Team
            </button>
            {canViewAnalytics && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'analytics'}
                onClick={() => setActiveTab('analytics')}
                style={{
                  background: activeTab === 'analytics' ? 'var(--color-accent)' : 'transparent',
                  color: activeTab === 'analytics' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '6px',
                  padding: '0.4rem 0.9rem',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Analytics
              </button>
            )}
          </div>

          {activeTab !== 'analytics' && (
            <>
              <h2 style={styles.sectionTitle}>Team</h2>
              <div
                className="campaign-card"
                style={{ marginBottom: '1.5rem', fontSize: '0.85rem' }}
              >
                <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
                  Role permissions
                </strong>
                <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--color-text-hint)' }}>
                  <li>
                    <strong>Owner</strong> — full control: manage team, assign roles (including
                    owner), edit content, post updates, withdraw funds.
                  </li>
                  <li>
                    <strong>Manager</strong> — invite members, post updates, submit milestones, view
                    analytics.
                  </li>
                  <li>
                    <strong>Editor</strong> — edit campaign content.
                  </li>
                  <li>
                    <strong>Viewer</strong> — read-only access to analytics.
                  </li>
                </ul>
              </div>
              <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
                <strong style={{ marginBottom: '0.75rem', display: 'block' }}>
                  Invite Team Member
                </strong>
                <form
                  onSubmit={handleInviteSubmit}
                  style={{
                    display: 'flex',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    alignItems: 'flex-end',
                  }}
                >
                  <div style={{ flex: '1 1 250px' }}>
                    <label
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--color-text-hint)',
                        display: 'block',
                        marginBottom: '0.25rem',
                      }}
                    >
                      Email
                    </label>
                    <input
                      type="email"
                      placeholder="member@example.com"
                      value={inviteForm.email}
                      onChange={(e) => setInviteForm((s) => ({ ...s, email: e.target.value }))}
                      required
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div style={{ width: '140px' }}>
                    <label
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--color-text-hint)',
                        display: 'block',
                        marginBottom: '0.25rem',
                      }}
                    >
                      Role
                    </label>
                    <select
                      value={inviteForm.role}
                      onChange={(e) => setInviteForm((s) => ({ ...s, role: e.target.value }))}
                      style={{ width: '100%', padding: '0.5rem' }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="manager">Manager</option>
                      {canChangeRoles && <option value="owner">Owner</option>}
                    </select>
                  </div>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={inviteBusy}
                    style={{ height: '38px' }}
                  >
                    {inviteBusy ? 'Sending…' : 'Invite'}
                  </button>
                </form>
                {inviteError && (
                  <p className="alert alert--error" style={{ marginTop: '0.75rem' }}>
                    {inviteError}
                  </p>
                )}
                {inviteSuccess && (
                  <p className="alert alert--success" style={{ marginTop: '0.75rem' }}>
                    Invitation sent!
                  </p>
                )}
              </div>

              {pendingInvites.length > 0 && (
                <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
                  <strong style={{ marginBottom: '0.75rem', display: 'block' }}>
                    Pending Invitations
                  </strong>
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {pendingInvites.map((member) => (
                      <div
                        key={member.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '1rem',
                          flexWrap: 'wrap',
                          borderBottom: '1px solid var(--color-border-lighter)',
                          paddingBottom: '0.5rem',
                        }}
                      >
                        <div>
                          <span style={{ fontWeight: 600 }}>{member.email}</span>
                          <span
                            style={{
                              marginLeft: '0.5rem',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              color: 'var(--color-warning-text)',
                              background: 'var(--color-warning-bg)',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                            }}
                          >
                            {member.role}
                          </span>
                          {member.invite_expires_at && (
                            <div
                              style={{
                                fontSize: '0.75rem',
                                color: 'var(--color-text-hint)',
                                marginTop: '0.25rem',
                              }}
                            >
                              Expires {new Date(member.invite_expires_at).toLocaleDateString()}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleResendInvite(member.id)}
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                          >
                            Resend
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleCancelInvite(member.id)}
                            style={{
                              padding: '0.25rem 0.5rem',
                              fontSize: '0.85rem',
                              color: 'var(--color-status-error)',
                              borderColor: 'var(--color-status-error)',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="campaign-card">
                <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Team Members</strong>
                {acceptedMembers.length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)' }}>No accepted team members yet.</p>
                ) : (
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {acceptedMembers.map((member) => (
                      <div
                        key={member.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '1rem',
                          borderBottom: '1px solid var(--color-border-lighter)',
                          paddingBottom: '0.5rem',
                        }}
                      >
                        <div>
                          <span style={{ fontWeight: 600 }}>{member.email}</span>
                          {member.user_name && (
                            <span
                              style={{
                                color: 'var(--color-text-hint)',
                                fontSize: '0.85rem',
                                marginLeft: '0.5rem',
                              }}
                            >
                              ({member.user_name})
                            </span>
                          )}
                          <span
                            style={{
                              marginLeft: '0.5rem',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              color: 'var(--color-accent)',
                              background: 'var(--color-accent-bg, rgba(99,102,241,0.1))',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                            }}
                          >
                            {member.role}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '0.5rem',
                            alignItems: 'center',
                          }}
                        >
                          {canChangeRoles && member.user_id ? (
                            <select
                              value={member.role}
                              onChange={(e) => handleRoleChange(member.user_id, e.target.value)}
                              disabled={String(member.user_id) === String(user?.id)}
                              style={{ padding: '0.25rem', fontSize: '0.85rem' }}
                            >
                              <option value="viewer">Viewer</option>
                              <option value="editor">Editor</option>
                              <option value="manager">Manager</option>
                              <option value="owner">Owner</option>
                            </select>
                          ) : (
                            <span style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                              {member.role}
                            </span>
                          )}
                          {(canChangeRoles || String(member.user_id) === String(user?.id)) &&
                            member.user_id && (
                              <button
                                className="btn-secondary"
                                onClick={() => handleRemoveMember(member.user_id)}
                                disabled={
                                  canChangeRoles &&
                                  String(member.user_id) === String(user?.id) &&
                                  member.role === 'owner'
                                }
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  fontSize: '0.85rem',
                                  color: 'var(--color-status-error)',
                                  borderColor: 'var(--color-status-error)',
                                }}
                              >
                                {String(member.user_id) === String(user?.id) ? 'Leave' : 'Remove'}
                              </button>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {canViewAnalytics && !canManageTeam && activeTab !== 'analytics' && (
        <div style={{ marginBottom: '1rem' }} data-no-print>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setActiveTab('analytics')}
            style={{ fontSize: '0.85rem' }}
          >
            View Analytics
          </button>
        </div>
      )}

      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>
      {canPostUpdate && (
        <form
          onSubmit={submitUpdate}
          className="campaign-card"
          style={{ marginBottom: '1rem' }}
          data-no-print
        >
          <strong style={{ marginBottom: '0.5rem', display: 'block' }}>
            {editingUpdateId ? 'Edit update' : 'Post update'}
          </strong>
          <label htmlFor="update-title" className="sr-only">Update title</label>
          <input
            id="update-title"
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) => setUpdateForm((s) => ({ ...s, title: e.target.value }))}
            required
            style={{ marginBottom: '0.5rem' }}
          />
          <label htmlFor="update-body" className="sr-only">Update body</label>
          <textarea
            id="update-body"
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) => setUpdateForm((s) => ({ ...s, body: e.target.value }))}
            rows={4}
            required
          />
          <div
            aria-live="polite"
            style={{
              fontSize: '0.8rem',
              marginTop: '0.25rem',
              textAlign: 'right',
              color:
                updateForm.body.length > UPDATE_BODY_MAX
                  ? 'var(--color-status-error)'
                  : updateForm.body.length >= UPDATE_BODY_WARN_THRESHOLD
                    ? 'var(--color-status-warning, var(--color-status-error))'
                    : 'var(--color-text-hint)',
            }}
          >
            {UPDATE_BODY_MAX - updateForm.body.length} characters left
          </div>
          {updatesError && (
            <div
              style={{
                color: 'var(--color-status-error)',
                fontSize: '0.85rem',
                marginTop: '0.5rem',
              }}
            >
              {updatesError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="submit" className="btn-primary" disabled={updateBusy}>
              {updateBusy ? 'Saving...' : editingUpdateId ? 'Save changes' : 'Post'}
            </button>
            {editingUpdateId && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEditingUpdateId(null);
                  setUpdateForm({ title: '', body: '' });
                  setUpdatesError('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {updates.map((update) => (
        <article key={update.id} className="campaign-card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <strong>{update.title}</strong>
            <span
              style={{
                color: 'var(--color-text-hint)',
                fontSize: '0.85rem',
              }}
            >
              {update.author_name} • <RelativeTime date={update.created_at} />
            </span>
          </div>
          <div
            style={{
              marginTop: '0.5rem',
              color: 'var(--color-text-primary)',
              lineHeight: 1.5,
            }}
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(markdownToHtml(update.body)),
            }}
          />
        </article>
      ))}

      <div style={{ marginTop: '2rem', marginBottom: '2rem' }} data-no-print>
        <CampaignComments campaignId={campaign.id} campaign={campaign} />
      </div>

      {/* Analytics Section */}
      {canViewAnalytics && (canManageTeam ? activeTab === 'analytics' : true) && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={styles.sectionTitle}>Analytics</h2>

          <div
            role="tablist"
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1rem',
              borderBottom: '1px solid var(--color-border-light)',
              paddingBottom: '0.75rem',
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={analyticsTab === 'overview'}
              onClick={() => setAnalyticsTab('overview')}
              style={{
                background: analyticsTab === 'overview' ? 'var(--color-accent)' : 'transparent',
                color: analyticsTab === 'overview' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Overview
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={analyticsTab === 'backers'}
              onClick={() => setAnalyticsTab('backers')}
              style={{
                background: analyticsTab === 'backers' ? 'var(--color-accent)' : 'transparent',
                color: analyticsTab === 'backers' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Backers
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={analyticsTab === 'referrals'}
              onClick={() => setAnalyticsTab('referrals')}
              style={{
                background: analyticsTab === 'referrals' ? 'var(--color-accent)' : 'transparent',
                color: analyticsTab === 'referrals' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Referrals
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={analyticsTab === 'treasury'}
              onClick={() => setAnalyticsTab('treasury')}
              style={{
                background: analyticsTab === 'treasury' ? 'var(--color-accent)' : 'transparent',
                color: analyticsTab === 'treasury' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Treasury
            </button>
          </div>

          {analyticsTab === 'overview' && (
            <>
              {!analytics?.dailyTotals || analytics.dailyTotals.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>No analytics data available yet.</p>
              ) : (
                <div style={{ display: 'grid', gap: '1.5rem' }}>
                  <div className="campaign-card">
                    <strong style={{ display: 'block', marginBottom: '1rem' }}>
                      Contributions (Last 30 Days)
                    </strong>


                    <svg width="100%" height={150} viewBox={`0 0 600 150`} preserveAspectRatio="none">
                      {analytics.dailyTotals.map((day, i) => {
                        const maxAmount = Math.max(
                          ...analytics.dailyTotals.map((d) => Number(d.total_amount) || 0),
                          1
                        );
                        const barWidth = 600 / Math.max(analytics.dailyTotals.length, 1);
                        const barHeight = Math.max(5, (Number(day.total_amount) / maxAmount) * 150);
                        const y = 150 - barHeight;
                        const x = i * barWidth;
                        return (
                          <g key={i}>
                            <title>{`${new Date(day.day).toLocaleDateString()}: ${day.total_amount} ${day.asset}`}</title>
                            <rect
                              x={x}
                              y={y}
                              width={Math.max(barWidth - 2, 2)}
                              height={barHeight}
                              fill="var(--color-accent)"
                              rx="2"
                            />
                          </g>
                        );
                      })}
                    </svg>
                  </div>

                  <div className="campaign-card">
                    <strong style={{ display: 'block', marginBottom: '1rem' }}>Asset Breakdown</strong>
                    {analytics.assetBreakdown.map((asset) => (
                      <div
                        key={asset.paid_with}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: '0.5rem',
                        }}
                      >
                        <span>{asset.paid_with}</span>
                        <strong>{asset.total_sent}</strong>
                      </div>
                    ))}
                  </div>

                  <div className="campaign-card">
                    <strong style={{ display: 'block', marginBottom: '1rem' }}>Top Contributors</strong>
                    {analytics.topContributors.map((c, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: '0.5rem',
                          fontFamily: 'monospace',
                        }}
                      >
                        <span>
                          {c.sender_public_key.slice(0, 4)}...
                          {c.sender_public_key.slice(-4)}
                        </span>
                        <span>
                          {c.total} ({c.times} contributions)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {analyticsTab === 'backers' && (
            <p style={{ color: 'var(--color-text-muted)' }}>Backer insights coming soon.</p>
          )}

          {analyticsTab === 'referrals' && (
            <CampaignReferralsTab campaignId={campaign.id} assetType={campaign.asset_type} />
          )}

          {analyticsTab === 'treasury' && (
            <TreasuryPanel
              campaignId={campaign.id}
              assetType={campaign.asset_type}
              isAuditor={
                Boolean(campaign.auditor_public_key) &&
                campaign.auditor_public_key === user?.wallet_public_key
              }
            />
          )}
        </div>
      )}

      {isOwner && referralLeaderboard && referralLeaderboard.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={styles.sectionTitle}>Referral Leaderboard</h2>
          <div className="campaign-card">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>#</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Referrer</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Clicks</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Contributions</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Conv. Rate</th>
                </tr>
              </thead>
              <tbody>
                {referralLeaderboard.map((r, i) => (
                  <tr
                    key={r.referral_code}
                    style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                  >
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-hint)' }}>
                      {i + 1}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                      {r.referrer_name}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.click_count}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.contribution_count}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.click_count > 0
                        ? `${((r.contribution_count / r.click_count) * 100).toFixed(0)}%`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2 style={styles.sectionTitle}>
        Backer Wall {contributions !== null ? `(${totalContributions})` : ''}
        {isLive && (
          <span style={styles.liveIndicator} title="Live updates active">
            <span style={styles.liveDot} />
            Live
          </span>
        )}
      </h2>

      {contributions === null ? (
        <ContributionListSkeleton />
      ) : contributions.length === 0 ? (
        <div style={styles.emptyBackers}>
          <p>Be the first to back this!</p>
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Every contribution counts towards making this goal a reality.
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list} className="contributions-list">
            {contributions.map((c) => (
              <ContributionRow key={c.id} c={c} />
            ))}
          </div>
          {totalContributions > 10 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                marginTop: '1rem',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAll((prev) => !prev)}
                style={{
                  padding: '0.5rem 1.5rem',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                {showAll ? 'Show less' : `Show all (${totalContributions})`}
              </button>
            </div>
          )}
        </>
      )}

      {showModal && (
        <ContributeModal
          campaign={campaign}
          tiers={tiers}
          referralCode={refParam}
          initialAmount={presetAmount}
          guestFreighterMode={freighterGuestMode}
          onClose={() => {
            setShowModal(false);
            setFreighterGuestMode(false);
            contributeBtnRef.current?.focus();
          }}
          onSuccess={() => setContributed((v) => !v)}
        />
      )}
      {showDisputeModal && (
        <DisputeModal
          campaign={campaign}
          onClose={() => setShowDisputeModal(false)}
          onSubmitted={() => setDisputeSubmitted(true)}
        />
      )}

      {showEvidenceForm && activeDispute && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="evidence-form-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--color-bg)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '480px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h2 id="evidence-form-title" style={{ fontSize: '1.2rem', fontWeight: 700, marginTop: 0 }}>
              Submit evidence
            </h2>
            <EvidenceForm
              disputeId={activeDispute.id}
              onClose={() => setShowEvidenceForm(false)}
              onSubmitted={() => setEvidenceSubmitted(true)}
            />
          </div>
        </div>
      )}

      {/* Edit Campaign Modal */}
      {isEditingCampaign && campaign && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-campaign-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={handleCloseEditModal}
        >
          <div
            ref={editModalRef}
            style={{
              background: 'var(--color-bg)',
              borderRadius: '12px',
              padding: '2rem',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="edit-campaign-title"
              style={{
                marginTop: 0,
                marginBottom: '1.5rem',
                fontSize: '1.5rem',
              }}
            >
              Edit Campaign
            </h2>

            {editError && (
              <p
                style={{
                  color: 'var(--color-status-error)',
                  marginBottom: '1rem',
                  padding: '0.75rem',
                  background: 'var(--color-status-error-bg)',
                  borderRadius: '6px',
                }}
              >
                {editError}
              </p>
            )}

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Title
              </label>
              <input
                type="text"
                value={editFormData.title}
                onChange={(e) => setEditFormData({ ...editFormData, title: e.target.value })}
                maxLength={100}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-lightest)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                }}
              />
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-muted)',
                  margin: '0.25rem 0 0',
                }}
              >
                {editFormData.title.length}/100
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Description
              </label>
              <textarea
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    description: e.target.value,
                  })
                }
                maxLength={1000}
                rows={5}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-lightest)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-muted)',
                  margin: '0.25rem 0 0',
                }}
              >
                {editFormData.description.length}/1000
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Deadline (optional)
              </label>
              <input
                type="date"
                value={editFormData.deadline}
                onChange={(e) => setEditFormData({ ...editFormData, deadline: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-lightest)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ marginTop: '1.5rem', marginBottom: '1.5rem', borderTop: '1px solid var(--color-border-lightest)', paddingTop: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Translations</h3>
                {translationsLoading && <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>Loading...</span>}
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: '1rem' }}>
                Add translated versions of your campaign content for international contributors. If a translation is not provided, the original content will be displayed.
              </p>

              {translationSuccess && (
                <div className="alert alert--success" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                  {translationSuccess}
                </div>
              )}
              {translationError && (
                <div className="alert alert--error" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                  {translationError}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
                {SUPPORTED_LOCALES.map((loc) => {
                  const hasTranslation = translations.some((t) => (t.locale || t.language) === loc.code);
                  const isCurrentForm = translationForm?.locale === loc.code;
                  return (
                    <button
                      key={loc.code}
                      type="button"
                      className={isCurrentForm ? 'btn-primary' : 'btn-secondary'}
                      style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
                      onClick={() => handleStartAddTranslation(loc.code)}
                    >
                      {hasTranslation ? `✓ Edit ${loc.label}` : `+ Add Translation (${loc.label})`}
                    </button>
                  );
                })}
              </div>

              {translationForm && (
                <div
                  style={{
                    background: 'var(--color-surface, #f9fafb)',
                    border: '1px solid var(--color-border-lightest, #e5e7eb)',
                    borderRadius: '8px',
                    padding: '1rem',
                    marginBottom: '1rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>
                      Editing {SUPPORTED_LOCALES.find((l) => l.code === translationForm.locale)?.label || translationForm.locale.toUpperCase()} Translation
                    </h4>
                    {translations.some((t) => (t.locale || t.language) === translationForm.locale) && (
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-error, #ef4444)',
                          fontSize: '0.8rem',
                          cursor: 'pointer',
                          padding: 0,
                        }}
                        onClick={() => handleDeleteTranslation(translationForm.locale)}
                      >
                        Delete translation
                      </button>
                    )}
                  </div>

                  <div style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                      Translated Title *
                    </label>
                    <input
                      type="text"
                      value={translationForm.title}
                      onChange={(e) => setTranslationForm({ ...translationForm, title: e.target.value })}
                      placeholder="Title in selected language"
                      style={{
                        width: '100%',
                        padding: '0.6rem',
                        border: '1px solid var(--color-border-lightest)',
                        borderRadius: '6px',
                        fontSize: '0.9rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>

                  <div style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                      Translated Description (optional)
                    </label>
                    <textarea
                      value={translationForm.description}
                      onChange={(e) => setTranslationForm({ ...translationForm, description: e.target.value })}
                      placeholder="Description in selected language"
                      rows={3}
                      style={{
                        width: '100%',
                        padding: '0.6rem',
                        border: '1px solid var(--color-border-lightest)',
                        borderRadius: '6px',
                        fontSize: '0.9rem',
                        boxSizing: 'border-box',
                        resize: 'vertical',
                      }}
                    />
                  </div>

                  {milestones && milestones.length > 0 && (
                    <div style={{ marginBottom: '0.75rem' }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                        Translated Milestone Titles (optional)
                      </label>
                      {milestones.map((m, idx) => (
                        <div key={m.id || idx} style={{ marginBottom: '0.5rem' }}>
                          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                            Milestone {idx + 1}: {m.title}
                          </span>
                          <input
                            type="text"
                            value={translationForm.milestone_titles[idx] || ''}
                            onChange={(e) => {
                              const newTitles = [...(translationForm.milestone_titles || [])];
                              newTitles[idx] = e.target.value;
                              setTranslationForm({ ...translationForm, milestone_titles: newTitles });
                            }}
                            placeholder={`Translated title for "${m.title}"`}
                            style={{
                              width: '100%',
                              padding: '0.5rem',
                              border: '1px solid var(--color-border-lightest)',
                              borderRadius: '6px',
                              fontSize: '0.85rem',
                              boxSizing: 'border-box',
                              marginTop: '0.2rem',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
                      onClick={() => setTranslationForm(null)}
                      disabled={translationSaving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
                      onClick={handleSaveTranslation}
                      disabled={translationSaving}
                    >
                      {translationSaving ? 'Saving...' : 'Save Translation'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCloseEditModal}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveEdit}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Campaign Confirmation Dialog */}
      {showDeleteDialog && campaign && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-campaign-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            ref={deleteModalRef}
            style={{
              background: 'var(--color-surface)',
              borderRadius: '8px',
              padding: '2rem',
              maxWidth: '500px',
              width: '90%',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
          >
            <h2
              id="delete-campaign-title"
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                marginBottom: '1rem',
                color: 'var(--color-text-primary)',
              }}
            >
              Delete Campaign
            </h2>
            <p
              style={{
                fontSize: '0.95rem',
                color: 'var(--color-text-secondary)',
                marginBottom: '1.5rem',
                lineHeight: 1.5,
              }}
            >
              Are you sure you want to delete this campaign? This action cannot be undone. All
              contribution and withdrawal history will be preserved, but the campaign will no longer
              be visible to the public.
            </p>
            <div style={{ marginBottom: '1.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  fontSize: '0.9rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Type the campaign title to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={campaign.title}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '4px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {deleteError && (
              <p className="alert alert--error" style={{ marginBottom: '1.5rem' }}>
                {deleteError}
              </p>
            )}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmation('');
                  setDeleteError('');
                }}
                disabled={deleteLoading}
                style={{ opacity: deleteLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDeleteCampaign}
                disabled={deleteLoading || deleteConfirmation !== campaign.title}
                style={{
                  opacity: deleteLoading || deleteConfirmation !== campaign.title ? 0.6 : 1,
                  background: 'var(--color-status-error)',
                  borderColor: 'var(--color-status-error)',
                }}
              >
                {deleteLoading ? 'Deleting...' : 'Delete Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {(isOwner || user?.role === 'admin') && campaign && (
        <RefundsSection
          campaign={campaign}
          user={user}
          onRefundSuccess={() => {
            api.getCampaign(id).then(setCampaign).catch(() => {});
          }}
        />
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: '1.5rem' },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  asset: {
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    fontSize: '0.75rem',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '99px',
  },
  title: {
    fontSize: '1.8rem',
    fontWeight: 800,
    margin: '0.5rem 0',
    color: 'var(--color-text-primary)',
  },
  creator: { color: 'var(--color-text-hint)', fontSize: '0.9rem', marginBottom: '0.5rem' },
  desc: { color: 'var(--color-text-secondary)', fontSize: '1rem', lineHeight: 1.6 },
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1rem',
  },
  amounts: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '1rem',
  },
  big: { fontSize: '1.5rem', fontWeight: 800, color: 'var(--color-text-primary)' },
  small: { fontSize: '0.85rem', color: 'var(--color-text-muted)' },
  bar: {
    background: 'var(--color-surface)',
    borderRadius: '99px',
    height: '8px',
    marginBottom: '1.25rem',
    overflow: 'hidden',
  },
  fill: { background: 'var(--color-accent)', height: '100%', borderRadius: '99px' },
  cta: { width: '100%', padding: '0.85rem', fontSize: '1rem' },
  walletInfo: {
    background: 'var(--color-surface)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    marginBottom: '1.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  walletLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase',
  },
  walletKey: { fontSize: '0.8rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' },
  detailCoverImage: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    objectFit: 'cover',
    maxHeight: '360px',
  },
  detailCoverPlaceholder: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    height: '260px',
    background: 'linear-gradient(135deg, var(--color-accent-lighter) 0%, var(--color-accent-lightest) 100%)',
    border: '1px solid var(--color-purple-light)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailCoverPlaceholderText: { color: 'var(--color-accent-hover)', fontWeight: 700 },
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-lighter)',
    borderRadius: '6px',
    padding: '0.6rem 0.85rem',
  },
  sender: { fontSize: '0.85rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace' },
  amount: { fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 },
  convHint: { fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: '0.15rem' },
  refundTag: {
    marginTop: '0.45rem',
    fontSize: '0.75rem',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  liveIndicator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: '0.5rem',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--color-success-text)',
    verticalAlign: 'middle',
  },
  liveDot: {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--color-success-text)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },

  embedCode: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: 'var(--color-text-primary)',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    paddingRight: '5rem',
  },
  embedSummary: {
    cursor: 'pointer',
    fontSize: '0.85rem',
    color: 'var(--color-accent)',
    fontWeight: 600,
  },
  embedPreview: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '6px',
    padding: '0.75rem',
  },
  emptyBackers: {
    padding: '2.5rem 1rem',
    textAlign: 'center',
    background: 'var(--color-accent-lightest)',
    border: '2px dashed var(--color-accent-lighter)',
    borderRadius: '12px',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  avatar: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.9rem',
    fontWeight: 800,
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '1rem',
    borderBottom: '1px solid var(--color-border-light)',
    paddingBottom: '0.75rem',
  },
  tabButton: {
    flex: 1,
    fontSize: '0.9rem',
    justifyContent: 'center',
  },
};

