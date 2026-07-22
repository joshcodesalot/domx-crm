import { getCreatorCredentials, getCreatorSession, refreshCreatorSession } from '@/lib/api';
import type { PlaywrightCookie } from '@/types/electron';

export type LocalMaloumLoginReason =
  | 'invalid_credentials'
  | 'interaction_required'
  | 'missing_credentials'
  | 'transient_failure';

export class LocalMaloumSessionError extends Error {
  reason: LocalMaloumLoginReason | 'login_required' | 'page_load_timeout';

  constructor(
    message: string,
    reason: LocalMaloumSessionError['reason'] = 'transient_failure'
  ) {
    super(message);
    this.name = 'LocalMaloumSessionError';
    this.reason = reason;
  }
}

export function isLoginRedirectError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('redirected to login') ||
    normalized.includes('session expired or invalid') ||
    normalized.includes('session partition is not warm')
  );
}

export function isPageLoadTimeoutError(message: string): boolean {
  return message.includes('Maloum chat page did not finish loading');
}

export function isMissingCredentialsError(message: string): boolean {
  return message.includes('No saved credentials');
}

export function needsInteractiveSessionRecovery(error: unknown): boolean {
  if (!(error instanceof LocalMaloumSessionError)) {
    return false;
  }

  return (
    error.reason === 'missing_credentials' ||
    error.reason === 'interaction_required' ||
    error.reason === 'invalid_credentials' ||
    error.reason === 'login_required'
  );
}

function mapLocalLoginFailure(result: {
  ok: false;
  reason: LocalMaloumLoginReason;
  message: string;
}): never {
  throw new LocalMaloumSessionError(result.message, result.reason);
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shouldRetrySessionRecovery(message: string): boolean {
  return isLoginRedirectError(message) || isPageLoadTimeoutError(message);
}

function mapRecoveryFailure(err: unknown): never {
  const message = getErrorMessage(err);
  if (isPageLoadTimeoutError(message)) {
    throw new LocalMaloumSessionError(
      'Maloum chat is taking too long to load. Check your network and try again.',
      'page_load_timeout'
    );
  }
  throw err;
}

export async function hydrateLocalCreatorSession(accountId: string): Promise<boolean> {
  const hydrated = await window.electronAPI!.hydrateCreatorProfile(accountId);
  return hydrated.hydrated;
}

export async function loadBackendCreatorSession(
  creatorId: string,
  accountId: string
): Promise<boolean> {
  try {
    const session = await getCreatorSession(creatorId);
    if (session.accountId !== accountId) {
      return false;
    }

    await window.electronAPI!.loadCreatorSession({
      accountId: session.accountId,
      cookies: session.cookies as PlaywrightCookie[],
      origins: session.origins,
      force: true,
      savedAt: session.sessionUpdatedAt,
    });

    return true;
  } catch {
    return false;
  }
}

export async function loginCreatorLocallyWithSavedCredentials(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<void> {
  let credentials;
  try {
    credentials = await getCreatorCredentials(creatorId);
  } catch (err) {
    if (err instanceof Error && isMissingCredentialsError(err.message)) {
      throw new LocalMaloumSessionError(
        'No saved credentials for this creator. Sign in to Maloum or ask a manager to reconnect the account.',
        'missing_credentials'
      );
    }
    throw err;
  }

  const email = credentials.loginEmail || loginEmail || '';
  if (!email || !credentials.loginPassword) {
    throw new LocalMaloumSessionError(
      'No saved credentials for this creator. Sign in to Maloum or ask a manager to reconnect the account.',
      'missing_credentials'
    );
  }

  const result = await window.electronAPI!.loginCreatorLocally({
    accountId,
    email,
    password: credentials.loginPassword,
  });

  if (!result.ok) {
    mapLocalLoginFailure(result);
  }
}

async function prepareChatSession(accountId: string, force = false): Promise<void> {
  if (force) {
    await window.electronAPI!.releaseCreatorChat(accountId);
    await window.electronAPI!.prepareChatBrowser(accountId);
    return;
  }

  const prepared = await window.electronAPI!.isChatPrepared(accountId);
  if (!prepared) {
    await window.electronAPI!.prepareChatBrowser(accountId);
  }
}

async function runSessionRecoveryLadder(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null,
  options: { forcePrepare?: boolean } = {}
): Promise<void> {
  await window.electronAPI!.registerCreatorMapping({ accountId, creatorId });
  await hydrateLocalCreatorSession(accountId);

  const tryPrepare = () => prepareChatSession(accountId, options.forcePrepare ?? false);

  try {
    await tryPrepare();
    return;
  } catch (err) {
    if (!shouldRetrySessionRecovery(getErrorMessage(err))) {
      throw err;
    }
  }

  const loadedBackend = await loadBackendCreatorSession(creatorId, accountId);
  if (loadedBackend) {
    try {
      await prepareChatSession(accountId, true);
      return;
    } catch (err) {
      if (!shouldRetrySessionRecovery(getErrorMessage(err))) {
        throw err;
      }
    }
  }

  try {
    await loginCreatorLocallyWithSavedCredentials(creatorId, accountId, loginEmail);
    await prepareChatSession(accountId, true);
  } catch (err) {
    mapRecoveryFailure(err);
  }
}

export async function ensureCreatorSessionReady(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<boolean> {
  await window.electronAPI!.registerCreatorMapping({ accountId, creatorId });

  const hasLocalSession = await hydrateLocalCreatorSession(accountId);
  if (hasLocalSession) {
    return true;
  }

  const loadedBackend = await loadBackendCreatorSession(creatorId, accountId);
  if (loadedBackend) {
    return true;
  }

  try {
    await loginCreatorLocallyWithSavedCredentials(creatorId, accountId, loginEmail);
    return true;
  } catch {
    return false;
  }
}

export async function warmCreatorInBackground(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<void> {
  if (!window.electronAPI?.isElectron) {
    return;
  }

  try {
    const sessionReady = await ensureCreatorSessionReady(creatorId, accountId, loginEmail);
    if (!sessionReady) {
      return;
    }

    const prepared = await window.electronAPI.isChatPrepared(accountId);
    if (!prepared) {
      await window.electronAPI.prepareChatBrowser(accountId);
    }
  } catch {
    // Best-effort warm-up; recovery happens when chat opens.
  }
}

export async function ensureLocalMaloumSessionForChat(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<void> {
  await runSessionRecoveryLadder(creatorId, accountId, loginEmail);
}

export async function revalidateLocalMaloumSessionForChat(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<void> {
  await window.electronAPI!.releaseCreatorChat(accountId);
  await runSessionRecoveryLadder(creatorId, accountId, loginEmail, { forcePrepare: true });
}

export type CapturedCreatorSession = {
  cookies: PlaywrightCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
  displayName?: string;
  username?: string | null;
  postLoginUrl?: string;
};

export async function uploadRefreshedCreatorSession(
  creatorId: string,
  accountId: string,
  captured?: CapturedCreatorSession
): Promise<void> {
  const payload =
    captured ?? (await window.electronAPI!.captureCreatorSessionForRefresh(accountId));

  await refreshCreatorSession(creatorId, {
    cookies: payload.cookies,
    origins: payload.origins,
  });
}
