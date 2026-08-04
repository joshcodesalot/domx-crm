import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

interface PermissionRouteProps {
  permission?: string;
  anyOf?: string[];
}

export default function PermissionRoute({
  permission,
  anyOf,
}: PermissionRouteProps) {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-[#0a0a0a]">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const allowed = anyOf?.length
    ? anyOf.some((slug) => hasPermission(slug))
    : permission
      ? hasPermission(permission)
      : false;

  if (!allowed) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
