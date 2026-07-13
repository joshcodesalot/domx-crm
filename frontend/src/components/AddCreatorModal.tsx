import { useCallback, useEffect, useRef, useState } from 'react';
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
  resolveCreatorAvatarUrl,
  saveCreatorAvatarFromMaloum,
  shouldFetchMaloumIcon,
  type CreateCreatorInput,
} from '@/lib/api';
import type { PlaywrightCookie } from '@/types/electron';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500';

const STEP_TITLES: Record<number, [string, string]> = {
  1: ['Select a platform', 'Choose the platform you want to connect.'],
  2: [
    'Connect Maloum account',
    "Sign into your creator's Maloum account to establish a connection.",
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

function getCurrentDomXTheme(): 'dark' | 'light' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

interface AddCreatorModalProps {
  onClose: () => void;
  onSaved: () => void;
}

export default function AddCreatorModal({ onClose, onSaved }: AddCreatorModalProps) {
  const [step, setStep] = useState(1);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [displayNameOverride, setDisplayNameOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountToken, setAccountToken] = useState<string | null>(null);
  const [connectSucceeded, setConnectSucceeded] = useState(false);

  const accountIdRef = useRef<string | null>(null);
  const connectSucceededRef = useRef(false);

  const [title, subtitle] = STEP_TITLES[step];

  const discardPendingConnect = useCallback(async () => {
    const id = accountIdRef.current;
    if (!id || !connectSucceededRef.current) return;
    try {
      await discardCreatorConnect(id);
    } catch {
      // Best-effort cleanup when discarding pending connect session
    }
    if (window.electronAPI) {
      await window.electronAPI.clearSession(id);
    }
  }, []);

  const cleanup = useCallback(
    async (options?: { discardPending?: boolean }) => {
      if (options?.discardPending) {
        await discardPendingConnect();
      }
    },
    [discardPendingConnect]
  );

  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  useEffect(() => {
    connectSucceededRef.current = connectSucceeded;
  }, [connectSucceeded]);

  useEffect(() => {
    if (step !== 2) return;
    const id = crypto.randomUUID();
    setAccountId(id);
    accountIdRef.current = id;
  }, [step]);

  async function handleClose() {
    await cleanup({ discardPending: connectSucceeded && step < 3 });
    onClose();
  }

  function handleSelectMaloum() {
    setStep(2);
    setLoginError(null);
  }

  async function handleConnectAccount() {
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

    try {
      const result = await connectCreatorAccount({
        accountId,
        platform: 'maloum',
        email: loginEmail.trim(),
        password: loginPassword,
      });

      setAccountToken(result.accountToken);

      let profileImageUrl = result.avatarUrl;

      if (window.electronAPI) {
        await window.electronAPI.loadCreatorSession({
          accountId: result.accountId,
          cookies: result.cookies as PlaywrightCookie[],
          origins: result.origins || [],
        });

        const verification = await window.electronAPI.verifyMaloumSession({
          accountId: result.accountId,
          theme: getCurrentDomXTheme(),
          reuseVisibleView: false,
        });

        if (!verification.verified) {
          throw new Error(
            'Maloum login failed or session could not be verified.'
          );
        }

        profileImageUrl =
          verification.profileImageUrl || result.avatarUrl || null;
      }

      const sessionData: SessionData = {
        displayName: result.displayName,
        username: result.username || '',
        postLoginUrl: result.postLoginUrl,
        avatarUrl: profileImageUrl || result.avatarUrl,
        profileImageUrl,
      };

      setSession(sessionData);
      setDisplayNameOverride(result.displayName);
      setConnectSucceeded(true);
      connectSucceededRef.current = true;
      setStep(3);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to connect account');
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
                Enter the creator&apos;s Maloum credentials. Login runs securely in the
                background.
              </p>

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
                      if (e.key === 'Enter') void handleConnectAccount();
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
                        if (e.key === 'Enter') void handleConnectAccount();
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
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
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

            {step === 2 && (
              <button
                type="button"
                onClick={() => void handleConnectAccount()}
                disabled={connecting}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {connecting ? 'Verifying session...' : 'Connect Account'}
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
