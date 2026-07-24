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
