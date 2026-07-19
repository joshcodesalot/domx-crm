const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  showLoginBrowser: (opts) => ipcRenderer.invoke('creator:show-login-browser', opts),
  hideLoginBrowser: () => ipcRenderer.invoke('creator:hide-login-browser'),
  resizeLoginBrowser: (bounds) => ipcRenderer.invoke('creator:resize-browser', bounds),
  importCookies: (opts) => ipcRenderer.invoke('creator:import-cookies', opts),
  clearSession: (accountId) => ipcRenderer.invoke('creator:clear-session', accountId),
  submitLoginBrowser: (opts) => ipcRenderer.invoke('creator:submit-login', opts),
  loginAndCaptureMaloumSession: (opts) =>
    ipcRenderer.invoke('creator:login-and-capture', opts),
  completeLoginCaptureFromActiveLogin: (accountId) =>
    ipcRenderer.invoke('creator:complete-login-capture', { accountId }),
  showChatBrowser: (opts) => ipcRenderer.invoke('creator:show-chat-browser', opts),
  hideChatBrowser: () => ipcRenderer.invoke('creator:hide-chat-browser'),
  resizeChatBrowser: (bounds) => ipcRenderer.invoke('creator:resize-chat-browser', bounds),
  reloadChatBrowser: (accountId) =>
    ipcRenderer.invoke('creator:reload-chat-browser', accountId),
  loadCreatorSession: (opts) => ipcRenderer.invoke('creator:load-session', opts),
  hydrateCreatorProfile: (accountId) =>
    ipcRenderer.invoke('creator:hydrate-profile', accountId),
  hasLocalCreatorProfile: (accountId) =>
    ipcRenderer.invoke('creator:has-local-profile', accountId),
  getLocalCreatorProfileMeta: (accountId) =>
    ipcRenderer.invoke('creator:local-profile-meta', accountId),
  preloadCreatorSessions: (sessions) =>
    ipcRenderer.invoke('creator:preload-sessions', sessions),
  isCreatorSessionWarm: (accountId) =>
    ipcRenderer.invoke('creator:is-session-warm', accountId),
  getActiveChatAccountId: () =>
    ipcRenderer.invoke('creator:get-active-chat-account'),
  prepareChatBrowser: (accountId) =>
    ipcRenderer.invoke('creator:prepare-chat-browser', accountId),
  prepareAllChatBrowsers: (accountIds) =>
    ipcRenderer.invoke('creator:prepare-all-chat-browsers', accountIds),
  isChatPrepared: (accountId) =>
    ipcRenderer.invoke('creator:is-chat-prepared', accountId),
  showVerifyBrowser: (opts) => ipcRenderer.invoke('creator:show-verify-browser', opts),
  hideVerifyBrowser: () => ipcRenderer.invoke('creator:hide-verify-browser'),
  resizeVerifyBrowser: (bounds) => ipcRenderer.invoke('creator:resize-verify-browser', bounds),
  verifyMaloumSession: (opts) => ipcRenderer.invoke('creator:verify-maloum-session', opts),
  reloginMaloumOnVerifyView: (opts) =>
    ipcRenderer.invoke('creator:relogin-maloum-verify', opts),
  loginCreatorLocally: (opts) => ipcRenderer.invoke('creator:login-locally', opts),
  fetchCreatorAvatarImage: (opts) =>
    ipcRenderer.invoke('creator:fetch-avatar-image', opts),
  setDomXTheme: (theme) => ipcRenderer.invoke('creator:set-domx-theme', theme),
  getTranslationSettings: () => ipcRenderer.invoke('creator:get-translation-settings'),
  setTranslationSettings: (settings) =>
    ipcRenderer.invoke('creator:set-translation-settings', settings),
  getCreatorBadgeCounts: () => ipcRenderer.invoke('creator:get-badge-counts'),
  getCreatorBadgeCountsForAccount: (accountId) =>
    ipcRenderer.invoke('creator:get-badge-counts-for-account', accountId),
  setActiveChatter: (payload) => ipcRenderer.invoke('creator:set-active-chatter', payload),
  registerCreatorMapping: (payload) =>
    ipcRenderer.invoke('creator:register-creator-mapping', payload),
  hydrateSentMessages: (payload) =>
    ipcRenderer.invoke('creator:hydrate-sent-messages', payload),
  releaseCreatorChat: (accountId) =>
    ipcRenderer.invoke('creator:release-chat', accountId),
  releaseAllCreatorChats: () => ipcRenderer.invoke('creator:release-all-chats'),
  onCreatorBadgeCountsUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('creator:badge-counts-updated', listener);
    return () => ipcRenderer.removeListener('creator:badge-counts-updated', listener);
  },
  onSentMessageTracked: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('creator:sent-message-tracked', listener);
    return () => ipcRenderer.removeListener('creator:sent-message-tracked', listener);
  },
  onDashboardEntryUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dashboard:entry-updated', listener);
    return () => ipcRenderer.removeListener('dashboard:entry-updated', listener);
  },
  onLoginDetected: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('creator:login-detected', listener);
    return () => ipcRenderer.removeListener('creator:login-detected', listener);
  },
  onWindowResized: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('creator:window-resized', listener);
    return () => ipcRenderer.removeListener('creator:window-resized', listener);
  },
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  installUpdateNow: () => ipcRenderer.invoke('updater:install-now'),
  openMacDownload: () => ipcRenderer.invoke('updater:open-mac-download'),
  onUpdaterChecking: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:checking', listener);
    return () => ipcRenderer.removeListener('updater:checking', listener);
  },
  onUpdaterBlocked: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:blocked', listener);
    return () => ipcRenderer.removeListener('updater:blocked', listener);
  },
  onUpdaterAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:available', listener);
    return () => ipcRenderer.removeListener('updater:available', listener);
  },
  onUpdaterDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:download-progress', listener);
    return () => ipcRenderer.removeListener('updater:download-progress', listener);
  },
  onUpdaterReady: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:ready', listener);
    return () => ipcRenderer.removeListener('updater:ready', listener);
  },
  onUpdaterError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:error', listener);
    return () => ipcRenderer.removeListener('updater:error', listener);
  },
  onUpdaterNotAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:not-available', listener);
    return () => ipcRenderer.removeListener('updater:not-available', listener);
  },
});
