/** What the preload exposes (src/preload/index.ts); channels outside its allowlist are ignored. */
interface Window {
  jogstick: {
    platform: string;
    on(channel: string, cb: (data: unknown) => void): void;
    send(channel: string, data: unknown): void;
  };
}
