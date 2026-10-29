import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('jogstick', {
  platform: process.platform,
});
