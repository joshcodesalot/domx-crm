const { app } = require('electron');
const path = require('path');

// Legacy folder name "DomX" is intentionally preserved for backward compatibility
// with existing Windows user data (sessions, partitions, profiles).

function initializeAppPaths() {
  const dataRoot = path.join(app.getPath('appData'), 'DomX');
  app.setPath('userData', dataRoot);
}

function getAppDataRoot() {
  return app.getPath('userData');
}

function getProfilesRoot() {
  return path.join(getAppDataRoot(), 'profiles');
}

module.exports = {
  initializeAppPaths,
  getAppDataRoot,
  getProfilesRoot,
};
