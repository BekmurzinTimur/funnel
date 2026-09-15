import { Fragment, useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ActivateResponse, ApiError, PublishResponse, VersionListResponse, VersionSummary } from '@shared/api';
import InternalNav from '../lib/InternalNav';
import { HttpError, requestJson } from '../lib/http';
import './admin.css';

// SPEC §5: version management page.

const TOKEN_KEY = 'funnel-admin-token';

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the token lives for this page view only.
  }
}

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

/** Sends text exactly as typed, so the server stores the config verbatim. */
async function requestText(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: string,
): Promise<{ text: string; data: unknown }> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? authHeaders(token) : { ...authHeaders(token), 'content-type': 'application/json' },
    body,
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; keep the text
  }
  if (!response.ok) throw new HttpError(response.status, data);
  return { text, data };
}

const errorBody = (err: unknown): Partial<ApiError> =>
  err instanceof HttpError && typeof err.body === 'object' && err.body !== null ? (err.body as Partial<ApiError>) : {};

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'The admin token was rejected.';
    return errorBody(err).message ?? errorBody(err).error ?? `Request failed (HTTP ${err.status}).`;
  }
  return err instanceof Error ? err.message : String(err);
}

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

type PublishStatus =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string; details?: string[] };

export default function AdminPage() {
  const [token, setToken] = useState(readStoredToken);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [openJson, setOpenJson] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({ kind: 'idle' });

  const loadVersions = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await requestJson<VersionListResponse>('GET', '/api/admin/versions', undefined, authHeaders(token));
      setVersions(data.versions);
      setListError(null);
    } catch (err) {
      setVersions(null);
      setListError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    const next = tokenDraft.trim();
    storeToken(next);
    setToken(next);
    setActionMessage(null);
    if (!next) {
      setVersions(null);
      setListError(null);
    }
  };

  const clearToken = () => {
    storeToken('');
    setToken('');
    setTokenDraft('');
    setVersions(null);
    setListError(null);
  };

  const keyOf = (v: VersionSummary) => `${v.funnelId}@${v.version}`;
  const query = (v: VersionSummary) => `?funnelId=${encodeURIComponent(v.funnelId)}`;
  const activeVersionOf = (funnelId: string) =>
    versions?.find((v) => v.funnelId === funnelId && v.isActive)?.version ?? null;

  const activate = async (v: VersionSummary, label: string) => {
    if (!window.confirm(`${label}? New sessions will start on v${v.version}; existing sessions stay on their version.`)) {
      return;
    }
    setBusyKey(keyOf(v));
    setActionMessage(null);
    try {
      const result = await requestJson<ActivateResponse>(
        'POST',
        `/api/admin/versions/${v.version}/activate${query(v)}`,
        undefined,
        authHeaders(token),
      );
      setActionMessage({ kind: 'success', text: `v${result.activeVersion} of ${result.funnelId} is now active.` });
      await loadVersions();
    } catch (err) {
      setActionMessage({ kind: 'error', text: describeError(err) });
    } finally {
      setBusyKey(null);
    }
  };

  const toggleJson = async (v: VersionSummary) => {
    const key = keyOf(v);
    if (key in openJson) {
      setOpenJson(({ [key]: _closed, ...rest }) => rest);
      return;
    }
    setBusyKey(key);
    try {
      const { text } = await requestText('GET', `/api/admin/versions/${v.version}${query(v)}`, token);
      setOpenJson((current) => ({ ...current, [key]: text }));
    } catch (err) {
      setActionMessage({ kind: 'error', text: describeError(err) });
    } finally {
      setBusyKey(null);
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setDraft(await file.text());
    setPublishStatus({ kind: 'idle' });
    event.target.value = '';
  };

  const publish = async () => {
    setPublishing(true);
    setPublishStatus({ kind: 'idle' });
    try {
      const { data } = await requestText('POST', '/api/admin/versions', token, draft);
      const result = data as PublishResponse;
      setPublishStatus({
        kind: 'success',
        message: `Stored ${result.funnelId} v${result.version}. It is not active yet — activate it from the table.`,
      });
      await loadVersions();
    } catch (err) {
      const body = errorBody(err);
      setPublishStatus({ kind: 'error', message: describeError(err), details: body.details });
    } finally {
      setPublishing(false);
    }
  };

  const multipleFunnels = new Set(versions?.map((v) => v.funnelId)).size > 1;
  const columns = multipleFunnels ? 6 : 5;
  const sorted = [...(versions ?? [])].sort((a, b) =>
    a.funnelId === b.funnelId ? b.version - a.version : a.funnelId.localeCompare(b.funnelId),
  );

  return (
    <main className="page page-wide">
      <InternalNav />
      <div className="admin-stack">
        <header>
          <h1>Funnel versions</h1>
          <p className="muted" style={{ margin: 0 }}>
            Publishing stores a version without activating it. Activating a lower version is a rollback. Sessions stay
            pinned to the version they started on.
          </p>
        </header>

        <section className="card" aria-labelledby="admin-token-heading">
          <h2 id="admin-token-heading">Admin token</h2>
          <form className="admin-token-form" onSubmit={saveToken}>
            <input
              type="password"
              aria-label="Admin token"
              placeholder="ADMIN_TOKEN"
              autoComplete="off"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <button type="submit" className="primary">
              Use token
            </button>
            {token && (
              <button type="button" onClick={clearToken}>
                Forget
              </button>
            )}
          </form>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>
            Kept in this tab&apos;s sessionStorage only.
          </p>
        </section>

        {token && (
          <section className="card" aria-labelledby="admin-versions-heading">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
              <h2 id="admin-versions-heading">Stored versions</h2>
              <button type="button" onClick={() => void loadVersions()} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            {listError && <p className="error">{listError}</p>}
            {actionMessage && (
              <p className={actionMessage.kind === 'error' ? 'error' : 'admin-success'} role="status">
                {actionMessage.text}
              </p>
            )}
            {versions && versions.length === 0 && <p className="muted">No versions stored.</p>}
            {versions && versions.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {multipleFunnels && <th>Funnel</th>}
                      <th>Version</th>
                      <th>Title</th>
                      <th>Created</th>
                      <th title="Live (within TTL) / total sessions pinned to this version">Sessions live / total</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((v) => {
                      const key = keyOf(v);
                      const active = activeVersionOf(v.funnelId);
                      const label =
                        active !== null && v.version < active ? `Roll back to v${v.version}` : `Activate v${v.version}`;
                      return (
                        <Fragment key={key}>
                          <tr>
                            {multipleFunnels && <td>{v.funnelId}</td>}
                            <td style={{ whiteSpace: 'nowrap' }}>
                              v{v.version}
                              {v.isActive && <span className="admin-badge">Active</span>}
                            </td>
                            <td>{v.title ?? <span className="muted">—</span>}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDate(v.createdAt)}</td>
                            <td>
                              {v.liveSessions} / {v.totalSessions}
                            </td>
                            <td>
                              <div className="admin-row-actions">
                                {!v.isActive && (
                                  <button
                                    type="button"
                                    className="primary"
                                    disabled={busyKey !== null}
                                    onClick={() => void activate(v, label)}
                                  >
                                    {label}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={busyKey === key}
                                  aria-expanded={key in openJson}
                                  onClick={() => void toggleJson(v)}
                                >
                                  {key in openJson ? 'Hide JSON' : 'View JSON'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          {key in openJson && (
                            <tr>
                              <td colSpan={columns} className="admin-json-cell">
                                <pre className="admin-json">{openJson[key]}</pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {token && (
          <section className="card admin-publish" aria-labelledby="admin-publish-heading">
            <h2 id="admin-publish-heading">Publish a new version</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Paste a funnel config or load a .json file. Its <code>version</code> must be greater than every stored
              version of that funnel. Publishing does not activate it.
            </p>
            <textarea
              aria-label="Funnel config JSON"
              spellCheck={false}
              placeholder='{ "schemaVersion": "1.0", "funnelId": "…", "version": 3, … }'
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setPublishStatus({ kind: 'idle' });
              }}
            />
            <div className="admin-publish-bar">
              <input type="file" accept=".json,application/json" aria-label="Load config file" onChange={(e) => void onFile(e)} />
              <button type="button" className="primary" disabled={publishing || draft.trim() === ''} onClick={() => void publish()}>
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
            {publishStatus.kind === 'success' && (
              <p className="admin-success" role="status">
                {publishStatus.message}
              </p>
            )}
            {publishStatus.kind === 'error' && (
              <div role="alert">
                <p className="error" style={{ marginBottom: 0 }}>
                  {publishStatus.message}
                </p>
                {publishStatus.details && publishStatus.details.length > 0 && (
                  <ul className="admin-details error">
                    {publishStatus.details.map((detail, i) => (
                      <li key={i}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
