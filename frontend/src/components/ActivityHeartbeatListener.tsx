import { useAuth } from '@/context/AuthContext';
import { useActivityHeartbeat } from '@/hooks/useActivityHeartbeat';

/** Mounts activity heartbeats for any authenticated session. */
export default function ActivityHeartbeatListener() {
  const { isAuthenticated, isLoading } = useAuth();
  useActivityHeartbeat(isAuthenticated && !isLoading);
  return null;
}
