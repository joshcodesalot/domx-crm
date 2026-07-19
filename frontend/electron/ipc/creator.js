const { ipcMain } = require('electron');
const creatorBrowser = require('../creatorBrowser');
const { isUpdateBlocked } = require('../updater');

const UPDATE_REQUIRED_ERROR = 'App update required. Please update before continuing.';

function guardCreatorIpc(handler) {
  return async (...args) => {
    if (isUpdateBlocked()) {
      throw new Error(UPDATE_REQUIRED_ERROR);
    }

    return handler(...args);
  };
}

function registerCreatorIpc() {
  ipcMain.handle(
    'creator:show-login-browser',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.showLoginBrowser(payload))
  );

  ipcMain.handle(
    'creator:resize-browser',
    guardCreatorIpc(async (_event, bounds) => {
      creatorBrowser.resizeLoginBrowser(bounds);
    })
  );

  ipcMain.handle(
    'creator:hide-login-browser',
    guardCreatorIpc(async () => {
      creatorBrowser.hideLoginBrowser();
    })
  );

  ipcMain.handle(
    'creator:import-cookies',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.importCookies(payload))
  );

  ipcMain.handle(
    'creator:clear-session',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.clearSession(accountId))
  );

  ipcMain.handle(
    'creator:submit-login',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.submitLogin(payload))
  );

  ipcMain.handle(
    'creator:login-and-capture',
    guardCreatorIpc(async (_event, payload) =>
      creatorBrowser.loginAndCaptureMaloumSession(payload)
    )
  );

  ipcMain.handle(
    'creator:complete-login-capture',
    guardCreatorIpc(async (_event, payload) =>
      creatorBrowser.completeLoginCaptureFromActiveLogin(payload.accountId)
    )
  );

  ipcMain.handle(
    'creator:show-chat-browser',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.showChatBrowser(payload))
  );

  ipcMain.handle(
    'creator:resize-chat-browser',
    guardCreatorIpc(async (_event, bounds) => {
      creatorBrowser.resizeChatBrowser(bounds);
    })
  );

  ipcMain.handle(
    'creator:hide-chat-browser',
    guardCreatorIpc(async () => {
      creatorBrowser.hideChatBrowser();
    })
  );

  ipcMain.handle(
    'creator:reload-chat-browser',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.reloadChatBrowser(accountId))
  );

  ipcMain.handle(
    'creator:load-session',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.loadCreatorSession(payload))
  );

  ipcMain.handle(
    'creator:hydrate-profile',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.hydrateCreatorProfile(accountId))
  );

  ipcMain.handle(
    'creator:has-local-profile',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.hasLocalCreatorProfile(accountId))
  );

  ipcMain.handle(
    'creator:local-profile-meta',
    guardCreatorIpc(async (_event, accountId) =>
      creatorBrowser.getLocalCreatorProfileMeta(accountId)
    )
  );

  ipcMain.handle(
    'creator:preload-sessions',
    guardCreatorIpc(async (_event, sessions) => creatorBrowser.preloadCreatorSessions(sessions))
  );

  ipcMain.handle(
    'creator:is-session-warm',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.isCreatorSessionWarm(accountId))
  );

  ipcMain.handle(
    'creator:get-active-chat-account',
    guardCreatorIpc(async () => creatorBrowser.getActiveChatAccountId())
  );

  ipcMain.handle(
    'creator:prepare-chat-browser',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.prepareChatBrowser(accountId))
  );

  ipcMain.handle(
    'creator:prepare-all-chat-browsers',
    guardCreatorIpc(async (_event, accountIds) => creatorBrowser.prepareAllChatBrowsers(accountIds))
  );

  ipcMain.handle(
    'creator:is-chat-prepared',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.isChatPrepared(accountId))
  );

  ipcMain.handle(
    'creator:show-verify-browser',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.showVerifyBrowser(payload))
  );

  ipcMain.handle(
    'creator:resize-verify-browser',
    guardCreatorIpc(async (_event, bounds) => {
      creatorBrowser.resizeVerifyBrowser(bounds);
    })
  );

  ipcMain.handle(
    'creator:hide-verify-browser',
    guardCreatorIpc(async () => {
      creatorBrowser.hideVerifyBrowser();
    })
  );

  ipcMain.handle(
    'creator:verify-maloum-session',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.verifyMaloumSessionForAccount(payload))
  );

  ipcMain.handle(
    'creator:relogin-maloum-verify',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.reloginMaloumOnVerifyView(payload))
  );

  ipcMain.handle(
    'creator:fetch-avatar-image',
    guardCreatorIpc(async (_event, payload) => creatorBrowser.fetchCreatorAvatarImage(payload))
  );

  ipcMain.handle(
    'creator:set-domx-theme',
    guardCreatorIpc(async (_event, theme) => creatorBrowser.setDomXTheme(theme))
  );

  ipcMain.handle(
    'creator:get-translation-settings',
    guardCreatorIpc(async () => creatorBrowser.getTranslationSettings())
  );

  ipcMain.handle(
    'creator:set-translation-settings',
    guardCreatorIpc(async (_event, settings) => creatorBrowser.setTranslationSettings(settings))
  );

  ipcMain.handle(
    'creator:get-badge-counts',
    guardCreatorIpc(async () => creatorBrowser.getAllCreatorBadgeStates())
  );

  ipcMain.handle(
    'creator:get-badge-counts-for-account',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.getCreatorBadgeState(accountId))
  );

  ipcMain.handle(
    'creator:set-active-chatter',
    guardCreatorIpc(async (_event, payload) => {
      creatorBrowser.setActiveChatter(payload);
      return { ok: true };
    })
  );

  ipcMain.handle(
    'creator:register-creator-mapping',
    guardCreatorIpc(async (_event, payload) => {
      creatorBrowser.registerCreatorMapping(payload.accountId, payload.creatorId);
      return { ok: true };
    })
  );

  ipcMain.handle(
    'creator:hydrate-sent-messages',
    guardCreatorIpc(async (_event, payload) =>
      creatorBrowser.hydrateSentMessages(payload.accountId, payload.records))
  );

  ipcMain.handle(
    'creator:release-chat',
    guardCreatorIpc(async (_event, accountId) => creatorBrowser.releaseCreatorChat(accountId))
  );

  ipcMain.handle(
    'creator:release-all-chats',
    guardCreatorIpc(async () => creatorBrowser.releaseAllCreatorChats())
  );
}

module.exports = { registerCreatorIpc };
