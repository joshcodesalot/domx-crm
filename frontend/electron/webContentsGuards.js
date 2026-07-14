function isLiveWebContents(webContents) {
  return Boolean(webContents && !webContents.isDestroyed());
}

function isLiveBrowserView(view) {
  return Boolean(view && isLiveWebContents(view.webContents));
}

function applyWebContentsGuards(webContents) {
  if (!isLiveWebContents(webContents)) {
    return;
  }

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown' && input.button === 'middle') {
      event.preventDefault();
    }
  });
}

module.exports = {
  applyWebContentsGuards,
  isLiveWebContents,
  isLiveBrowserView,
};
