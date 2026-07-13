const PRODUCTION_API_URL = 'https://api.low7labs.cloud';
const LOCAL_API_URL = 'http://localhost:3001';

function getApiUrl() {
  if (process.env.DOMX_API_URL) {
    return process.env.DOMX_API_URL;
  }

  try {
    const { app } = require('electron');
    return app.isPackaged ? PRODUCTION_API_URL : LOCAL_API_URL;
  } catch {
    return LOCAL_API_URL;
  }
}

module.exports = {
  PRODUCTION_API_URL,
  LOCAL_API_URL,
  getApiUrl,
};
