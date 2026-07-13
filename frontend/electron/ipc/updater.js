const {
  registerUpdaterIpc: registerUpdaterIpcHandlers,
  runInitialUpdateCheck,
  startPeriodicUpdateChecks,
  setMainWindowGetter,
} = require('../updater');

function registerUpdaterIpc(ipcMain) {
  registerUpdaterIpcHandlers(ipcMain);
}

function startUpdateChecks(getMainWindow) {
  setMainWindowGetter(getMainWindow);
  startPeriodicUpdateChecks();
}

module.exports = {
  registerUpdaterIpc,
  runInitialUpdateCheck,
  startUpdateChecks,
  setMainWindowGetter,
};
