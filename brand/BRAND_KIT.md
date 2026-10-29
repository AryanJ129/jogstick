# Jogstick — Brand Kit

_Generated 2026-10-29 · Direction "Tally": an industrial control surface with one broadcast-tally
accent that only ever means "live mode". Approved by Aryan at Stage 3 on 2026-10-29, with the
changes listed in §11._

Files: `tokens.css` (source of truth), `tailwind-theme.css` (Tailwind v4 `@theme`),
`brand-preview.html` (open it in a browser), `tray/` (generated), `fonts/` (bundled, OFL),
`scripts/brand-check.ts` (`pnpm brand:check`), `scripts/tray-icons.ts` (`pnpm brand:icons`).

## 1. Essence

- **What it is**: an open-source desktop app that makes a game controller feel like a real editing
  surface for DaVinci Resolve.
- **Who it's for**: indie editors, YouTubers, colorists on a budget, couch editors.
- **Personality**: tactile, precise, playful-serious, honest, quiet until live.
- **Voice**: a peer at the next desk. Short, plain sentences; say what the pad will do and when it
  won't. Labels are nouns in caps (EDIT · TRIM); messages are sentences in sentence case. Never
  hype, never "magic".
- **What it is NOT**: a gamer RGB app; a Blackmagic product (no imitation of their branding); a
  glossy SaaS dashboard.

## 2. Direction

A keycap deck on charcoal panels one step darker than Resolve's own UI. Labels look engraved:
uppercase, wide Archivo, tracked. Numbers (timecode, Hz, wheel values, combos) are always in
JetBrains Mono with tabular figures. Tactility is selective: keycap-shaped controls get a 1 px top
highlight and a pressed state that sinks 1 px; panels and text are flat. One signal yellow, the
tally, is lit only when something is live.

**Cross-reference**: feels like a Speed Editor's keycap deck lit by a broadcast tally light, with
Teenage Engineering-style spec labels, on Resolve's charcoal instead of TE's black and orange.

**The accent rule (hard):** yellow means "live mode" and nothing else. Live = the active mode and
layer on the overlay, a binding that is firing, the gate-matched indicator, the connected/color tray
states, the lit lamp in the app header. Primary buttons, focus rings, selection, links, charts and
decoration are neutral (`--primary`, `--focus`, `--text`). Warning states (PAUSED, RECALIBRATE) use
`--warning` + an icon; errors use `--danger` + an icon. Never the accent.

## 3. Color

