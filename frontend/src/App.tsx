import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ForcedUpdateOverlay from '@/components/ForcedUpdateOverlay';
import PermissionRoute from '@/components/PermissionRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { ConfirmDialogProvider } from '@/context/ConfirmDialogContext';
import { StaffSyncProvider } from '@/context/StaffSyncContext';
import { CreatorBootProvider } from '@/context/CreatorBootContext';
import { ToastProvider } from '@/context/ToastContext';
import ChangePassword from '@/pages/ChangePassword';
import Dashboard from '@/pages/Dashboard';
import Login from '@/pages/Login';
import SetupOwner from '@/pages/SetupOwner';
import ManageCreators from '@/pages/ManageCreators';
import ManageStaff from '@/pages/ManageStaff';
import ChatterMaloum from '@/pages/ChatterMaloum';
import Chatter4Based from '@/pages/Chatter4Based';
import MaloumMassMessage from '@/pages/MaloumMassMessage';
import MaloumFanScraper from '@/pages/MaloumFanScraper';
import FourBasedFanScraper from '@/pages/FourBasedFanScraper';
import FourBasedMassMessage from '@/pages/FourBasedMassMessage';
import MaloumAiBulkReply from '@/pages/MaloumAiBulkReply';
import FourBasedAiBulkReply from '@/pages/FourBasedAiBulkReply';
import MaloumNotifications from '@/pages/MaloumNotifications';
import FourBasedNotifications from '@/pages/FourBasedNotifications';
import MessagePro from '@/pages/MessagePro';
import MessagePro4Based from '@/pages/MessagePro4Based';
import MessagingDashboard from '@/pages/MessagingDashboard';
import KeywordModeration from '@/pages/KeywordModeration';
import ModerationAlertsListener from '@/components/ModerationAlertsListener';
import ActivityHeartbeatListener from '@/components/ActivityHeartbeatListener';

/**
 * Keeps the 4based chat panel mounted after first visit so loaded chats/media
 * are never unloaded when switching tabs. Hidden via CSS when not on the route.
 */
function PersistentFourBasedPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/chatter/4based';
  const canView = isAuthenticated && hasPermission('creators.view');

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

/**
 * Keeps Maloum API chat mounted after first visit (same pattern as 4based).
 */
function PersistentMaloumPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/chatter';
  const canView = isAuthenticated && hasPermission('creators.view');

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
      <ChatterMaloum />
    </div>
  );
}

/**
 * Keeps Message Pro workspaces mounted after first visit.
 */
function PersistentMessageProPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/message-pro';
  const canView = isAuthenticated && hasPermission('creators.view');

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
      <MessagePro />
    </div>
  );
}

/**
 * Keeps 4based Message Pro workspaces mounted after first visit.
 */
function PersistentMessagePro4BasedPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/message-pro/4based';
  const canView = isAuthenticated && hasPermission('creators.view');

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
      <MessagePro4Based />
    </div>
  );
}

function AppRoutes() {
  return (
    <HashRouter>
      <StaffSyncProvider>
        <PersistentFourBasedPanel />
        <PersistentMaloumPanel />
        <PersistentMessageProPanel />
        <PersistentMessagePro4BasedPanel />
        <ModerationAlertsListener />
        <ActivityHeartbeatListener />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<SetupOwner />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<CreatorBootProvider />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route element={<PermissionRoute permission="analytics.view" />}>
                <Route path="/dashboard/messaging" element={<MessagingDashboard />} />
              </Route>
              <Route element={<PermissionRoute permission="staff.view" />}>
                <Route path="/staff/manage" element={<ManageStaff />} />
              </Route>
              <Route
                element={
                  <PermissionRoute
                    anyOf={['moderation.manage', 'moderation.review']}
                  />
                }
              >
                <Route path="/staff/moderation" element={<KeywordModeration />} />
              </Route>
              <Route element={<PermissionRoute permission="creators.view" />}>
                {/* Placeholder — real panel is mounted by PersistentMaloumPanel */}
                <Route path="/chatter" element={null} />
                {/* Placeholder — real panel is mounted by PersistentFourBasedPanel */}
                <Route path="/chatter/4based" element={null} />
                {/* Placeholder — real panel is mounted by PersistentMessageProPanel */}
                <Route path="/message-pro" element={null} />
                {/* Placeholder — real panel is mounted by PersistentMessagePro4BasedPanel */}
                <Route path="/message-pro/4based" element={null} />
                <Route
                  path="/chatter/maloum/notifications"
                  element={<MaloumNotifications />}
                />
                <Route
                  path="/chatter/4based/notifications"
                  element={<FourBasedNotifications />}
                />
              </Route>
              <Route element={<PermissionRoute permission="mass_messages.send" />}>
                <Route path="/chatter/maloum/mass-message" element={<MaloumMassMessage />} />
                <Route
                  path="/chatter/maloum/fan-scraper"
                  element={<MaloumFanScraper />}
                />
                <Route
                  path="/chatter/4based/mass-message"
                  element={<FourBasedMassMessage />}
                />
                <Route
                  path="/chatter/4based/fan-scraper"
                  element={<FourBasedFanScraper />}
                />
                <Route
                  path="/chatter/maloum/ai-bulk-reply"
                  element={<MaloumAiBulkReply />}
                />
                <Route
                  path="/chatter/4based/ai-bulk-reply"
                  element={<FourBasedAiBulkReply />}
                />
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
      <ToastProvider>
        <ConfirmDialogProvider>
          <ForcedUpdateOverlay />
          <AppRoutes />
        </ConfirmDialogProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
