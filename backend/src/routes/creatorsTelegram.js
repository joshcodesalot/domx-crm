function abortPendingTelegramLogin(accountId) {
  const { abortPendingLogin } = require('../services/telegramWorker');
  void abortPendingLogin(accountId);
}

function startTelegramAfterCreate(creatorId, accountId) {
  const { onCreatorSaved } = require('../services/telegramWorker');
  void onCreatorSaved(creatorId, accountId).catch((err) => {
    console.warn('[telegram] Failed to start client after create:', err.message);
  });
}

function disconnectTelegramCreator(creatorId) {
  const { disconnectCreator } = require('../services/telegramWorker');
  void disconnectCreator(creatorId);
}

module.exports = {
  abortPendingTelegramLogin,
  startTelegramAfterCreate,
  disconnectTelegramCreator,
};
