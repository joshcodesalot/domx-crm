import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ForcedUpdateOverlay from '@/components/ForcedUpdateOverlay';
import PermissionRoute from '@/components/PermissionRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { StaffSyncProvider } from '@/context/StaffSyncContext';
import { CreatorBootProvider } from '@/context/CreatorBootContext';
import ChangePassword from '@/pages/ChangePassword';
import Dashboard from '@/pages/Dashboard';
import Login from '@/pages/Login';
import SetupOwner from '@/pages/SetupOwner';
import ManageCreators from '@/pages/ManageCreators';
import ManageStaff from '@/pages/ManageStaff';
import Chatter from '@/pages/Chatter';
import Chatter4Based from '@/pages/Chatter4Based';
import MessagePro from '@/pages/MessagePro';
import MessagingDashboard from '@/pages/MessagingDashboard';

/**
 * Keeps the 4based chat panel mounted after first visit so loaded chats/media
 * are never unloaded when switching tabs. Hidden via CSS when not on the route.
 */
function PersistentFourBasedPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/chatter/4based';
  const canView =
    isAuthenticated && hasPermission('creators.view');

  useEffect(() => {
    if (isActive && canView) {
      setEverOpened(true);
    }
  }, [isActive, canView]);

  useEffect(() => {
    if (!canView) {
      setEverOpened(false);
    }
  }, [canView]);

  if (!everOpened || !canView) {
    return null;
  }

  return (
    <div
      className={isActive ? 'contents' : 'hidden'}
      aria-hidden={!isActive}
      style={isActive ? undefined : { display: 'none' }}
    >
      <Chatter4Based />
    </div>
  );
}

function AppRoutes() {
  return (
    <HashRouter>
      <StaffSyncProvider>
        <PersistentFourBasedPanel />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<SetupOwner />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<PermissionRoute permission="creators.view" />}>
              <Route path="/message-pro" element={<MessagePro />} />
            </Route>
            <Route element={<CreatorBootProvider />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route element={<PermissionRoute permission="analytics.view" />}>
                <Route path="/dashboard/messaging" element={<MessagingDashboard />} />
              </Route>
              <Route element={<PermissionRoute permission="staff.view" />}>
                <Route path="/staff/manage" element={<ManageStaff />} />
              </Route>
              <Route element={<PermissionRoute permission="creators.view" />}>
                <Route path="/chatter" element={<Chatter />} />
                {/* Placeholder — real panel is mounted by PersistentFourBasedPanel */}
                <Route path="/chatter/4based" element={null} />
              </Route>
              <Route element={<PermissionRoute permission="creators.manage" />}>
                <Route path="/creators/manage" element={<ManageCreators />} />
              </Route>
            </Route>
          </Route>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </StaffSyncProvider>
    </HashRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ForcedUpdateOverlay />
      <AppRoutes />
    </AuthProvider>
  );
}