**Mode**: dark-default with light variant (`data-theme="light"` on `<html>`, chosen from
`nativeTheme` or the user's setting). The overlay is always dark (§3.2).

| Token           | Dark      | Light     | Use                                               |
| --------------- | --------- | --------- | ------------------------------------------------- |
| `--bg`          | `#141416` | `#f2f1ec` | window background                                 |
| `--surface`     | `#1c1c1f` | `#fafaf7` | panels, cards                                     |
| `--surface-2`   | `#26262a` | `#e7e5de` | nested panels, inputs                             |
| `--border`      | `#34343a` | `#d3d0c7` | dividers                                          |
| `--text`        | `#eceae4` | `#18181b` | primary text                                      |
| `--text-muted`  | `#9a988f` | `#5e5c55` | secondary text (not on `--surface-2`)             |
| `--accent`      | `#ffc42e` | `#ffc42e` | **live mode only**: fills                         |
| `--accent-text` | `#ffc42e` | `#7a5600` | live mode as text                                 |
| `--accent-edge` | `#ffc42e` | `#7a5600` | outline of accent fills (needed on light: 1.41:1) |
| `--accent-fg`   | `#141416` | `#18181b` | text on an accent fill                            |
| `--primary`     | `#eceae4` | `#18181b` | primary button (neutral, inverted)                |
| `--primary-fg`  | `#141416` | `#fafaf7` | text on primary                                   |
| `--focus`       | `#eceae4` | `#18181b` | focus ring, 2 px                                  |
| `--success`     | `#4cc38a` | `#176a43` | connected, OK                                     |
| `--warning`     | `#ff7a1f` | `#a34000` | paused, recalibrate, Steam/admin notices          |
| `--danger`      | `#ff5f7a` | `#c4183f` | errors, controller lost                           |

Keycap surfaces: `--key-top`, `--key-face`, `--key-edge-hi`, `--key-edge-lo` (see `tokens.css`).

### 3.1 Why these hues

Resolve already owns red (playhead), orange (selection, active node) and blue/teal (default clip
colors). Yellow is the strong hue left over, so the overlay label is never mistaken for Resolve's
UI, and it survives as a 16 px tray glyph. It also stays clear of Xbox green (no affiliation) and
TE orange. Warning sits at hue ≈ 24° (well into orange, away from the 43° accent) and is clearly
darker; danger is a pink-red at ≈ 350°.

The charcoal values are approximations of Resolve 21's UI. Re-sample them from the tester's Test 3
recording when it arrives and adjust `--bg`/`--surface` if Jogstick's window looks lighter than
Resolve's.

### 3.2 Overlay

Always on its own dark chip: `--overlay-chip` = `#141416` at 90 % opacity, 1 px
`rgb(255 255 255 / 0.08)` border, radius 4 px, height 30 px, Archivo wide 700 13 px uppercase,
tracked +0.08em. Content:

| State                                 | Text color                        | Icon                 |
| ------------------------------------- | --------------------------------- | -------------------- |
| `EDIT`, `EDIT · TRIM`, `COLOR · LIFT` | `--overlay-live` (mode and layer) | solid lamp dot       |
| `PAUSED`                              | `--overlay-warning`               | pause bars           |
| `RECALIBRATE`                         | `--overlay-warning`               | crosshair            |
| errors (`CONTROLLER LOST`, …)         | `--overlay-danger`                | filled circle with ✕ |

The separator `·` is `--overlay-text` at 50 %.

### 3.3 Verified numbers (`pnpm brand:check`, exits 1 on any failure)

- Every text pair in both themes ≥ 4.5:1 (lowest: light `danger` on `surface-2` 4.69:1, dark
  `text-muted` on `surface` 5.88:1). Primary label 15.3:1 (dark) / 16.9:1 (light). Focus ring and
  accent edge ≥ 3:1 against the background.
- Overlay text on the chip over pure white video (the worst case): live 8.87:1, text 11.75:1,
  warning 5.42:1, danger 4.82:1. Over black and over a yellow bar, all higher.
- Separation (OKLab ΔE, normal vision): live↔warning 0.17, live↔danger 0.26, warning↔danger 0.12.
  Simulated deuteranopia/protanopia: live↔warning 0.12/0.18, warning↔danger 0.09/0.13. Under
  deuteranopia live and warning become similar olive hues and stay apart only by lightness, icon
  and words. That is why warning and error states must always carry their icon. This is a rule, not
  a nicety.

## 4. Typography

| Role    | Family         | Weights | Notes                                                   |
| ------- | -------------- | ------- | ------------------------------------------------------- |
| Display | Archivo        | 700–800 | `font-stretch: 125%`; wordmark, mode labels, overlay    |
| Heading | Archivo        | 600–700 | `font-stretch: 100%`                                    |
| Body    | Archivo        | 400–500 | `font-stretch: 100%`                                    |
| Label   | Archivo        | 700     | 11 px, 125 %, uppercase, +0.08em: the "engraved" label  |
| Mono    | JetBrains Mono | 400–600 | timecode, Hz, values, combos, the Console; tabular-nums |

**Source**: Google Fonts, both SIL OFL 1.1. Bundled in `fonts/` as latin variable woff2 (Archivo
wdth 62–125 / wght 100–900; JetBrains Mono wght 100–800) with their licences. The app never fetches
fonts.
**Why this pair**: Archivo's width axis gives one family both the wide engraved panel label and a
normal-width reading face; JetBrains Mono makes every number read like a meter.
**Type scale**: 1.2 ratio from a 14 px base (desktop app): 11 / 12 / 13 / 14 / 17 / 20 / 24 / 29 /
35 / 42.
**Line height & tracking**: body 1.5, headings 1.1; labels +0.08em; display −0.01em (wordmark
+0.02em).

## 5. Spacing & radius

**Spacing**: 4 px base: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64.
**Radius**: 2 / 4 (inputs, overlay chip) / 6 (keycaps) / 10 (cards) / full (lamps, dots).
**Layout**: designed for a 1280×720 minimum window; sidebar nav + content, 24 px gutters. No page
scroll at 1280×720 on Status.

## 6. Motion

**Principle**: snaps like key travel. Motion confirms an input; nothing loops, pulses, glows or
blurs.
**Easing**: `--ease-snap` `cubic-bezier(0.2, 0, 0, 1)` for presses and toggles; `--ease-out`
`cubic-bezier(0.16, 1, 0.3, 1)` for panels.
**Durations**: press 80 ms, snap 120 ms, panel 180 ms. Nothing longer.
**Reduced motion**: under `prefers-reduced-motion: reduce` all three durations are 0 ms and every
transition/animation is instant (`tokens.css`). Haptics (pad buzzes) are not affected.

## 7. Imagery

- **Photography**: none in the app. README and social preview use real screenshots of Resolve with
  the overlay, nothing staged.
- **Illustration**: one line drawing of the controller (Mapping screen), 1.5 px strokes in
  `--text-muted`; the pressed control fills with `--accent` while held (live).
- **Icons**: Lucide (ISC), 1.5 px stroke, 16/20 px. Status icons for the overlay and tray are the
  custom shapes in §8.
- **Texture**: none. Flat panels; keycaps carry the only depth.
- **Anti-patterns (hard)**: no purple-blue gradients; no glassmorphism or blur; no glow, bloom or
  neon; no Xbox green; no imitation of Blackmagic's branding or Speed Editor artwork; no RGB/gamer
  styling; yellow never used for anything that isn't live.

## 8. Logo, wordmark, tray

**Wordmark**: `JOGSTICK` in Archivo 800 at 125 % width, +0.02em, followed by the lamp: a circle
0.34 em wide sitting at cap height. The lamp is an outline (`--text-muted`) in static uses (README,
social preview, docs) and lit (`--accent`) only in the app header while Jogstick is driving
Resolve. Clear space: the cap height on every side. Minimum size: 14 px cap height.

**Tray icons** (`tray/`, generated by `pnpm brand:icons`; four states):

| State     | Shape                                   | Windows fill |
| --------- | --------------------------------------- | ------------ |
| connected | one solid dot (Edit mode live)          | accent       |
| color     | three dots (the three Primaries wheels) | accent       |
| paused    | two bars                                | warning      |
| error     | a cross                                 | danger       |

- Windows: `tray/win/dark/` and `tray/win/light/`, each `<state>.ico` (16/24/32) plus
  `<state>.png`, `@1.5x`, `@2x`. The light-taskbar set adds a 1 px (at 16 px) `#141416` stroke
  around every shape, because a yellow fill alone disappears on a light taskbar. The host picks the
  set from `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` (the system theme, which the
  taskbar follows) and swaps on `nativeTheme` `updated`.
- macOS: `tray/mac/<state>Template.png` and `@2x`, black + alpha; macOS tints template images, so
  states differ by shape only.

## 9. References

Stage 2 hunt, 2026-10-29 (most pages carry no publication date):

- Teenage Engineering design guide — https://blakecrosley.com/guides/design/teenage-engineering —
  undated (© 2026) — spec-grid labels, mono for values, one identity color.
- shadcn: Teenage Engineering design system — https://www.shadcn.io/design/teenage-engineering —
  undated — chrome stays monochrome; color comes from content.
- daisyUI: material / dimensional UI — https://trends.daisyui.com/material-dimensional-ui/ —
  undated — physical cues only where they explain the interaction.
- Apiko: UI/UX design trends 2026 — https://apiko.com/blog/ux-design-trends/ — 2026 — tactility is
  used selectively alongside flat clarity.
- Clay: skeuomorphism best practices 2026 — https://clay.global/blog/skeuomorphism-ui — 2026 —
  avoid decorative fake materials.
- Refero: Axiom — https://styles.refero.design/style/c809190a-035c-458d-87ed-4758807dd84e —
  undated — dark console, one accent used sparingly (orange: confirms orange is crowded).
- Refero: Virtual — https://styles.refero.design/style/572bc29f-8827-4f77-b248-08dddf1c2e26 —
  undated — same; 2 px outlines on interactive elements.
- Visily: Control Room — https://www.visily.ai/design-systems/control-room-devtools — undated —
  dark charcoal, sharp corners; its Space Grotesk/Inter pairing is the default we avoid.
- Red Dot: DaVinci Resolve Speed Editor —
  https://www.red-dot.org/zh/project/blackmagic-davinci-resolve-speed-editor-59116 — undated —
  color-coded keys for the main functions (we take the idea, not the look).

Behance/Dribbble searches returned no usable project pages; Aryan waived a further hunt.

## 10. Notes for downstream skills

- `frontend-craft` (Phase 4) reads this file and imports `tokens.css` + `tailwind-theme.css`; use
  the tokens verbatim.
- The accent rule in §2 and the anti-patterns in §7 are hard rules. Treat any yellow that isn't
  live as RED in review.
- Warning and error UI always pairs color with an icon and words (§3.3).
- Any token change: run `pnpm brand:check` and `pnpm brand:icons`, and re-open `brand-preview.html`.

## 11. Changes requested at Stage 3 (2026-10-29)

1. Yellow only ever means live mode; the overlay always sits on its own ~90 % dark chip; warning
   states use warning/danger + an icon, never the accent. → §2, §3.2; primary buttons and focus
   moved to neutral tokens.
2. Warning moved further from the accent (`#ff9f43` → `#ff7a1f`); accent, warning and danger shown
   side by side at overlay size in `brand-preview.html` §2. → §3.3.
3. Windows tray: light- and dark-taskbar variants switched on `nativeTheme`, dark stroke on light;
   macOS template icons as proposed. → §8.
4. `prefers-reduced-motion`: snaps become instant. → §6.
5. No further reference hunt. → §9.
