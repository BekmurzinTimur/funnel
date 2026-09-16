import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { ActivateResponse, PublishResponse, VersionListResponse, VersionSummary } from '@shared/api';
import { authHeaders, describeError, errorBody, requestJson, requestText } from '../../lib/http';
import { formatDate } from '../format';
import { Pill, SectionCard, TokenForm } from '../parts';
import type { AdminToken } from '../useAdminToken';

// SPEC §5: publish, activate, rollback. Mounted only when a token exists, so an
// anonymous visitor never issues an /api/admin request.

type PublishStatus =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string; details?: string[] };

export default function VersionAdmin({ admin }: { admin: AdminToken }) {
  const { token } = admin;
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [openJson, setOpenJson] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

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

  const loadFile = async (file: File) => {
    setDraft(await file.text());
    setFileName(file.name);
    setPublishStatus({ kind: 'idle' });
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadFile(file);
    event.target.value = '';
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) await loadFile(file);
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

  // A rejected token: keep it in state so it can be corrected, not retyped.
  const rejected = listError !== null && versions === null;

  return (
    <div className="stack">
      <SectionCard
        title="Stored versions"
        subtitle="Publishing stores a version without activating it. Activating a lower version is a rollback. Sessions stay pinned to the version they started on."
        actions={
          <button type="button" onClick={() => void loadVersions()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        {listError && (
          <div role="alert">
            <p className="error">{listError}</p>
            {rejected && <TokenForm token={admin.token} onSave={admin.setToken} onClear={admin.clearToken} />}
          </div>
        )}
        {actionMessage && (
          <p className={actionMessage.kind === 'error' ? 'error' : 'success-text'} role="status">
            {actionMessage.text}
          </p>
        )}
        {versions && versions.length === 0 && <p className="muted">No versions stored.</p>}
        {versions && versions.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
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
                        <td className="nowrap">
                          v{v.version}
                          {v.isActive && <Pill>active</Pill>}
                        </td>
                        <td>{v.title ?? <span className="muted">—</span>}</td>
                        <td className="nowrap">{formatDate(v.createdAt)}</td>
                        <td>
                          {v.liveSessions} / {v.totalSessions}
                        </td>
                        <td>
                          <div className="row-actions">
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
                          <td colSpan={columns} className="json-cell">
                            <pre className="json-view">{openJson[key]}</pre>
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
      </SectionCard>

      <SectionCard
        title="Publish a new version"
        subtitle={
          <>
            Drop a <code>.json</code> file or paste a config. Its <code>version</code> must be greater than every stored
            version of that funnel. Publishing does not activate it.
          </>
        }
      >
        <div
          className={dragging ? 'dropzone dropzone-over' : 'dropzone'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void onDrop(e)}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label="Load config file"
            className="dropzone-input"
            onChange={(e) => void onFile(e)}
          />
          <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
            Choose a .json file
          </button>
          <p className="muted dropzone-hint">or drop one here</p>
          {fileName && (
            <p className="dropzone-file" role="status">
              Loaded <code>{fileName}</code>
            </p>
          )}
        </div>

        <textarea
          aria-label="Funnel config JSON"
          spellCheck={false}
          placeholder='{ "schemaVersion": "1.0", "funnelId": "…", "version": 3, … }'
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setFileName(null);
            setPublishStatus({ kind: 'idle' });
          }}
        />
        <div className="publish-bar">
          <button type="button" className="primary" disabled={publishing || draft.trim() === ''} onClick={() => void publish()}>
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
          {draft !== '' && (
            <button
              type="button"
              onClick={() => {
                setDraft('');
                setFileName(null);
                setPublishStatus({ kind: 'idle' });
              }}
            >
              Clear
            </button>
          )}
        </div>
        {publishStatus.kind === 'success' && (
          <p className="success-text" role="status">
            {publishStatus.message}
          </p>
        )}
        {publishStatus.kind === 'error' && (
          <div role="alert">
            <p className="error no-margin-bottom">{publishStatus.message}</p>
            {publishStatus.details && publishStatus.details.length > 0 && (
              <ul className="detail-list error">
                {publishStatus.details.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
