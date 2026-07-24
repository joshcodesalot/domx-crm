const { ipcMain } = require('electron');
const messagePro = require('../messagePro');
const { isUpdateBlocked } = require('../updater');

const UPDATE_REQUIRED_ERROR = 'App update required. Please update before continuing.';

function guardMessageProIpc(handler) {
  return async (...args) => {
    if (isUpdateBlocked()) {
      throw new Error(UPDATE_REQUIRED_ERROR);
    }

    return handler(...args);
  };
}

function registerMessageProIpc() {
  ipcMain.handle(
    'messagepro:open-window',
    guardMessageProIpc(async () => messagePro.openMessageProWindow())
  );

  ipcMain.handle(
    'messagepro:show-view',
    guardMessageProIpc(async (_event, payload) => messagePro.showView(payload || {}))
  );

  ipcMain.handle(
    'messagepro:set-bounds',
    guardMessageProIpc(async (_event, bounds) => {
      messagePro.setBounds(bounds);
    })
  );

  ipcMain.handle(
    'messagepro:close-tab',
    guardMessageProIpc(async (_event, payload) => messagePro.closeTab(payload || {}))
  );

  ipcMain.handle(
    'messagepro:close-creator',
    guardMessageProIpc(async (_event, payload) => messagePro.closeCreator(payload || {}))
  );

  ipcMain.handle(
    'messagepro:hide-view',
    guardMessageProIpc(async () => {
      messagePro.hideActiveView();
    })
  );
}

module.exports = { registerMessageProIpc };
