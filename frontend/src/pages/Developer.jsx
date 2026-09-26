import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api } from '../services/api';

const EVENT_OPTIONS = [
  'campaign.funded',
  'contribution.received',
  'milestone.approved',
  'withdrawal.completed',
];

const SCOPE_OPTIONS = ['read', 'write', 'withdrawals', 'developer', 'full'];

const V1_API_BASE = `${(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')}/api/v1`;

export default function Developer() {
  const { user } = useAuth();
  const toast = useToast();
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [credentialsActivity, setCredentialsActivity] = useState([]);
  const [error, setError] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('Integration');
  const [newKeyScopes, setNewKeyScopes] = useState(['read', 'write', 'withdrawals']);
  const [revealedKey, setRevealedKey] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState(['contribution.received']);
  const [revealedSecret, setRevealedSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [v1Endpoints, setV1Endpoints] = useState([]);
  const [explorerEndpoint, setExplorerEndpoint] = useState('');
  const [explorerApiKey, setExplorerApiKey] = useState('');
  const [explorerPathParams, setExplorerPathParams] = useState({});
  const [explorerQuery, setExplorerQuery] = useState({});
  const [explorerBody, setExplorerBody] = useState('');
  const [explorerResponse, setExplorerResponse] = useState('');
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [explorerError, setExplorerError] = useState('');

  async function refresh() {
    setError('');
    try {
      const [k, h, d, a] = await Promise.all([
        api.listApiKeys(),
        api.listWebhooks(),
        api.listWebhookDeliveries({ limit: 80 }),
        api.getCredentialActivity(),
      ]);
      setKeys(k);
      setHooks(h);
      setDeliveries(d);
      setCredentialsActivity(a);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function loadOpenApi() {
    try {
      // Cache hit: the spec is unlikely to change during a session (Issue #580).
      const cacheKey = `cp_openapi_spec_${V1_API_BASE}`;
      const cachedRaw = sessionStorage.getItem(cacheKey);
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw);
          if (Array.isArray(cached) && cached.length > 0) {
            setV1Endpoints(cached);
            const saved = localStorage.getItem('cp_explorer_endpoint');
            if (saved && cached.find((e) => e.id === saved)) {
              setExplorerEndpoint(saved);
            } else if (cached.length > 0) {
              setExplorerEndpoint(cached[0].id);
            }
            return;
          }
        } catch {
          // Corrupted cache — silently re-fetch.
          sessionStorage.removeItem(cacheKey);
        }
      }

      const res = await fetch(`${V1_API_BASE}/docs/openapi.json`);
      if (!res.ok) throw new Error('Failed to fetch OpenAPI spec');
      const spec = await res.json();
      
      const endpoints = [];
      for (const [path, methods] of Object.entries(spec.paths || {})) {
        for (const [method, operation] of Object.entries(methods)) {
          const pathFields = [];
          const queryFields = [];
          let bodyTemplate = null;

          (operation.parameters || []).forEach((p) => {
            if (p.in === 'path') pathFields.push(p.name);
            if (p.in === 'query') queryFields.push(p.name);
          });

          const normalizedPath = path.replace(/{([^}]+)}/g, ':$1');

          if (operation.requestBody?.content?.['application/json']?.schema?.properties) {
            bodyTemplate = Object.keys(
              operation.requestBody.content['application/json'].schema.properties
            ).reduce((acc, k) => ({ ...acc, [k]: '' }), {});
          } else if (method.toUpperCase() !== 'GET') {
            bodyTemplate = {};
          }

          endpoints.push({
            id: `${method.toUpperCase()}-${path}`,
            label: `${method.toUpperCase()} ${normalizedPath} — ${operation.summary || ''}`,
            method: method.toUpperCase(),
            path: normalizedPath,
            auth: !!(operation.security && operation.security.length),
            pathFields,
            queryFields,
            bodyTemplate,
          });
        }
      }
      setV1Endpoints(endpoints);

      // Cache the parsed endpoints in sessionStorage so subsequent mounts
      // skip the network roundtrip (Issue #580).
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(endpoints));
      } catch {
        // Storage full or unavailable — non-critical, the endpoints are already
        // in component state.
      }

      const saved = localStorage.getItem('cp_explorer_endpoint');
      if (saved && endpoints.find((e) => e.id === saved)) {
        setExplorerEndpoint(saved);
      } else if (endpoints.length > 0) {
        setExplorerEndpoint(endpoints[0].id);
      }
    } catch (err) {
      toast?.('Failed to load API spec. Please try again.', 'error');
      Sentry.captureException(err);
    }
  }

  useEffect(() => {
    refresh();
    loadOpenApi();
  }, []);

  useEffect(() => {
    if (!explorerEndpoint) return;
    localStorage.setItem('cp_explorer_endpoint', explorerEndpoint);
    
    const savedParamsStr = localStorage.getItem(`cp_explorer_params_${explorerEndpoint}`);
    if (savedParamsStr) {
      try {
        const parsed = JSON.parse(savedParamsStr);
        setExplorerPathParams(parsed.pathParams || {});
        setExplorerQuery(parsed.query || {});
        setExplorerBody(parsed.body || '');
      } catch (err) {
        // ignore JSON parse error
      }
    } else {
      const ep = v1Endpoints.find((e) => e.id === explorerEndpoint);
      setExplorerPathParams({});
      setExplorerQuery({});
      setExplorerBody(ep?.bodyTemplate ? JSON.stringify(ep.bodyTemplate, null, 2) : '');
    }
    setExplorerResponse('');
    setExplorerError('');
  }, [explorerEndpoint, v1Endpoints]);

  // Debounce localStorage writes so typing in the body/params does not
  // stringify + setItem on every keystroke (see #575).
  useEffect(() => {
    if (!explorerEndpoint) return;
    const timer = setTimeout(() => {
      localStorage.setItem(
        `cp_explorer_params_${explorerEndpoint}`,
        JSON.stringify({
          pathParams: explorerPathParams,
          query: explorerQuery,
          body: explorerBody,
        })
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [explorerPathParams, explorerQuery, explorerBody, explorerEndpoint]);

  if (!user) {
    return (
      <main className="container" style={{ paddingTop: '4rem', maxWidth: '720px' }}>
        <p>
          <Link to="/login">Log in</Link> to manage API keys and webhooks.
        </p>
      </main>
    );
  }

  async function createKey(e) {
    e.preventDefault();
    setRevealedKey('');
    setError('');
    try {
      const res = await api.createApiKey({ name: newKeyLabel, scopes: newKeyScopes });
      setRevealedKey(res.api_key);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeKey(id) {
    if (!window.confirm('Revoke this API key?')) return;
    setError('');
    try {
      await api.deleteApiKey(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createHook(e) {
    e.preventDefault();
    setRevealedSecret('');
    setError('');
    try {
      const res = await api.createWebhook({ url: hookUrl, events: hookEvents });
      setRevealedSecret(res.secret);
      setHookUrl('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeHook(id) {
    if (!window.confirm('Remove this webhook endpoint?')) return;
    setError('');
    try {
      await api.deleteWebhook(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleEvent(ev) {
    setHookEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));
  }

  function toggleScope(sc) {
    setNewKeyScopes((cur) => (cur.includes(sc) ? cur.filter((x) => x !== sc) : [...cur, sc]));
  }

  const selectedEndpoint =
    v1Endpoints.find((e) => e.id === explorerEndpoint) ||
    v1Endpoints[0] ||
    {
      id: '',
      auth: false,
      method: 'GET',
      path: '',
      pathFields: [],
      queryFields: [],
      bodyTemplate: null,
      label: '',
    };

  function buildExplorerUrl() {
    if (!selectedEndpoint) return '';
    let path = selectedEndpoint.path;
    (selectedEndpoint.pathFields || []).forEach((field) => {
      path = path.replace(`:${field}`, encodeURIComponent(explorerPathParams[field] || ''));
    });
    const params = new URLSearchParams();
    (selectedEndpoint.queryFields || []).forEach((field) => {
      const value = explorerQuery[field];
      if (value !== undefined && value !== '') params.set(field, String(value));
    });
    const qs = params.toString();
    return `${V1_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  }

  function getCurlCommand() {
    if (!selectedEndpoint) return '';
    const url = buildExplorerUrl();
    let cmd = `curl -X ${selectedEndpoint.method} "${url}"`;
    
    if (selectedEndpoint.auth && explorerApiKey) {
      cmd += ` \\\n  -H "Authorization: Bearer ${explorerApiKey}"`;
    }
    
    if (selectedEndpoint.method !== 'GET' && selectedEndpoint.bodyTemplate !== null) {
      cmd += ` \\\n  -H "Content-Type: application/json"`;
      if (explorerBody) {
        const safeBody = explorerBody.replace(/'/g, "'\\''");
        cmd += ` \\\n  -d '${safeBody}'`;
      }
    }
    return cmd;
  }

  async function runExplorerRequest(e) {
    e.preventDefault();
    if (!selectedEndpoint) return;
    setExplorerBusy(true);
    setExplorerError('');
    setExplorerResponse('');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (selectedEndpoint.auth) {
        if (!explorerApiKey) {
          throw new Error('API key required for this endpoint');
        }
        headers.Authorization = `Bearer ${explorerApiKey}`;
      }
      // The API playground runs in the browser, so same-origin mutating calls
      // must echo the `cp_csrf` cookie or the csrfProtection middleware 403s
      // them (#801).
      if (selectedEndpoint.method !== 'GET' && typeof document !== 'undefined') {
        const csrfMatch = document.cookie.match(/(?:^|; )cp_csrf=([^;]*)/);
        if (csrfMatch) headers['x-csrf-token'] = decodeURIComponent(csrfMatch[1]);
      }
      const options = {
        method: selectedEndpoint.method,
        headers:
          selectedEndpoint.method === 'GET'
            ? explorerApiKey && selectedEndpoint.auth
              ? { Authorization: headers.Authorization }
              : undefined
            : headers,
      };
      if (selectedEndpoint.method !== 'GET' && selectedEndpoint.bodyTemplate !== null) {
        options.body = explorerBody;
      }
      const res = await fetch(buildExplorerUrl(), options);
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      setExplorerResponse(JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed }, null, 2));
    } catch (err) {
      setExplorerError(err.message || 'Request failed');
    } finally {
      setExplorerBusy(false);
    }
  }

  return (
    <main
      className="container"
      style={{ paddingTop: '3rem', paddingBottom: '4rem', maxWidth: '900px' }}
    >
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.35rem' }}>Developer</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem', fontSize: '0.95rem' }}>
        API keys and webhooks for integrating CrowdPay as a funding backend. Public API
        documentation:{' '}
        <a
          href="/v1/docs"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--color-accent)', fontWeight: 600 }}
        >
          OpenAPI /v1/docs
        </a>
        . See <code style={{ fontSize: '0.85rem' }}>backend/docs/webhooks-integration.md</code> for
        HMAC verification.
      </p>
      {error && <p style={{ color: 'var(--color-status-error)', marginBottom: '1rem' }}>{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>Loading…</p>}

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          API explorer
        </h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)', marginBottom: '1rem' }}>
          Try public API v1 endpoints with your API key. Rate limit: 100 requests/minute per key.
        </p>
        <form
          onSubmit={runExplorerRequest}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '640px' }}
        >
          <label style={{ fontSize: '0.85rem' }}>
            Endpoint
            <select
              value={explorerEndpoint}
              onChange={(e) => setExplorerEndpoint(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
            >
              {v1Endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.85rem' }}>
            API key {selectedEndpoint.auth ? '(required)' : '(optional)'}
            <input
              type="password"
              value={explorerApiKey}
              onChange={(e) => setExplorerApiKey(e.target.value)}
              placeholder="cp_live_…"
              style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
            />
          </label>
          {(selectedEndpoint.pathFields || []).map((field) => (
            <label key={field} style={{ fontSize: '0.85rem' }}>
              {field}
              <input
                value={explorerPathParams[field] || ''}
                onChange={(e) =>
                  setExplorerPathParams((cur) => ({ ...cur, [field]: e.target.value }))
                }
                style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
              />
            </label>
          ))}
          {(selectedEndpoint.queryFields || []).map((field) => (
            <label key={field} style={{ fontSize: '0.85rem' }}>
              Query: {field}
              <input
                value={explorerQuery[field] || ''}
                onChange={(e) => setExplorerQuery((cur) => ({ ...cur, [field]: e.target.value }))}
                style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
              />
            </label>
          ))}
          {selectedEndpoint.bodyTemplate && (
            <label style={{ fontSize: '0.85rem' }}>
              Request body (JSON)
              <textarea
                rows={5}
                value={explorerBody}
                onChange={(e) => setExplorerBody(e.target.value)}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '0.35rem',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                }}
              />
            </label>
          )}
          <button
            type="submit"
            className="btn-primary"
            disabled={explorerBusy}
            style={{ alignSelf: 'flex-start', padding: '0.5rem 1rem' }}
          >
            {explorerBusy ? 'Sending…' : 'Send request'}
          </button>
        </form>
        {explorerError && (
          <p style={{ color: 'var(--color-status-error)', marginTop: '0.75rem' }}>
            {explorerError}
          </p>
        )}
        {explorerResponse && (
          <pre
            style={{
              marginTop: '1rem',
              padding: '0.85rem',
              background: 'var(--color-border-lightest)',
              borderRadius: 8,
              overflow: 'auto',
              fontSize: '0.8rem',
            }}
          >
            {explorerResponse}
          </pre>
        )}
      </section>

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>API keys</h2>
        {revealedKey && (
          <div
            style={{
              background: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              padding: '0.85rem',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <strong>Copy now:</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>
              {revealedKey}
            </pre>
          </div>
        )}
        <form
          onSubmit={createKey}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <label htmlFor="new-key-label" className="sr-only">API key label</label>
          <input
            id="new-key-label"
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
            placeholder="Label"
            style={{ minWidth: '160px' }}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>Scopes:</span>
          {SCOPE_OPTIONS.map((sc) => (
            <label
              key={sc}
              style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
            >
              <input
                type="checkbox"
                checked={newKeyScopes.includes(sc)}
                onChange={() => toggleScope(sc)}
              />
              {sc}
            </label>
          ))}
          <button type="submit" className="btn-primary" style={{ padding: '0.45rem 0.9rem' }}>
            Create key
          </button>
        </form>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
              <th style={{ padding: '0.4rem' }}>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys
              .filter((k) => !k.revoked_at)
              .map((k) => (
                <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border-lighter)' }}>
                  <td style={{ padding: '0.45rem' }}>{k.label}</td>
                  <td>
                    <code>{k.key_prefix}</code>
                  </td>
                  <td>{(k.scopes || []).join(', ')}</td>
                  <td style={{ color: 'var(--color-text-hint)' }}>
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                      onClick={() => revokeKey(k.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>Webhooks</h2>
        {revealedSecret && (
          <div
            style={{
              background: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              padding: '0.85rem',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <strong>Signing secret (copy once):</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>
              {revealedSecret}
            </pre>
          </div>
        )}
        <form
          onSubmit={createHook}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            maxWidth: '520px',
            marginBottom: '1rem',
          }}
        >
          <label htmlFor="webhook-url" className="sr-only">Webhook URL</label>
          <input
            id="webhook-url"
            value={hookUrl}
            onChange={(e) => setHookUrl(e.target.value)}
            placeholder="https://example.com/crowdpay-webhook"
            required
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {EVENT_OPTIONS.map((ev) => (
              <label
                key={ev}
                style={{
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={hookEvents.includes(ev)}
                  onChange={() => toggleEvent(ev)}
                />
                {ev}
              </label>
            ))}
          </div>
          <button
            type="submit"
            className="btn-primary"
            style={{ padding: '0.5rem 1rem', alignSelf: 'flex-start' }}
          >
            Add endpoint
          </button>
        </form>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {hooks
            .filter((h) => !h.revoked_at)
            .map((h) => (
              <li
                key={h.id}
                style={{
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--color-border-lighter)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{h.url}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                    {(h.events || []).join(', ')} · {h.secret_hint}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                  onClick={() => revokeHook(h.id)}
                >
                  Remove
                </button>
              </li>
            ))}
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          Webhook delivery log
        </h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr
                style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}
              >
                <th style={{ padding: '0.35rem' }}>Time</th>
                <th>Event</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--color-border-lightest)' }}>
                  <td style={{ padding: '0.35rem', whiteSpace: 'nowrap' }}>
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td>{d.event_type}</td>
                  <td>{d.status}</td>
                  <td>{d.response_status ?? '—'}</td>
                  <td>{d.attempt_count}</td>
                  <td
                    style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={d.last_error || ''}
                  >
                    {d.last_error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          Credential activity log
        </h2>
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '1rem', fontSize: '0.85rem' }}>
          Append-only record of your API key and webhook credential events. Secret material is redacted.
        </p>
        {credentialsActivity.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>No credential activity recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
                  <th style={{ padding: '0.35rem' }}>Action</th>
                  <th>Resource</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {credentialsActivity.map((event) => (
                  <tr key={event.id} style={{ borderBottom: '1px solid var(--color-border-lightest)' }}>
                    <td style={{ padding: '0.35rem' }}>{event.action}</td>
                    <td style={{ padding: '0.35rem' }}>{event.resourceType}</td>
                    <td style={{ padding: '0.35rem' }}>
                      {new Date(event.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}