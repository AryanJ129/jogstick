/**
 * macOS pad input: the Chromium Gamepad API in a hidden window (backgroundThrottling off; macOS
 * keeps delivering in the background). Never used on Windows (main uses XInput there). Polled at
 * 250 Hz; sends a frame on change, plus 120 Hz snapshots while any analog input is live, like the
 * addon's XInput thread. Chromium withholds pads until the first button press is seen.
 */

const POLL_MS = 4;
const SNAPSHOT_MS = 1000 / 120;
const LIVE = 0.05;

let index: number | null = null;
let last = '';
let lastSent = 0;

function pick(pads: (Gamepad | null)[]): Gamepad | null {
  if (index !== null) {
    const p = pads[index];
    if (p?.connected) return p;
    index = null;
    last = '';
    window.jogstick.send('pad:message', { kind: 'disconnected' });
  }
  for (const p of pads) {
    if (!p?.connected) continue;
    if (p.mapping !== 'standard') {
      window.jogstick.send('pad:message', { kind: 'nonstandard', id: p.id.slice(0, 200) });
      continue;
    }
    index = p.index;
    window.jogstick.send('pad:message', { kind: 'connected', id: p.id.slice(0, 200) });
    return p;
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function poll(): void {
  const pad = pick(navigator.getGamepads());
  if (!pad) return;
  const buttons = Array.from({ length: 17 }, (_, i) => clamp(pad.buttons[i]?.value ?? 0, 0, 1));
  const axes = Array.from({ length: 4 }, (_, i) => clamp(pad.axes[i] ?? 0, -1, 1));
  const key = buttons.join(',') + '|' + axes.join(',');
  const now = performance.now();
  const live =
    axes.some((a) => Math.abs(a) > LIVE) || (buttons[6] ?? 0) > LIVE || (buttons[7] ?? 0) > LIVE;
  if (key === last && !(live && now - lastSent >= SNAPSHOT_MS)) return;
  last = key;
  lastSent = now;
  window.jogstick.send('pad:message', { kind: 'frame', buttons, axes });
}

setInterval(poll, POLL_MS);

window.jogstick.on('pad:rumble', (data) => {
  const r = data as { low: number; high: number; ms: number };
  const pad = index === null ? null : navigator.getGamepads()[index];
  const actuator = pad?.vibrationActuator;
  // Not every pad/driver exposes rumble on macOS; haptics are optional.
  if (!actuator) return;
  void actuator.playEffect('dual-rumble', {
    duration: r.ms,
    strongMagnitude: r.low,
    weakMagnitude: r.high,
  });
});

export {};
