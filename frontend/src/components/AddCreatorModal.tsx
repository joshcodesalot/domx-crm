import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  UserPlus,
  X,
} from 'lucide-react';
import {
  connectCreatorAccount,
  createCreator,
  discardCreatorConnect,
  reconnectCreatorSession,
  resolveCreatorAvatarUrl,
  saveCreatorAvatarFromMaloum,
  shouldFetchMaloumIcon,
  type ConnectCreatorResponse,
  type CreateCreatorInput,
  type Creator,
} from '@/lib/api';
import type { BrowserBounds } from '@/types/electron';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500';

const STEP_TITLES: Record<number, [string, string]> = {
  1: ['Select a platform', 'Choose the platform you want to connect.'],
  2: [
    'Connect Maloum account',
    "Sign into your creator's Maloum account in the embedded browser.",
  ],
  3: ['Review details', 'Confirm account info before saving.'],
};

interface SessionData {
  displayName: string;
  username: string;
  postLoginUrl: string;
  avatarUrl: string | null;
  profileImageUrl: string | null;
}

interface AddCreatorModalProps {
  onClose: () => void;
  onSaved: () => void;
  reconnectCreator?: Creator | null;
}

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

export default function AddCreatorModal({
  onClose,
  onSaved,
  reconnectCreator = null,
}: AddCreatorModalProps) {
  const isReconnect = Boolean(reconnectCreator?.accountId);
  const [step, setStep] = useState(isReconnect ? 2 : 1);
  const [loginEmail, setLoginEmail] = useState(reconnectCreator?.loginEmail || '');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [displayNameOverride, setDisplayNameOverride] = useState(
    reconnectCreator?.displayName || ''
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(
    reconnectCreator?.accountId || null
  );
  const [accountToken, setAccountToken] = useState<string | null>(null);
  const [connectSucceeded, setConnectSucceeded] = useState(false);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [manualLoginMode, setManualLoginMode] = useState(false);

  const accountIdRef = useRef<string | null>(reconnectCreator?.accountId || null);
  const connectSucceededRef = useRef(false);
  const browserContainerRef = useRef<HTMLDivElement | null>(null);
  const completingManualLoginRef = useRef(false);

  const [title, subtitle] = isReconnect && step === 2
    ? ([
        'Reconnect Maloum account',
        `Sign in again to refresh the session for ${reconnectCreator?.displayName || 'this creator'}.`,
      ] as [string, string])
    : STEP_TITLES[step];

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

  const discardPendingConnect = useCallback(async () => {
    const id = accountIdRef.current;
    if (!id || !connectSucceededRef.current || isReconnect) return;
    try {
      await discardCreatorConnect(id);
    } catch {
      // Best-effort cleanup when discarding pending connect session
    }
    if (window.electronAPI) {
      await window.electronAPI.clearSession(id);
    }
  }, [isReconnect]);

  const cleanup = useCallback(
    async (options?: { discardPending?: boolean }) => {
      await hideLoginBrowser();
      if (options?.discardPending) {
        await discardPendingConnect();
      }
    },
    [discardPendingConnect, hideLoginBrowser]
  );

  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  useEffect(() => {
    connectSucceededRef.current = connectSucceeded;
  }, [connectSucceeded]);

  useEffect(() => {
    if (step !== 2 || isReconnect) return;
    const id = crypto.randomUUID();
    setAccountId(id);
    accountIdRef.current = id;
  }, [step, isReconnect]);

  useEffect(() => {
    return () => {
      void hideLoginBrowser();
    };
  }, [hideLoginBrowser]);

  const syncLoginBrowserBounds = useCallback(() => {
    const bounds = measureBounds(browserContainerRef.current);
    if (!bounds || !window.electronAPI) return;
    void window.electronAPI.resizeLoginBrowser(bounds);
  }, []);

  useLayoutEffect(() => {
    if (step !== 2 || !browserVisible || !window.electronAPI) return;

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
  }, [step, browserVisible, syncLoginBrowserBounds]);

  type CapturedMaloumSession = Omit<ConnectCreatorResponse, 'accountToken'> & {
    accountToken?: string;
  };

  async function finalizeCapturedSession(captured: CapturedMaloumSession) {
    if (!accountId) {
      throw new Error('Session is not ready. Please try again.');
    }

    if (isReconnect && reconnectCreator) {
      await reconnectCreatorSession(reconnectCreator.id, {
        email: loginEmail.trim(),
        cookies: captured.cookies,
        origins: captured.origins,
        displayName: captured.displayName,
        username: captured.username,
        postLoginUrl: captured.postLoginUrl,
        avatarUrl: captured.avatarUrl,
      });

      await hideLoginBrowser();
      setConnectSucceeded(false);
      connectSucceededRef.current = false;
      onSaved();
      onClose();
      return;
    }

    const result = await connectCreatorAccount({
      accountId: captured.accountId,
      platform: 'maloum',
      email: loginEmail.trim(),
      cookies: captured.cookies,
      origins: captured.origins,
      displayName: captured.displayName,
      username: captured.username,
      postLoginUrl: captured.postLoginUrl,
      avatarUrl: captured.avatarUrl,
    });

    setAccountToken(result.accountToken);

    const sessionData: SessionData = {
      displayName: result.displayName,
      username: result.username || '',
      postLoginUrl: result.postLoginUrl,
      avatarUrl: result.avatarUrl,
      profileImageUrl: result.avatarUrl,
    };

    await hideLoginBrowser();
    setSession(sessionData);
    setDisplayNameOverride(result.displayName);
    setConnectSucceeded(true);
    connectSucceededRef.current = true;
    setManualLoginMode(false);
    setStep(3);
  }

  const completeManualLogin = useCallback(async () => {
    if (!window.electronAPI || !accountId || completingManualLoginRef.current) {
      return;
    }

    completingManualLoginRef.current = true;
    setConnecting(true);
    setLoginError(null);

    try {
      syncLoginBrowserBounds();
      const captured = await window.electronAPI.completeLoginCaptureFromActiveLogin(
        accountId
      );
      await finalizeCapturedSession(captured);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to complete login');
    } finally {
      completingManualLoginRef.current = false;
      setConnecting(false);
    }
  }, [accountId, isReconnect, loginEmail, reconnectCreator, syncLoginBrowserBounds]);

  useEffect(() => {
    if (!manualLoginMode || !window.electronAPI || !accountId) return;

    const unsubscribe = window.electronAPI.onLoginDetected(() => {
      void completeManualLogin();
    });

    return unsubscribe;
  }, [manualLoginMode, accountId, completeManualLogin]);

  async function handleClose() {
    await cleanup({ discardPending: connectSucceeded && step < 3 && !isReconnect });
    onClose();
  }

  function handleSelectMaloum() {
    setStep(2);
    setLoginError(null);
  }

  async function handleConnectAccount() {
    if (!window.electronAPI) {
      setLoginError('Connecting Maloum accounts requires the DomX desktop app.');
      return;
    }

    if (!loginEmail.trim() || !loginPassword.trim()) {
      setLoginError('Email or username and password are required.');
      return;
    }

    if (!accountId) {
      setLoginError('Session is not ready. Please try again.');
      return;
    }

    setLoginError(null);
    setConnecting(true);
    setManualLoginMode(false);

    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const bounds = measureBounds(browserContainerRef.current);
      if (!bounds) {
        throw new Error('Login browser area is not ready. Please try again.');
      }

      setBrowserVisible(true);

      const captured = await window.electronAPI.loginAndCaptureMaloumSession({
        accountId,
        email: loginEmail.trim(),
        password: loginPassword,
        bounds,
      });

      await finalizeCapturedSession(captured);
    } catch (err) {
      setBrowserVisible(true);
      setManualLoginMode(true);
      setLoginError(
        err instanceof Error
          ? `${err.message} Complete login in the browser below, then press Continue after login.`
          : 'Failed to connect account. Complete login in the browser below, then press Continue after login.'
      );
      syncLoginBrowserBounds();
    } finally {
      setConnecting(false);
    }
  }

  async function handleSaveCreator() {
    if (!session || !accountId) return;

    setSaving(true);
    setSaveError(null);

    try {
      const input: CreateCreatorInput = {
        displayName: displayNameOverride.trim() || session.displayName,
        username: session.username || undefined,
        platform: 'maloum',
        postLoginUrl: session.postLoginUrl,
        connectionStatus: 'connected',
        accountId,
      };

      const { creator } = await createCreator(input);

      if (
        session.profileImageUrl &&
        shouldFetchMaloumIcon({
          profileImageUrl: session.profileImageUrl,
          overwriteIcon: false,
          currentAvatarUrl: null,
          avatarSource: null,
        })
      ) {
        await saveCreatorAvatarFromMaloum(creator.id, session.profileImageUrl, {
          overwrite: false,
        });
      }

      setConnectSucceeded(false);
      connectSucceededRef.current = false;
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save creator');
    } finally {
      setSaving(false);
    }
  }

  function stepIndicatorClass(stepNum: number): string {
    const base =
      'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium';
    if (stepNum <= step) {
      return `${base} bg-brand-600 text-white`;
    }
    return `${base} bg-gray-200 dark:bg-white/10 text-gray-500`;
  }

  function stepLabelClass(stepNum: number): string {
    if (stepNum === step) {
      return 'ml-2 text-xs font-medium text-brand-600 hidden sm:inline';
    }
    if (stepNum < step) {
      return 'ml-2 text-xs font-medium text-brand-600 hidden sm:inline';
    }
    return 'ml-2 text-xs text-gray-400 hidden sm:inline';
  }

  const sessionInitial = (session?.displayName || displayNameOverride || '?')
    .charAt(0)
    .toUpperCase();

  const showBrowserPanel = browserVisible || manualLoginMode;

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
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
              <UserPlus className="w-5 h-5 text-brand-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                {subtitle}
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

        {!isReconnect && (
          <div className="px-6 py-4 flex items-center justify-center gap-0">
            <div className="flex items-center">
              <div className={stepIndicatorClass(1)}>1</div>
              <span className={stepLabelClass(1)}>Platform</span>
            </div>
            <div className="w-16 h-0.5 bg-gray-200 dark:bg-white/10 mx-2" />
            <div className="flex items-center">
              <div className={stepIndicatorClass(2)}>2</div>
              <span className={stepLabelClass(2)}>Login</span>
            </div>
            <div className="w-16 h-0.5 bg-gray-200 dark:bg-white/10 mx-2" />
            <div className="flex items-center">
              <div className={stepIndicatorClass(3)}>3</div>
              <span className={stepLabelClass(3)}>Details</span>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {step === 1 && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleSelectMaloum}
                className="w-full flex items-center gap-4 p-4 border-2 border-brand-600 rounded-lg hover:bg-brand-50 dark:hover:bg-brand-900/10 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center shrink-0">
                  <span className="text-orange-600 font-bold text-lg">M</span>
                </div>
                <div>
                  <p className="font-medium text-sm">Maloum</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    The home for the world&apos;s hottest creators and their fans
                  </p>
                </div>
              </button>

              <div className="w-full flex items-center gap-4 p-4 border border-gray-200 dark:border-white/10 rounded-lg opacity-50 cursor-not-allowed text-left">
                <div className="w-10 h-10 rounded-lg bg-gray-900 flex items-center justify-center shrink-0">
                  <span className="text-white font-bold text-xs">4B</span>
                </div>
                <div>
                  <p className="font-medium text-sm">4based</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Coming soon — Another platform is on the way
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Login runs in DomX on this computer (not on the server), so Cloudflare
                treats it like a normal browser. If a security check appears below,
                complete it there.
              </p>

              {!window.electronAPI && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  The DomX desktop app is required to connect Maloum accounts.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Email or username <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !connecting) void handleConnectAccount();
                    }}
                    placeholder="Enter your email or username"
                    className={inputClassName}
                    disabled={connecting}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Password <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !connecting) void handleConnectAccount();
                      }}
                      placeholder="Enter your password"
                      className={`${inputClassName} pr-10`}
                      disabled={connecting}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {loginError && (
                <p className="text-sm text-red-600 dark:text-red-400">{loginError}</p>
              )}

              <div
                ref={browserContainerRef}
                className={`relative rounded-lg border border-gray-200 dark:border-white/10 bg-[#f8f9fa] dark:bg-[#0d0d0d] overflow-hidden ${
                  showBrowserPanel ? 'min-h-[360px]' : 'min-h-[120px]'
                }`}
              >
                {!showBrowserPanel && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 px-4 text-center">
                    Click Connect Account to open Maloum login here.
                  </div>
                )}
                {connecting && showBrowserPanel && (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-black/20">
                    {manualLoginMode ? 'Waiting for Maloum login…' : 'Opening Maloum login…'}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && session && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Review the connected account details before saving.
              </p>
              <div className="border border-gray-200 dark:border-white/10 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-3">
                  {resolveCreatorAvatarUrl(session.avatarUrl) ? (
                    <img
                      src={resolveCreatorAvatarUrl(session.avatarUrl)!}
                      alt={session.displayName}
                      className="w-12 h-12 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                      <span className="text-orange-600 font-bold text-lg">
                        {sessionInitial}
                      </span>
                    </div>
                  )}
                  <div>
                    <p className="font-medium">{session.displayName}</p>
                    <p className="text-sm text-gray-500">{session.username}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">
                    Profile URL
                  </p>
                  <p className="text-sm text-brand-600 break-all">
                    {session.postLoginUrl}
                  </p>
                </div>
                {accountToken && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">
                      Account session
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                      Connected — session stored for this creator
                    </p>
                  </div>
                )}
                <div>
                  <label
                    htmlFor="detail-display-name-input"
                    className="block text-sm font-medium mb-1.5"
                  >
                    Display name (optional override)
                  </label>
                  <input
                    type="text"
                    id="detail-display-name-input"
                    value={displayNameOverride}
                    onChange={(e) => setDisplayNameOverride(e.target.value)}
                    placeholder="Internal display name"
                    className={inputClassName}
                  />
                </div>
              </div>
              {saveError && (
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-6 pt-4 border-t border-gray-100 dark:border-white/10">
          {step > 1 && !isReconnect ? (
            <button
              type="button"
              onClick={() => {
                void hideLoginBrowser();
                setStep((s) => s - 1);
              }}
              disabled={connecting}
              className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              Back
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => void handleClose()}
              className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>

            {step === 2 && manualLoginMode && (
              <button
                type="button"
                onClick={() => void completeManualLogin()}
                disabled={connecting || !window.electronAPI}
                className="px-4 py-2 text-sm font-medium border border-brand-600 text-brand-600 rounded-lg hover:bg-brand-50 dark:hover:bg-brand-900/10 transition-colors disabled:opacity-50"
              >
                {connecting ? 'Continuing…' : 'Continue after login'}
              </button>
            )}

            {step === 2 && (
              <button
                type="button"
                onClick={() => void handleConnectAccount()}
                disabled={connecting || !window.electronAPI}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {connecting
                  ? isReconnect
                    ? 'Reconnecting...'
                    : 'Connecting...'
                  : isReconnect
                    ? 'Reconnect Account'
                    : 'Connect Account'}
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={() => void handleSaveCreator()}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Creator'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
