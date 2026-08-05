/**
 * Attach Electron before-input-event so keystrokes are counted reliably
 * on macOS (DOM keydown can miss IME / focus edge cases).
 * @param {import('electron').WebContents} webContents
 */
function attachActivityKeyListener(webContents) {
  if (!webContents || webContents.isDestroyed()) return;

  webContents.on('before-input-event', (_event, input) => {
    if (!input || input.type !== 'keyDown' || input.isAutoRepeat) {
      return;
    }
    if (webContents.isDestroyed()) return;
    try {
      webContents.send('activity:keydown');
    } catch {
      // Window may be closing.
    }
  });
}

module.exports = { attachActivityKeyListener };
