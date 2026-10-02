import { contextBridge } from 'electron';
// No generic IPC, filesystem, credentials, or private module data exposed to the renderer.
contextBridge.exposeInMainWorld(
  'reisa',
  Object.freeze({ platform: process.platform, uiOnly: true }),
);
