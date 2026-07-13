export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | string;
}

export interface CreatorBadgeCounts {
  notificationCount: number;
  messages: number;
}

export interface CreatorBadgeCountsUpdatedPayload {
  accountId: string;
  notificationCount: number;
  messages: number;
}

export interface TranslationSettings {
  preSendEnabled: boolean;
  historyEnabled: boolean;
}

export interface MaloumSentMessageRecord {
  id: string;
  accountId?: string;
  creatorId: string;
  chatId: string;
  maloumMessageId: string | null;
  optimisticMessageId: string | null;
  contentText: string;
  sentByUserId: string;
  sentByUserName: string;
  sentAt: string;
  status: 'pending' | 'confirmed' | 'failed';
  domMarked?: boolean;
  contentType?: string;
  englishMessage?: string | null;
  germanTranslatedMessage?: string | null;
  actualSentText?: string | null;
  priceNet?: number | null;
  currency?: string;
  purchased?: boolean;
  mediaCount?: number;
  pictureCount?: number;
  videoCount?: number;
  mediaJson?: Array<{
    mediaId?: string;
    type?: string;
    width?: number;
    height?: number;
  }> | null;
  fanId?: string | null;
  fanUsername?: string | null;
  previousFanMessageAt?: string | null;
  responseTimeSeconds?: number | null;
  originalEnglishText?: string | null;
  translatedGermanText?: string | null;
  translatedAt?: number | null;
}

export interface SentMessageTrackedPayload {
  accountId: string;
  record: MaloumSentMessageRecord;
}

export interface DashboardEntryUpdatedPayload {
  entry: {
    id: string;
    maloumMessageId: string;
    purchased: boolean;
    priceNet: number | null;
    chatterId: string;
  };
}

export type StaffSyncEvent =
  | { type: 'account:deactivated' }
  | {
      type: 'creator:access-revoked';
      creatorId: string;
      accountId: string | null;
      displayName: string;
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
  showLoginBrowser: (opts: {
    accountId: string;
    bounds: BrowserBounds;
  }) => Promise<{ accountId: string; partitionId: string }>;
  hideLoginBrowser: () => Promise<void>;
  resizeLoginBrowser: (bounds: BrowserBounds) => Promise<void>;
  importCookies: (opts: {
    accountId: string;
    cookies: PlaywrightCookie[];
  }) => Promise<{ imported: number }>;
  clearSession: (accountId: string) => Promise<{ accountId: string; partitionId: string }>;
  submitLoginBrowser: (opts: {
    accountId: string;
    email: string;
    password: string;
  }) => Promise<{ submitted: boolean }>;
  showChatBrowser: (opts: {
    accountId: string;
    bounds: BrowserBounds;
  }) => Promise<{ accountId: string; partitionId: string }>;
  hideChatBrowser: () => Promise<void>;
  resizeChatBrowser: (bounds: BrowserBounds) => Promise<void>;
  reloadChatBrowser: (accountId?: string) => Promise<{ accountId: string; url: string }>;
  loadCreatorSession: (opts: {
    accountId: string;
    cookies: PlaywrightCookie[];
    origins?: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
    }>;
    force?: boolean;
  }) => Promise<{
    imported: number;
    accountId: string;
    partitionId: string;
    skipped?: boolean;
    warm?: boolean;
  }>;
  hydrateCreatorProfile: (
    accountId: string
  ) => Promise<{
    hydrated: boolean;
    source?: 'memory' | 'partition' | 'file';
    accountId: string;
  }>;
  hasLocalCreatorProfile: (accountId: string) => Promise<boolean>;
  preloadCreatorSessions: (
    sessions: Array<{
      accountId: string;
      creatorId?: string;
      hydrated?: boolean;
      source?: string;
      cookies?: PlaywrightCookie[];
      origins?: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
      }>;
    }>
  ) => Promise<{ preloaded: number }>;
  isCreatorSessionWarm: (accountId: string) => Promise<boolean>;
  getActiveChatAccountId: () => Promise<string | null>;
  prepareChatBrowser: (
    accountId: string
  ) => Promise<{ accountId: string; prepared: boolean; skipped?: boolean }>;
  prepareAllChatBrowsers: (
    accountIds: string[]
  ) => Promise<{
    prepared: number;
    results: Array<{
      accountId: string;
      ok: boolean;
      error?: string;
      prepared?: boolean;
      skipped?: boolean;
    }>;
  }>;
  isChatPrepared: (accountId: string) => Promise<boolean>;
  showVerifyBrowser: (opts: {
    accountId: string;
    bounds: BrowserBounds;
    url?: string;
  }) => Promise<{ accountId: string; partitionId: string; url: string }>;
  hideVerifyBrowser: () => Promise<void>;
  resizeVerifyBrowser: (bounds: BrowserBounds) => Promise<void>;
  verifyMaloumSession: (opts: {
    accountId: string;
    theme?: 'dark' | 'light' | 'night' | 'day';
    bounds?: BrowserBounds | null;
    reuseVisibleView?: boolean;
  }) => Promise<{
    verified: boolean;
    reason: string;
    profileImageUrl: string | null;
  }>;
  setDomXTheme: (theme: 'dark' | 'light' | 'night' | 'day') => Promise<void>;
  getTranslationSettings: () => Promise<TranslationSettings>;
  setTranslationSettings: (
    settings: Partial<TranslationSettings>
  ) => Promise<TranslationSettings>;
  getCreatorBadgeCounts: () => Promise<Record<string, CreatorBadgeCounts>>;
  getCreatorBadgeCountsForAccount: (accountId: string) => Promise<CreatorBadgeCounts>;
  setActiveChatter: (payload: { userId: string; userName: string }) => Promise<{ ok: boolean }>;
  registerCreatorMapping: (payload: {
    accountId: string;
    creatorId: string;
  }) => Promise<{ ok: boolean }>;
  hydrateSentMessages: (payload: {
    accountId: string;
    records: MaloumSentMessageRecord[];
  }) => Promise<{ hydrated: number }>;
  releaseCreatorChat: (
    accountId: string
  ) => Promise<{ released: boolean; accountId?: string }>;
  releaseAllCreatorChats: () => Promise<{ released: number; accountIds: string[] }>;
  onCreatorBadgeCountsUpdated: (
    callback: (payload: CreatorBadgeCountsUpdatedPayload) => void
  ) => () => void;
  onSentMessageTracked: (
    callback: (payload: SentMessageTrackedPayload) => void
  ) => () => void;
  onDashboardEntryUpdated: (
    callback: (payload: DashboardEntryUpdatedPayload) => void
  ) => () => void;
  onLoginDetected: (callback: (payload: { url: string }) => void) => () => void;
  onWindowResized: (callback: () => void) => () => void;
  getUpdaterState: () => Promise<UpdaterState>;
  installUpdateNow: () => Promise<{ ok: boolean }>;
  openMacDownload: () => Promise<{ ok: boolean }>;
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
