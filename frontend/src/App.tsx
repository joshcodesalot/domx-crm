import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import ForcedUpdateOverlay from '@/components/ForcedUpdateOverlay';
import PermissionRoute from '@/components/PermissionRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider } from '@/context/AuthContext';
import { StaffSyncProvider } from '@/context/StaffSyncContext';
import { CreatorBootProvider } from '@/context/CreatorBootContext';
import ChangePassword from '@/pages/ChangePassword';
import Dashboard from '@/pages/Dashboard';
import Login from '@/pages/Login';
import SetupOwner from '@/pages/SetupOwner';
import ManageCreators from '@/pages/ManageCreators';
import ManageStaff from '@/pages/ManageStaff';
import Chatter from '@/pages/Chatter';
import MessagingDashboard from '@/pages/MessagingDashboard';

function AppRoutes() {
  return (
    <BrowserRouter>
      <StaffSyncProvider>
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
              <Route element={<PermissionRoute permission="creators.view" />}>
                <Route path="/creators/manage" element={<ManageCreators />} />
                <Route path="/chatter" element={<Chatter />} />
              </Route>
            </Route>
          </Route>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </StaffSyncProvider>
    </BrowserRouter>
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
