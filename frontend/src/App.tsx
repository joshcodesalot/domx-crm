import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ForcedUpdateOverlay from '@/components/ForcedUpdateOverlay';
import PermissionRoute from '@/components/PermissionRoute';
import RoleRoute from '@/components/RoleRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { ConfirmDialogProvider } from '@/context/ConfirmDialogContext';
import { StaffSyncProvider } from '@/context/StaffSyncContext';
import { CreatorBootProvider } from '@/context/CreatorBootContext';
import { CreatorLiveProvider } from '@/context/CreatorLiveContext';
import { ToastProvider } from '@/context/ToastContext';
import ChangePassword from '@/pages/ChangePassword';
import Login from '@/pages/Login';
import SetupOwner from '@/pages/SetupOwner';
import ModerationAlertsListener from '@/components/ModerationAlertsListener';
import ActivityHeartbeatListener from '@/components/ActivityHeartbeatListener';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const ManageCreators = lazy(() => import('@/pages/ManageCreators'));
const ManageStaff = lazy(() => import('@/pages/ManageStaff'));
const ChatterMaloum = lazy(() => import('@/pages/ChatterMaloum'));
const Chatter4Based = lazy(() => import('@/pages/Chatter4Based'));
const ChatterTelegram = lazy(() => import('@/pages/ChatterTelegram'));
const MaloumMassMessage = lazy(() => import('@/pages/MaloumMassMessage'));
const MaloumFeed = lazy(() => import('@/pages/MaloumFeed'));
const MaloumFanScraper = lazy(() => import('@/pages/MaloumFanScraper'));
const MaloumLists = lazy(() => import('@/pages/MaloumLists'));
const FourBasedFanScraper = lazy(() => import('@/pages/FourBasedFanScraper'));
const FourBasedMassMessage = lazy(() => import('@/pages/FourBasedMassMessage'));
const FourBasedFeed = lazy(() => import('@/pages/FourBasedFeed'));
const ContentSchedule = lazy(() => import('@/pages/ContentSchedule'));
const MaloumAiBulkReply = lazy(() => import('@/pages/MaloumAiBulkReply'));
const FourBasedAiBulkReply = lazy(() => import('@/pages/FourBasedAiBulkReply'));
const MaloumNotifications = lazy(() => import('@/pages/MaloumNotifications'));
const FourBasedNotifications = lazy(() => import('@/pages/FourBasedNotifications'));
const MessagePro = lazy(() => import('@/pages/MessagePro'));
const MessagePro4Based = lazy(() => import('@/pages/MessagePro4Based'));
const MessageProTelegram = lazy(() => import('@/pages/MessageProTelegram'));
const TelegramSextingSession = lazy(() => import('@/pages/TelegramSextingSession'));
const MessagingDashboard = lazy(() => import('@/pages/MessagingDashboard'));
const SalesLogs = lazy(() => import('@/pages/SalesLogs'));
const FalseSalesReview = lazy(() => import('@/pages/FalseSalesReview'));
const AnalyticsCharts = lazy(() => import('@/pages/AnalyticsCharts'));
const CreatorAnalytics = lazy(() => import('@/pages/CreatorAnalytics'));
const AccountSettings = lazy(() => import('@/pages/AccountSettings'));
const KeywordModeration = lazy(() => import('@/pages/KeywordModeration'));

function PageFallback() {
  return (
    <div className="h-screen flex items-center justify-center bg-white dark:bg-zinc-950 text-sm text-gray-500 dark:text-zinc-500">
      Loading…
    </div>
  );
}

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

function PersistentTelegramPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/chatter/telegram';
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
      <ChatterTelegram />
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

function PersistentMessageProTelegramPanel() {
  const location = useLocation();
  const { isAuthenticated, hasPermission } = useAuth();
  const [everOpened, setEverOpened] = useState(false);

  const isActive = location.pathname === '/message-pro/telegram';
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
      <MessageProTelegram />
    </div>
  );
}

function AppRoutes() {
  return (
    <HashRouter>
      <StaffSyncProvider>
        <CreatorLiveProvider>
          <Suspense fallback={<PageFallback />}>
            <PersistentFourBasedPanel />
            <PersistentTelegramPanel />
            <PersistentMaloumPanel />
            <PersistentMessageProPanel />
            <PersistentMessagePro4BasedPanel />
            <PersistentMessageProTelegramPanel />
            <ModerationAlertsListener />
            <ActivityHeartbeatListener />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<SetupOwner />} />
              <Route path="/change-password" element={<ChangePassword />} />
              <Route element={<ProtectedRoute />}>
                <Route path="/account/settings" element={<AccountSettings />} />
                <Route element={<CreatorBootProvider />}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route element={<RoleRoute roles={['owner', 'manager']} />}>
                    <Route path="/dashboard/charts" element={<AnalyticsCharts />} />
                    <Route
                      path="/dashboard/creator-analytics"
                      element={<CreatorAnalytics />}
                    />
                    <Route path="/dashboard/false-sales" element={<FalseSalesReview />} />
                  </Route>
                  <Route element={<PermissionRoute permission="analytics.view" />}>
                    <Route path="/dashboard/messaging" element={<MessagingDashboard />} />
                    <Route path="/dashboard/sales-logs" element={<SalesLogs />} />
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
                    <Route path="/chatter" element={null} />
                    <Route path="/chatter/4based" element={null} />
                    <Route path="/chatter/telegram" element={null} />
                    <Route path="/message-pro" element={null} />
                    <Route path="/message-pro/4based" element={null} />
                    <Route path="/message-pro/telegram" element={null} />
                    <Route
                      path="/chatter/telegram/sexting-session"
                      element={<TelegramSextingSession />}
                    />
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
                    <Route path="/chatter/schedule" element={<ContentSchedule />} />
                    <Route path="/chatter/maloum/mass-message" element={<MaloumMassMessage />} />
                    <Route path="/chatter/maloum/feed" element={<MaloumFeed />} />
                    <Route
                      path="/chatter/maloum/fan-scraper"
                      element={<MaloumFanScraper />}
                    />
                    <Route path="/chatter/maloum/lists" element={<MaloumLists />} />
                    <Route
                      path="/chatter/4based/mass-message"
                      element={<FourBasedMassMessage />}
                    />
                    <Route path="/chatter/4based/feed" element={<FourBasedFeed />} />
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
          </Suspense>
        </CreatorLiveProvider>
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
