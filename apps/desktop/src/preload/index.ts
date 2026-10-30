import { contextBridge, ipcRenderer } from 'electron';

// The only channels a renderer can use. Main validates every message it receives (zod).
const FROM_MAIN = new Set(['overlay:view', 'pad:rumble']);
const TO_MAIN = new Set(['pad:message']);

contextBridge.exposeInMainWorld('jogstick', {
  platform: process.platform,
  on(channel: string, cb: (data: unknown) => void): void {
    if (FROM_MAIN.has(channel)) ipcRenderer.on(channel, (_e, data: unknown) => cb(data));
  },
  send(channel: string, data: unknown): void {
    if (TO_MAIN.has(channel)) ipcRenderer.send(channel, data);
  },
});
