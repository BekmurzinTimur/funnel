import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AdminPage from './admin/AdminPage';
import DashboardPage from './dashboard/DashboardPage';
import FunnelPage from './funnel/FunnelPage';
import './styles.css';

// No React.StrictMode: its double-invoked effects would create two sessions on ?reset=1
// and double-emit step_viewed in development.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="*" element={<FunnelPage />} />
    </Routes>
  </BrowserRouter>,
);
