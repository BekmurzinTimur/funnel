import { NavLink } from 'react-router-dom';

/** Header for internal pages (admin, dashboard). The funnel itself stays clean. */
export default function InternalNav() {
  return (
    <nav className="internal-nav">
      <strong>Funnel Runtime</strong>
      <NavLink to="/" reloadDocument>
        Funnel
      </NavLink>
      <NavLink to="/admin">Admin</NavLink>
      <NavLink to="/dashboard">Dashboard</NavLink>
    </nav>
  );
}
