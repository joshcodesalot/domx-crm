import { useEffect, useRef } from 'react';
import { postActivityHeartbeat } from '@/lib/api';

const HEARTBEAT_INTERVAL_MS = 30_000;
const INPUT_THROTTLE_MS = 1_000;

/**
 * Silently reports click/keydown activity so managers can see online/idle/away.
 * Mount once while authenticated — does not log key content.
 * Intentionally ignores mousemove (easy to fake with idle mouse jiggle).
 */
export function useActivityHeartbeat(enabled: boolean): void {
  const lastInputAtRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let throttleTimer: number | null = null;
    let pendingMark = false;

    const markInput = () => {
      pendingMark = true;
      if (throttleTimer != null) return;
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
        if (pendingMark) {
          lastInputAtRef.current = Date.now();
          pendingMark = false;
        }
      }, INPUT_THROTTLE_MS);
    };

    const events = ['keydown', 'click'] as const;

    for (const eventName of events) {
      window.addEventListener(eventName, markInput, { passive: true });
    }

    const sendHeartbeat = () => {
      if (!enabledRef.current) return;

      const lastInputAt = lastInputAtRef.current;
      const payload =
        lastInputAt != null ? new Date(lastInputAt).toISOString() : null;

      void postActivityHeartbeat({ lastInputAt: payload }).catch(() => {
        // Silent — presence is best-effort
      });
    };

    // Immediate heartbeat on mount so presence flips quickly after login
    sendHeartbeat();
    const intervalId = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Heartbeat only — do not treat tab focus as real activity
        sendHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, markInput);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(intervalId);
      if (throttleTimer != null) {
        window.clearTimeout(throttleTimer);
      }
    };
  }, [enabled]);
}
