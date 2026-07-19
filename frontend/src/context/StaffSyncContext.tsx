import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { clearToken, getToken } from '@/lib/api';
import { getApiUrl } from '@/lib/apiConfig';
import type { StaffSyncEvent } from '@/types/electron';

const API_URL = getApiUrl();
const SESSION_EXPIRED_EVENT = 'domx:session-expired';
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

interface StaffSyncContextValue {
  onSyncEvent: (callback: (event: StaffSyncEvent) => void) => () => void;
}

const StaffSyncContext = createContext<StaffSyncContextValue | null>(null);

function parseSseChunk(buffer: string): { events: StaffSyncEvent[]; remainder: string } {
  const events: StaffSyncEvent[] = [];
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() ?? '';

  for (const part of parts) {
    const lines = part.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue;
      }

      const payload = line.slice(6).trim();
      if (!payload) {
        continue;
      }

      try {
        events.push(JSON.parse(payload) as StaffSyncEvent);
      } catch {
        // Ignore malformed SSE payloads
      }
    }
  }

  return { events, remainder };
}

export function StaffSyncProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();
  const listenersRef = useRef(new Set<(event: StaffSyncEvent) => void>());
  const reconnectAttemptRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const handlingDeactivationRef = useRef(false);

  const notifyListeners = useCallback((event: StaffSyncEvent) => {
    for (const listener of listenersRef.current) {
      listener(event);
    }
  }, []);

  const handleAccountDeactivated = useCallback(
    async (reason = 'Your account has been deactivated.') => {
      if (handlingDeactivationRef.current) {
        return;
      }

      handlingDeactivationRef.current = true;

      try {
        if (window.electronAPI?.releaseAllCreatorChats) {
          await window.electronAPI.releaseAllCreatorChats();
        }

        clearToken();
        await logout();
        navigate('/login', {
          replace: true,
          state: { reason },
        });
      } finally {
        handlingDeactivationRef.current = false;
      }
    },
    [logout, navigate]
  );

  const handleSyncEvent = useCallback(
    async (event: StaffSyncEvent) => {
      if (event.type === 'account:deactivated') {
        await handleAccountDeactivated();
        return;
      }

      if (event.type === 'creator:access-revoked' && event.accountId) {
        if (window.electronAPI?.clearSession) {
          await window.electronAPI.clearSession(event.accountId);
        } else if (window.electronAPI?.releaseCreatorChat) {
          await window.electronAPI.releaseCreatorChat(event.accountId);
        }
      }

      notifyListeners(event);
    },
    [handleAccountDeactivated, notifyListeners]
  );

  const onSyncEvent = useCallback((callback: (event: StaffSyncEvent) => void) => {
    listenersRef.current.add(callback);
    return () => {
      listenersRef.current.delete(callback);
    };
  }, []);

  useEffect(() => {
    function onSessionExpired() {
      void handleAccountDeactivated('Your session has expired. Please sign in again.');
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    };
  }, [handleAccountDeactivated]);

  useEffect(() => {
    if (!isAuthenticated) {
      abortRef.current?.abort();
      abortRef.current = null;
      reconnectAttemptRef.current = 0;
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | undefined;

    async function connect() {
      if (cancelled) {
        return;
      }

      const token = getToken();
      if (!token) {
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(`${API_URL}/api/events/stream`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (response.status === 401) {
          clearToken();
          window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
          return;
        }

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed (${response.status})`);
        }

        reconnectAttemptRef.current = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.remainder;

          for (const event of parsed.events) {
            await handleSyncEvent(event);
          }
        }
      } catch (err) {
        if (controller.signal.aborted || cancelled) {
          return;
        }
      }

      if (cancelled) {
        return;
      }

      const delay = Math.min(
        INITIAL_RECONNECT_MS * 2 ** reconnectAttemptRef.current,
        MAX_RECONNECT_MS
      );
      reconnectAttemptRef.current += 1;
      reconnectTimer = window.setTimeout(() => {
        void connect();
      }, delay);
    }

    void connect();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
    };
  }, [isAuthenticated, handleSyncEvent]);

  const value = useMemo(() => ({ onSyncEvent }), [onSyncEvent]);

  return <StaffSyncContext.Provider value={value}>{children}</StaffSyncContext.Provider>;
}

export function useStaffSync(): StaffSyncContextValue {
  const context = useContext(StaffSyncContext);
  if (!context) {
    throw new Error('useStaffSync must be used within StaffSyncProvider');
  }
  return context;
}

export { SESSION_EXPIRED_EVENT };
