import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 480,
    minHeight: 540,
    title: 'Reisa Studio',
    backgroundColor: '#f8f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const devUrl = process.env.REISA_DEV_URL;
  if (!app.isPackaged && devUrl === 'http://127.0.0.1:5173') void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../dist/index.html'));
}
void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
