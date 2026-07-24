const { app } = require('electron');
const path = require('path');

// Legacy folder name "DomX" is intentionally preserved for backward compatibility
// with existing Windows user data.

function initializeAppPaths() {
  const dataRoot = path.join(app.getPath('appData'), 'DomX');
  app.setPath('userData', dataRoot);
}

function getAppDataRoot() {
  return app.getPath('userData');
}

module.exports = {
  initializeAppPaths,
  getAppDataRoot,
};
