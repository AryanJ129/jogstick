// Generates the tray icons from the shapes below (no dependencies, deterministic output).
//   brand/tray/mac/<state>Template.png, @2x   black + alpha; macOS tints template images itself,
//                                             so the four states differ by shape only.
//   brand/tray/win/<taskbar>/<state>.png, @1.5x, @2x and <state>.ico (16/24/32)
//                                             filled in the state color; on a light taskbar every
//                                             shape gets a dark stroke so yellow doesn't vanish.
// The host picks win/dark or win/light from nativeTheme.shouldUseDarkColorsForSystemIntegratedUI.
// Run: pnpm brand:icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type RGB = [number, number, number];
type Sdf = (x: number, y: number) => number; // signed distance on a 16×16 grid, < 0 inside

const circle =
  (cx: number, cy: number, r: number): Sdf =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;
const box =
  (x0: number, y0: number, x1: number, y1: number, r: number): Sdf =>
  (x, y) => {
    const [cx, cy, hx, hy] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 - r, (y1 - y0) / 2 - r];
    const [qx, qy] = [Math.abs(x - cx) - hx, Math.abs(y - cy) - hy];
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
const capsule =
  (ax: number, ay: number, bx: number, by: number, r: number): Sdf =>
  (x, y) => {
    const [px, py, dx, dy] = [x - ax, y - ay, bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - dx * t, py - dy * t) - r;
  };
const union =
  (...shapes: Sdf[]): Sdf =>
  (x, y) =>
    Math.min(...shapes.map((s) => s(x, y)));

// Colors mirror tokens.css: accent = live mode only; paused is a warning, error is danger.
const ACCENT: RGB = [0xff, 0xc4, 0x2e];
const WARNING: RGB = [0xff, 0x7a, 0x1f];
const DANGER: RGB = [0xff, 0x5f, 0x7a];
const STROKE: RGB = [0x14, 0x14, 0x16];

const dots = [90, 210, 330].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return circle(8 + 4.4 * Math.cos(a), 8 - 4.4 * Math.sin(a), 2.5);
});
const STATES: { name: string; shape: Sdf; color: RGB }[] = [
  // Connected, Edit mode live: one solid dot (the stick cap).
  { name: 'connected', shape: circle(8, 8, 5.5), color: ACCENT },
  // Color mode live: three dots, like the three Primaries wheels.
  { name: 'color', shape: union(...dots), color: ACCENT },
  // Paused: two bars.
  {
    name: 'paused',
    shape: union(box(3.5, 2.5, 6.75, 13.5, 1), box(9.25, 2.5, 12.5, 13.5, 1)),
    color: WARNING,
  },
  // Error: a cross.
  {
    name: 'error',
    shape: union(capsule(3.5, 3.5, 12.5, 12.5, 1.6), capsule(12.5, 3.5, 3.5, 12.5, 1.6)),
    color: DANGER,
  },
];

const SS = 8; // supersamples per axis

/** RGBA pixels: fill where inside, optional stroke of `strokeW` grid units just outside. */
function render(size: number, shape: Sdf, fill: RGB, stroke?: RGB, strokeW = 1): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const k = 16 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [nf, ns] = [0, 0];
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const d = shape((x + (i + 0.5) / SS) * k, (y + (j + 0.5) / SS) * k);
          if (d < 0) nf++;
          else if (stroke && d < strokeW) ns++;
        }
      }
      const total = SS * SS;
      const a = (nf + ns) / total;
      const o = (y * size + x) * 4;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++)
        px[o + c] = Math.round((fill[c] * nf + (stroke?.[c] ?? 0) * ns) / (nf + ns));
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}
/** ICO with PNG-compressed entries (Windows Vista and later). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size, e);
    header.writeUInt8(size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const out = (rel: string) => fileURLToPath(new URL(`../tray/${rel}`, import.meta.url));
mkdirSync(out('mac'), { recursive: true });
mkdirSync(out('win/dark'), { recursive: true });
mkdirSync(out('win/light'), { recursive: true });

let written = 0;
for (const { name, shape, color } of STATES) {
  for (const [size, suffix] of [
    [16, ''],
    [32, '@2x'],
  ] as const) {
    writeFileSync(
      out(`mac/${name}Template${suffix}.png`),
      png(size, render(size, shape, [0, 0, 0])),
    );
    written++;
  }
  for (const taskbar of ['dark', 'light'] as const) {
    const stroke = taskbar === 'light' ? STROKE : undefined;
    const sizes = [
      [16, ''],
      [24, '@1.5x'],
      [32, '@2x'],
    ] as const;
    const images = sizes.map(([size]) => ({
      size,
      data: png(size, render(size, shape, color, stroke)),
    }));
    sizes.forEach(([, suffix], i) =>
      writeFileSync(out(`win/${taskbar}/${name}${suffix}.png`), images[i].data),
    );
    writeFileSync(out(`win/${taskbar}/${name}.ico`), ico(images));
    written += sizes.length + 1;
  }
}
console.log(`tray icons: wrote ${written} files for ${STATES.length} states`);
