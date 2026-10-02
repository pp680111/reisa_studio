const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.resolve(__dirname, '../apps/desktop/dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  window.webContents.on('render-process-gone', (_event, detail) => errors.push(detail.reason));
  try {
    await window.loadFile(path.resolve(__dirname, '../apps/desktop/dist/index.html'));
    const state = await window.webContents.executeJavaScript(
      '({title:document.title,heading:document.querySelector("h1")?.textContent,bridge:window.reisa,nodeAvailable:typeof window.require,overflow:document.documentElement.scrollWidth>innerWidth})',
    );
    assert.match(state.title, /Reisa Studio/);
    assert.match(state.heading, /想法在这里/);
    assert.equal(state.bridge.uiOnly, true);
    assert.equal(state.nodeAvailable, 'undefined');
    assert.equal(state.overflow, false);
    assert.deepEqual(errors, []);
    console.log('Electron smoke passed:', JSON.stringify(state));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
