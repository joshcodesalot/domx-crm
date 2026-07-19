import { getCreatorCredentials } from '@/lib/api';

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

function mapLocalLoginFailure(result: {
  ok: false;
  reason: LocalMaloumLoginReason;
  message: string;
}): never {
  throw new LocalMaloumSessionError(result.message, result.reason);
}

export async function hydrateLocalCreatorSession(accountId: string): Promise<boolean> {
  const hydrated = await window.electronAPI!.hydrateCreatorProfile(accountId);
  return hydrated.hydrated;
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
        'No saved credentials for this creator. Ask a manager to reconnect the account.',
        'missing_credentials'
      );
    }
    throw err;
  }

  const email = credentials.loginEmail || loginEmail || '';
  if (!email || !credentials.loginPassword) {
    throw new LocalMaloumSessionError(
      'No saved credentials for this creator. Ask a manager to reconnect the account.',
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

export async function ensureLocalMaloumSessionForChat(
  creatorId: string,
  accountId: string,
  loginEmail?: string | null
): Promise<void> {
  await window.electronAPI!.registerCreatorMapping({ accountId, creatorId });

  const hasLocalSession = await hydrateLocalCreatorSession(accountId);

  const tryPrepare = async () => {
    const prepared = await window.electronAPI!.isChatPrepared(accountId);
    if (!prepared) {
      await window.electronAPI!.prepareChatBrowser(accountId);
    }
  };

  if (!hasLocalSession) {
    await loginCreatorLocallyWithSavedCredentials(creatorId, accountId, loginEmail);
    await tryPrepare();
    return;
  }

  try {
    await tryPrepare();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const shouldRetryWithLogin =
      isLoginRedirectError(message) || isPageLoadTimeoutError(message);

    if (!shouldRetryWithLogin) {
      throw err;
    }

    try {
      await loginCreatorLocallyWithSavedCredentials(creatorId, accountId, loginEmail);
      await tryPrepare();
    } catch (retryErr) {
      const retryMessage =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (isPageLoadTimeoutError(retryMessage)) {
        throw new LocalMaloumSessionError(
          'Maloum chat is taking too long to load. Check your network and try again.',
          'page_load_timeout'
        );
      }
      throw retryErr;
    }
  }
}
