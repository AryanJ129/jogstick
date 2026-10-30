import '../../../../../brand/tokens.css';
import './overlay.css';

/** Mirrors `OverlayView` in main/overlay.ts (plus the corner). */
interface View {
  visible: boolean;
  tone: 'live' | 'warning' | 'danger';
  icon: 'lamp' | 'pause' | 'cross';
  parts: string[];
  sticky: boolean;
  flash: boolean;
  corner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
}

const FADE_AFTER_MS = 1500;
const FLASH_MS = 300;

const ICONS: Record<View['icon'], string> = {
  lamp: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="0.5" fill="currentColor"/></svg>',
  cross:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M4 4l4 4M8 4l-4 4" stroke="var(--overlay-chip-solid)" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`overlay.html has no #${id}`);
  return e;
}

const chip = el('chip');
const icon = el('icon');
const label = el('label');
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function render(v: View): void {
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
  if (!v.visible) {
    chip.hidden = true;
    return;
  }
  document.body.dataset['corner'] = v.corner;
  chip.dataset['tone'] = v.tone;
  icon.innerHTML = ICONS[v.icon];
  label.replaceChildren(
    ...v.parts.flatMap((p, i) => {
      const part = document.createElement('span');
      part.textContent = p;
      if (i === 0) return [part];
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      return [sep, part];
    }),
  );
  chip.hidden = false;
  chip.classList.remove('faded');
  if (v.flash) {
    chip.classList.add('flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => chip.classList.remove('flash'), FLASH_MS);
  }
  if (!v.sticky) fadeTimer = setTimeout(() => chip.classList.add('faded'), FADE_AFTER_MS);
}

window.jogstick.on('overlay:view', (data) => render(data as View));
