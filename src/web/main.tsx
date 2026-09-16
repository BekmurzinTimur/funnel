import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import FunnelPage from './funnel/FunnelPage';
import InternalPage from './internal/InternalPage';
import { withParams, type TabId } from './internal/tabs';
import './styles.css';

/**
 * /admin predates the merged console and is documented in the README and SPEC,
 * so it keeps working as a deep link to the Versions tab. Location-aware on
 * purpose: a bare <Navigate to="/dashboard?tab=versions"> would silently drop
 * any ?version= or ?utm_campaign= the visitor arrived with.
 */
function TabRedirect({ tab }: { tab: TabId }) {
  const location = useLocation();
  const search = withParams(new URLSearchParams(location.search), { tab }).toString();
  return <Navigate to={{ pathname: '/dashboard', search: search ? `?${search}` : '' }} replace />;
}

// No React.StrictMode: its double-invoked effects would create two sessions on ?reset=1
// and double-emit step_viewed in development.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/dashboard" element={<InternalPage />} />
      <Route path="/admin" element={<TabRedirect tab="versions" />} />
      <Route path="*" element={<FunnelPage />} />
    </Routes>
  </BrowserRouter>,
);
