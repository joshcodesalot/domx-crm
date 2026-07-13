function applyWebContentsGuards(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown' && input.button === 'middle') {
      event.preventDefault();
    }
  });
}

module.exports = { applyWebContentsGuards };
