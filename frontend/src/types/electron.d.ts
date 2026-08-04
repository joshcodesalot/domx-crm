export type StaffSyncEvent =
  | { type: 'account:deactivated' }
  | { type: 'account:deleted' }
  | {
      type: 'creator:access-revoked';
      creatorId: string;
      accountId: string | null;
      displayName: string;
    }
  | {
      type: 'creator:access-granted';
      creatorId: string;
      accountId: string | null;
      displayName: string;
    }
  | {
      type: 'creator:session-updated';
      creatorId: string;
      accountId: string | null;
      sessionUpdatedAt: string | null;
    }
  | {
      type: '4based:event';
      event: string;
      creatorId: string;
      providerUserId: string;
      payload: unknown;
    }
  | {
      type: 'messaging:sent';
      creatorId: string;
      chatId: string;
      maloumMessageId: string;
      optimisticMessageId: string | null;
      chatterId: string;
      chatterName: string;
    }
  | {
      type: 'moderation:alert';
      eventId?: string | null;
      matchedKeyword?: string | null;
      chatterName?: string | null;
      creatorName?: string | null;
      platform?: string | null;
      fanUsername?: string | null;
      messageText?: string | null;
    }
  | {
      type: 'moderation:warned';
      matchedKeyword?: string | null;
      message?: string | null;
    };

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'blocked'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string;
  availableVersion: string | null;
  progress: number;
  error: string | null;
  macDownloadUrl: string | null;
  blocked: boolean;
  platform: string;
  updaterEnabled: boolean;
}

export interface ElectronAPI {
  platform: string;
  isElectron: boolean;
  getUpdaterState: () => Promise<UpdaterState>;
  installUpdateNow: () => Promise<{ ok: boolean; reason?: string }>;
  openMacDownload: () => Promise<{ ok: boolean; reason?: string }>;
  loadMaloumPartitionSession?: (payload: {
    accountId: string;
    cookies?: Array<Record<string, unknown>>;
    proxyUrl?: string | null;
    userAgent?: string | null;
  }) => Promise<{
    accountId: string;
    partitionId: string;
    userAgent: string;
    proxyConfigured: boolean;
    imported: number;
    failed: number;
  }>;
  openMessageProWindow?: (
    platform?: 'maloum' | '4based'
  ) => Promise<{ opened: boolean; focused?: boolean; route?: string }>;
  onUpdaterChecking: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterBlocked: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterAvailable: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterDownloadProgress: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterReady: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterError: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterNotAvailable: (callback: (state: UpdaterState) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
