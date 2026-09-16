import { Link } from 'react-router-dom';
import type { AdminToken } from './useAdminToken';
import { TokenForm } from './parts';

/**
 * Console header. The token affordance is a native <details> -- keyboard
 * operable with no JS and no focus trap, which suits a repo with no UI deps.
 */
export default function InternalHeader({ admin }: { admin: AdminToken }) {
  const unlocked = admin.token !== '';
  return (
    <header className="console-head">
      <strong className="console-brand">Funnel Runtime</strong>
      {/* reloadDocument: a client-side transition would start a session in a half-booted app. */}
      <Link to="/" reloadDocument className="console-link">
        Funnel
      </Link>
      <details className="token-menu">
        <summary className={unlocked ? 'token-summary token-unlocked' : 'token-summary'}>
          <span className="token-dot" aria-hidden="true" />
          Admin · {unlocked ? 'unlocked' : 'locked'}
        </summary>
        <div className="token-panel card">
          <p className="muted token-panel-lead">
            {unlocked
              ? 'Publishing, activating and rollback are unlocked for this browser tab.'
              : 'Enter the admin token to publish, activate or roll back versions. Analytics need no token.'}
          </p>
          <TokenForm token={admin.token} onSave={admin.setToken} onClear={admin.clearToken} />
        </div>
      </details>
    </header>
  );
}
