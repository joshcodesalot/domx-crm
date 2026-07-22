import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, ShieldCheck, X } from 'lucide-react';
import { getCreatorCredentials, type Creator } from '@/lib/api';
import {
  uploadRefreshedCreatorSession,
  type CapturedCreatorSession,
} from '@/lib/localMaloumSession';
import type { BrowserBounds } from '@/types/electron';

function measureBounds(el: HTMLElement | null): BrowserBounds | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return null;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

interface ChatterRevalidateLoginModalProps {
  creator: Creator;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ChatterRevalidateLoginModal({
  creator,
  onClose,
  onSuccess,
}: ChatterRevalidateLoginModalProps) {
  const [loginError, setLoginError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [manualLoginMode, setManualLoginMode] = useState(false);

  const browserContainerRef = useRef<HTMLDivElement | null>(null);
  const completingManualLoginRef = useRef(false);
  const accountId = creator.accountId;

  const hideLoginBrowser = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.hideLoginBrowser();
    } catch {
      // Best-effort cleanup
    }
    setBrowserVisible(false);
    setManualLoginMode(false);
  }, []);

  const syncLoginBrowserBounds = useCallback(() => {
    const bounds = measureBounds(browserContainerRef.current);
    if (!bounds || !window.electronAPI) return;
    void window.electronAPI.resizeLoginBrowser(bounds);
  }, []);

  const finalizeCapturedSession = useCallback(
    async (captured: CapturedCreatorSession & { accountId?: string }) => {
      if (!accountId) {
        throw new Error('Session is not ready. Please try again.');
      }

      await uploadRefreshedCreatorSession(creator.id, accountId, captured);
      await hideLoginBrowser();
      onSuccess();
      onClose();
    },
    [accountId, creator.id, hideLoginBrowser, onClose, onSuccess]
  );

  const completeManualLogin = useCallback(async () => {
    if (!window.electronAPI || !accountId || completingManualLoginRef.current) {
      return;
    }

    completingManualLoginRef.current = true;
    setConnecting(true);
    setLoginError(null);

    try {
      syncLoginBrowserBounds();
      const captured = await window.electronAPI.completeLoginCaptureFromActiveLogin(accountId);
      await finalizeCapturedSession(captured);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to complete login');
    } finally {
      completingManualLoginRef.current = false;
      setConnecting(false);
    }
  }, [accountId, finalizeCapturedSession, syncLoginBrowserBounds]);

  useEffect(() => {
    if (!manualLoginMode || !window.electronAPI || !accountId) return;

    const unsubscribe = window.electronAPI.onLoginDetected(() => {
      void completeManualLogin();
    });

    return unsubscribe;
  }, [manualLoginMode, accountId, completeManualLogin]);

  useLayoutEffect(() => {
    if (!browserVisible || !window.electronAPI) return;

    syncLoginBrowserBounds();
    const observer = new ResizeObserver(syncLoginBrowserBounds);
    if (browserContainerRef.current) {
      observer.observe(browserContainerRef.current);
    }
    window.addEventListener('resize', syncLoginBrowserBounds);
    const unsubscribe = window.electronAPI.onWindowResized(syncLoginBrowserBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncLoginBrowserBounds);
      unsubscribe();
    };
  }, [browserVisible, syncLoginBrowserBounds]);

  useEffect(() => {
    if (!window.electronAPI || !accountId) {
      return;
    }

    let cancelled = false;

    async function attemptLogin() {
      setConnecting(true);
      setLoginError(null);
      setManualLoginMode(false);

      try {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const bounds = measureBounds(browserContainerRef.current);
        if (!bounds) {
          throw new Error('Login browser area is not ready. Please try again.');
        }

        let email = creator.loginEmail || '';
        let password = '';

        try {
          const credentials = await getCreatorCredentials(creator.id);
          email = credentials.loginEmail || email;
          password = credentials.loginPassword || '';
        } catch {
          // Fall back to manual login when credentials are unavailable.
        }

        setBrowserVisible(true);

        if (email.trim() && password) {
          try {
            const captured = await window.electronAPI!.loginAndCaptureMaloumSession({
              accountId,
              email: email.trim(),
              password,
              bounds,
            });
            await finalizeCapturedSession(captured);
            return;
          } catch (err) {
            if (cancelled) {
              return;
            }

            setManualLoginMode(true);
            setLoginError(
              err instanceof Error
                ? `${err.message} Complete login in the browser below, then press Continue after login.`
                : 'Automatic login failed. Complete login in the browser below, then press Continue after login.'
            );
            syncLoginBrowserBounds();
            return;
          }
        }

        setManualLoginMode(true);
        await window.electronAPI!.showLoginBrowser({ accountId, bounds });
        setLoginError(
          'No saved credentials for automatic login. Sign in manually below, then press Continue after login.'
        );
      } catch (err) {
        if (!cancelled) {
          setLoginError(
            err instanceof Error ? err.message : 'Failed to open Maloum login browser'
          );
        }
      } finally {
        if (!cancelled) {
          setConnecting(false);
        }
      }
    }

    void attemptLogin();

    return () => {
      cancelled = true;
      void hideLoginBrowser();
    };
  }, [
    accountId,
    creator.id,
    creator.loginEmail,
    finalizeCapturedSession,
    hideLoginBrowser,
    syncLoginBrowserBounds,
  ]);

  async function handleClose() {
    await hideLoginBrowser();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={() => void handleClose()}
      />

      <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-3xl border border-gray-200 dark:border-white/10 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-6 pb-4 border-b border-gray-100 dark:border-white/10">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-brand-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Sign in to Maloum</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Revalidate the session for {creator.displayName} by signing in below.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-4">
          {loginError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg text-sm text-red-800 dark:text-red-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          <div
            ref={browserContainerRef}
            className={`relative w-full rounded-lg border border-gray-200 dark:border-white/10 overflow-hidden bg-[#f8f9fa] dark:bg-[#0d0d0d] ${
              browserVisible || manualLoginMode ? 'min-h-[420px]' : 'min-h-[240px]'
            }`}
          >
            {!browserVisible && !manualLoginMode && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                {connecting ? 'Signing in to Maloum…' : 'Preparing login browser…'}
              </div>
            )}
          </div>

          {manualLoginMode && (
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => void handleClose()}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void completeManualLogin()}
                disabled={connecting}
                className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
              >
                {connecting ? 'Saving session…' : 'Continue after login'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
