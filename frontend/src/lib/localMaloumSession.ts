import { getCreatorSession } from '@/lib/api';
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

  if (isLoginRedirectError(message)) {
    throw new LocalMaloumSessionError(
      'Session unavailable for this creator. Ask a manager to reconnect the account.',
      'login_required'
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

export async function applyBackendCreatorSessionUpdate(
  creatorId: string,
  accountId: string
): Promise<boolean> {
  try {
    const session = await getCreatorSession(creatorId);
    if (session.accountId !== accountId) {
      return false;
    }

    await window.electronAPI!.patchCreatorMaloumSession({
      accountId: session.accountId,
      origins: session.origins,
      savedAt: session.sessionUpdatedAt,
    });

    return true;
  } catch {
    return false;
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
      mapRecoveryFailure(err);
    }
  }

  throw new LocalMaloumSessionError(
    'Session unavailable for this creator. Ask a manager to reconnect the account.',
    'login_required'
  );
}

export async function ensureCreatorSessionReady(
  creatorId: string,
  accountId: string
): Promise<boolean> {
  await window.electronAPI!.registerCreatorMapping({ accountId, creatorId });

  const hasLocalSession = await hydrateLocalCreatorSession(accountId);
  if (hasLocalSession) {
    return true;
  }

  return loadBackendCreatorSession(creatorId, accountId);
}

export async function warmCreatorInBackground(
  creatorId: string,
  accountId: string
): Promise<void> {
  if (!window.electronAPI?.isElectron) {
    return;
  }

  try {
    const sessionReady = await ensureCreatorSessionReady(creatorId, accountId);
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
  accountId: string
): Promise<void> {
  await runSessionRecoveryLadder(creatorId, accountId);
}
