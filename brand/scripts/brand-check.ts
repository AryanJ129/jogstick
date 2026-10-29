// Checks brand/tokens.css: WCAG contrast for every text pair in both themes, overlay colors on
// the 90 % chip over the worst-case video (pure white and pure black behind it), and how far apart
// accent / warning / danger are (OKLab ΔE, also under simulated deuteranopia and protanopia).
// Exits 1 if any hard threshold fails. Run: pnpm brand:check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type RGB = [number, number, number];

const css = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const dark = block(':root');
const light = { ...dark, ...block("[data-theme='light']") };

function hex(v: string | undefined, name: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(v ?? '');
  if (!m) throw new Error(`--${name} is not a 6-digit hex: ${v}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: RGB, alpha: number, bg: RGB): RGB =>
  fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB;

function oklab(rgb: RGB, cvd?: number[][]): RGB {
  let [r, g, b] = rgb.map(lin);
  if (cvd) {
    [r, g, b] = cvd.map((row) => Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)));
  }
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const deltaE = (a: RGB, b: RGB, cvd?: number[][]) => {
  const [x, y] = [oklab(a, cvd), oklab(b, cvd)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const DEUTAN = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
const PROTAN = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
];

let failures = 0;
function check(label: string, value: number, min: number, unit = ':1') {
  const ok = value >= min;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${value.toFixed(2)}${unit}  (min ${min})`,
  );
}

const TEXT_ON = ['bg', 'surface', 'surface-2'];
const TEXT = ['text', 'text-muted', 'accent-text', 'success', 'warning', 'danger'];
for (const [theme, t] of [
  ['dark', dark],
  ['light', light],
] as const) {
  console.log(`\n${theme} theme: text pairs (WCAG AA body 4.5)`);
  for (const fg of TEXT) {
    for (const bg of TEXT_ON) {
      // Muted text never sits on surface-2 (nested panels use --text there).
      if (fg === 'text-muted' && bg === 'surface-2') continue;
      check(`${fg} on ${bg}`, contrast(hex(t[fg], fg), hex(t[bg], bg)), 4.5);
    }
  }
  check(
    'primary-fg on primary (button label)',
    contrast(hex(t['primary-fg'], 'primary-fg'), hex(t.primary, 'primary')),
    4.5,
  );
  check('focus ring vs bg (non-text 3.0)', contrast(hex(t.focus, 'focus'), hex(t.bg, 'bg')), 3.0);
  check(
    'accent-fg on accent (live chip label)',
    contrast(hex(t['accent-fg'], 'accent-fg'), hex(t.accent, 'accent')),
    4.5,
  );
  // Non-text (WCAG 1.4.11): an accent-filled control must be findable by its fill or its edge.
  const fill = Math.max(
    contrast(hex(t.accent, 'accent'), hex(t.bg, 'bg')),
    contrast(hex(t['accent-edge'], 'accent-edge'), hex(t.bg, 'bg')),
  );
  check('accent fill or accent-edge vs bg (non-text 3.0)', fill, 3.0);
}

console.log('\noverlay on the chip, worst-case video behind it (body 4.5)');
const chip = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(dark['overlay-chip'] ?? '');
if (!chip) throw new Error('--overlay-chip must be rgb(r g b / a)');
const chipRgb: RGB = [Number(chip[1]), Number(chip[2]), Number(chip[3])];
const alpha = Number(chip[4]);
for (const [video, behind] of [
  ['white', [255, 255, 255]],
  ['black', [0, 0, 0]],
  ['yellow bar', [255, 196, 46]],
] as [string, RGB][]) {
  const eff = over(chipRgb, alpha, behind);
  for (const fg of ['overlay-live', 'overlay-text', 'overlay-warning', 'overlay-danger']) {
    check(`${fg} on chip over ${video}`, contrast(hex(dark[fg], fg), eff), 4.5);
  }
}

console.log('\nseparation: live accent vs warning vs danger (OKLab ΔE; 0.10 ≈ clearly different)');
const trio = (['overlay-live', 'overlay-warning', 'overlay-danger'] as const).map(
  (n) => [n, hex(dark[n], n)] as const,
);
for (let i = 0; i < trio.length; i++) {
  for (let j = i + 1; j < trio.length; j++) {
    const [[an, a], [bn, b]] = [trio[i], trio[j]];
    check(`${an} vs ${bn}`, deltaE(a, b), 0.1, '');
    // Colour-blind views are reported, not gated: the overlay never relies on colour alone
    // (warning and danger states always carry an icon and their own words).
    console.log(
      `info  ${`${an} vs ${bn}`.padEnd(52)} deutan ${deltaE(a, b, DEUTAN).toFixed(3)}  protan ${deltaE(a, b, PROTAN).toFixed(3)}`,
    );
  }
}

console.log('\ntailwind-theme.css literals match tokens.css');
const tw = readFileSync(fileURLToPath(new URL('../tailwind-theme.css', import.meta.url)), 'utf8');
const twLiteral = tw.slice(tw.indexOf('@theme {'));
let compared = 0;
for (const m of twLiteral.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
  compared++;
  const same = dark[m[1]] === m[2].trim();
  if (!same) failures++;
  console.log(
    `${same ? 'PASS' : 'FAIL'}  --${m[1]}${same ? '' : `: tailwind ${m[2].trim()} ≠ tokens ${dark[m[1]]}`}`,
  );
}
// A zero count would mean the parse found nothing and the check passed vacuously.
check('tailwind literals compared', compared, 17, '');

console.log(
  failures === 0 ? '\nbrand check: all hard checks passed' : `\nbrand check: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
