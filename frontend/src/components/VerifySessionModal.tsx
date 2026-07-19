import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, ShieldCheck, X } from 'lucide-react';
import {
  getCreatorCredentials,
  getCreatorSession,
  reconnectCreatorSession,
  saveCreatorAvatarFromMaloum,
  shouldFetchMaloumIcon,
  updateCreatorSessionValidation,
  type Creator,
} from '@/lib/api';
import type { BrowserBounds, PlaywrightCookie } from '@/types/electron';

const MALOUM_VERIFY_URL = 'https://app.maloum.com/profile';

function getBrowserBounds(element: HTMLElement | null): BrowserBounds | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function formatValidatedAt(value: string | null): string | null {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return null;
  }
}

function getCurrentDomXTheme(): 'dark' | 'light' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function isLoginRedirectReason(reason: string): boolean {
  return reason === 'Redirected to login' || reason === 'Redirected to login after profile check';
}

type VerifyPhase =
  | 'loading'
  | 'checking'
  | 'relogging'
  | 'returning'
  | 'success'
  | 'invalid'
  | 'error';

interface VerifySessionModalProps {
  creator: Creator;
  onClose: () => void;
  onValidated: () => void;
  onReconnect?: () => void;
}

export default function VerifySessionModal({
  creator,
  onClose,
  onValidated,
  onReconnect,
}: VerifySessionModalProps) {
  const [phase, setPhase] = useState<VerifyPhase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState(MALOUM_VERIFY_URL);
  const [sessionReady, setSessionReady] = useState(false);

  const browserContainerRef = useRef<HTMLDivElement>(null);
  const accountIdRef = useRef<string | null>(null);
  const loadStartedRef = useRef(false);
  const isElectron = Boolean(window.electronAPI?.isElectron);

  const syncBounds = useCallback(() => {
    if (!window.electronAPI || !accountIdRef.current || !sessionReady) return;
    const bounds = getBrowserBounds(browserContainerRef.current);
    if (bounds) {
      window.electronAPI.resizeVerifyBrowser(bounds);
    }
  }, [sessionReady]);

  const hideVerifyBrowser = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.hideVerifyBrowser();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function runVerification() {
      if (loadStartedRef.current) {
        return;
      }
      loadStartedRef.current = true;

      setPhase('loading');
      setMessage(null);
      setSessionReady(false);

      if (!isElectron) {
        setPhase('error');
        setMessage('Session verification requires the DomX desktop app.');
        return;
      }

      if (!creator.accountId) {
        setPhase('error');
        setMessage('No saved session for this creator. Reconnect the account.');
        return;
      }

      try {
        const session = await getCreatorSession(creator.id);

        if (!session.accountId || session.cookies.length === 0) {
          throw new Error('No saved session for this creator.');
        }

        accountIdRef.current = session.accountId;

        await window.electronAPI!.loadCreatorSession({
          accountId: session.accountId,
          cookies: session.cookies as PlaywrightCookie[],
          origins: session.origins,
          force: true,
          savedAt: session.sessionUpdatedAt,
        });

        const url = MALOUM_VERIFY_URL;
        setVerifyUrl(url);

        const bounds =
          getBrowserBounds(browserContainerRef.current) ||
          ({ x: 0, y: 0, width: 800, height: 500 } as BrowserBounds);

        await window.electronAPI!.showVerifyBrowser({
          accountId: session.accountId,
          bounds,
          url,
        });

        if (cancelled) return;

        setSessionReady(true);
        setPhase('checking');
        setMessage('Checking Maloum profile…');

        const verification = await window.electronAPI!.verifyMaloumSession({
          accountId: session.accountId,
          theme: getCurrentDomXTheme(),
          reuseVisibleView: true,
        });

        if (cancelled) return;

        let finalVerification = verification;

        if (
          !verification.verified &&
          isLoginRedirectReason(verification.reason)
        ) {
          try {
            setPhase('loading');
            setMessage('Pulling latest session from DomX…');

            const latestSession = await getCreatorSession(creator.id);
            if (latestSession.accountId && latestSession.cookies.length > 0) {
              await window.electronAPI!.loadCreatorSession({
                accountId: latestSession.accountId,
                cookies: latestSession.cookies as PlaywrightCookie[],
                origins: latestSession.origins,
                force: true,
                savedAt: latestSession.sessionUpdatedAt,
              });

              if (cancelled) return;

              setPhase('checking');
              setMessage('Re-checking with latest session…');

              finalVerification = await window.electronAPI!.verifyMaloumSession({
                accountId: latestSession.accountId,
                theme: getCurrentDomXTheme(),
                reuseVisibleView: true,
              });

              if (cancelled) return;
            }

            if (
              !finalVerification.verified &&
              isLoginRedirectReason(finalVerification.reason)
            ) {
              const credentials = await getCreatorCredentials(creator.id);

              if (cancelled) return;

              setPhase('relogging');
              setMessage('Session expired — logging in again…');

              const captured = await window.electronAPI!.reloginMaloumOnVerifyView({
                accountId: session.accountId,
                email: credentials.loginEmail || creator.loginEmail || '',
                password: credentials.loginPassword,
              });

              if (cancelled) return;

              const reconnectResult = await reconnectCreatorSession(creator.id, {
                email: credentials.loginEmail || creator.loginEmail || '',
                cookies: captured.cookies,
                origins: captured.origins,
                displayName: captured.displayName,
                username: captured.username,
                postLoginUrl: captured.postLoginUrl,
                avatarUrl: captured.avatarUrl,
                password: credentials.loginPassword,
              });

              await window.electronAPI!.loadCreatorSession({
                accountId: session.accountId,
                cookies: captured.cookies as PlaywrightCookie[],
                origins: captured.origins,
                force: true,
                savedAt: reconnectResult.sessionUpdatedAt,
              });

              if (cancelled) return;

              setPhase('checking');
              setMessage('Re-checking Maloum profile…');

              finalVerification = await window.electronAPI!.verifyMaloumSession({
                accountId: session.accountId,
                theme: getCurrentDomXTheme(),
                reuseVisibleView: true,
              });
            }
          } catch (credErr) {
            const isMissingCredentials =
              credErr instanceof Error &&
              credErr.message.includes('No saved credentials');

            if (!isMissingCredentials) {
              throw credErr;
            }
          }
        }

        if (cancelled) return;

        if (!finalVerification.verified) {
          await updateCreatorSessionValidation(creator.id, false);
          setPhase('invalid');
          setMessage(
            isLoginRedirectReason(finalVerification.reason)
              ? 'Session expired — Maloum redirected to the login page. Reconnect this account to sign in again.'
              : finalVerification.reason || 'Session could not be verified.'
          );
          return;
        }

        if (
          shouldFetchMaloumIcon({
            profileImageUrl: finalVerification.profileImageUrl,
            overwriteIcon: false,
            currentAvatarUrl: creator.avatarUrl,
            avatarSource: creator.avatarSource,
          })
        ) {
          setPhase('returning');
          setMessage('Saving profile icon…');
          await saveCreatorAvatarFromMaloum(
            creator.id,
            finalVerification.profileImageUrl!,
            {
              overwrite: false,
              accountId: session.accountId,
            }
          );
        }

        await updateCreatorSessionValidation(creator.id, true);
        setPhase('success');
        setMessage('Session verified successfully.');
        onValidated();
      } catch (err) {
        if (!cancelled) {
          setPhase('error');
          setMessage(
            err instanceof Error ? err.message : 'Failed to verify session'
          );
        }
      }
    }

    void runVerification();

    return () => {
      cancelled = true;
      loadStartedRef.current = false;
      void hideVerifyBrowser();
    };
  }, [creator, isElectron, hideVerifyBrowser, onValidated]);

  useEffect(() => {
    if (!sessionReady || !isElectron) return;

    const resizeObserver = new ResizeObserver(() => syncBounds());
    if (browserContainerRef.current) {
      resizeObserver.observe(browserContainerRef.current);
    }

    window.addEventListener('resize', syncBounds);
    const unsubscribeResize = window.electronAPI?.onWindowResized(() => {
      syncBounds();
    });

    syncBounds();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncBounds);
      unsubscribeResize?.();
    };
  }, [sessionReady, isElectron, syncBounds]);

  async function handleClose() {
    await hideVerifyBrowser();
    onClose();
  }

  async function handleDone() {
    await hideVerifyBrowser();
    if (phase === 'success') {
      onClose();
    } else {
      onClose();
    }
  }

  function handleReconnect() {
    void hideVerifyBrowser();
    onClose();
    onReconnect?.();
  }

  const lastValidated = formatValidatedAt(creator.lastValidatedAt);
  const isRunning =
    phase === 'loading' ||
    phase === 'checking' ||
    phase === 'relogging' ||
    phase === 'returning';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={() => void handleClose()}
      />

      <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-4xl border border-gray-200 dark:border-white/10 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-6 pb-4 border-b border-gray-100 dark:border-white/10">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold">Verify Session</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Checking whether{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {creator.displayName}
                </span>{' '}
                is still logged in to Maloum.
              </p>
              {lastValidated && (
                <p className="text-xs text-gray-400 mt-1">
                  Last verified: {lastValidated}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-3 text-sm text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-white/5 border-b border-gray-100 dark:border-white/10">
          <p>
            DomX opens the Maloum profile page to confirm the session, fetches the
            profile icon when available, then returns to chat.
          </p>
          <a
            href={verifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-1 text-brand-600 hover:text-brand-500 text-xs"
          >
            {verifyUrl}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <div className="flex-1 min-h-0 flex flex-col p-6 pt-4 gap-4">
          {message && (
            <div
              className={`flex items-start gap-2 p-3 rounded-lg text-sm border ${
                phase === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800/30 text-green-800 dark:text-green-200'
                  : phase === 'invalid'
                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/30 text-amber-900 dark:text-amber-100'
                    : phase === 'error'
                      ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/30 text-red-800 dark:text-red-200'
                      : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/30 text-blue-800 dark:text-blue-200'
              }`}
            >
              {(phase === 'error' || phase === 'invalid') && (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{message}</span>
            </div>
          )}

          <div
            ref={browserContainerRef}
            className="flex-1 min-h-[360px] relative rounded-lg border border-gray-200 dark:border-white/10 bg-[#f8f9fa] dark:bg-[#0d0d0d] overflow-hidden"
          >
            {isRunning && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-black/20">
                {phase === 'loading' && 'Loading saved session…'}
                {phase === 'checking' && 'Checking profile…'}
                {phase === 'relogging' && 'Logging in again…'}
                {phase === 'returning' && 'Returning to chat…'}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 pt-4 border-t border-gray-100 dark:border-white/10">
          {phase === 'invalid' && onReconnect && (
            <button
              type="button"
              onClick={handleReconnect}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors"
            >
              Reconnect account
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleDone()}
            disabled={isRunning}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            {phase === 'success' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
