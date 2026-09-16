import { Link } from 'react-router-dom';

/** Console header. The console is open: no sign-in, no token. */
export default function InternalHeader() {
  return (
    <header className="console-head">
      <strong className="console-brand">Funnel Runtime</strong>
      {/* reloadDocument: a client-side transition would start a session in a half-booted app. */}
      <Link to="/" reloadDocument className="console-link">
        Funnel
      </Link>
    </header>
  );
}
