import {
  newOwner,
  pressAction,
  releaseAction,
  releaseOutputs,
  runRepeats,
  runSeqs,
} from './actions';
import { decideLock, processStick, processTrigger } from './axes';
import { driveEnd, driveUpdate, mouseStop, mouseUpdate } from './drive';
import type { DriveCandidate } from './drive';
import { gestureWake, pressResolved, releaseResolved, runGestureTimers } from './gestures';
import { clearLayers, lookupStick, lookupTrigger } from './layers';
import { compileProfile } from './profile';
import type { CompiledBinding, CompiledChord, CompiledProfile } from './profile';
import { BUTTON_INPUTS } from './schema';
import { jogStop, jogUpdate, shuttleUpdate } from './transport';
import type {
  ButtonInput,
  Ctx,
  EngineInput,
  EngineState,
  PadFrame,
  StepResult,
  StickId,
  StickState,
  TriggerId,
} from './types';

export const BUTTON_INDEX: Record<ButtonInput, number> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  l3: 10,
  r3: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  guide: 16,
};
const STICK_AXES: Record<StickId, [number, number]> = { lstick: [0, 1], rstick: [2, 3] };
const STICKS: StickId[] = ['lstick', 'rstick'];
const TRIGGERS: TriggerId[] = ['lt', 'rt'];

/** Buttons are pressed above 0.5. */
export const BUTTON_PRESS = 0.5;
/** Triggers bound digitally: press above 0.5, release below 0.4. */
export const TRIGGER_PRESS = 0.5;
export const TRIGGER_RELEASE = 0.4;
/** Stick axes bound digitally (with `dir`): press at 0.5 normalized deflection, release below 0.4. */
export const AXIS_PRESS = 0.5;
export const AXIS_RELEASE = 0.4;

function emptyStick(): StickState {
  return {
    engaged: false,
    engagedAt: 0,
    blocked: false,
    needsLock: false,
    lock: null,
    vec: null,
    x: [],
    y: [],
    axisPressed: {},
    mouse: { accX: 0, accY: 0, lastAt: null },
  };
}

function noButtons(): Record<ButtonInput, boolean> {
  return Object.fromEntries(BUTTON_INPUTS.map((b) => [b, false])) as Record<ButtonInput, boolean>;
}

export function createState(profile: CompiledProfile, mode?: string): EngineState {
  return {
    profile,
    mode: mode ?? (profile.modes[0] as string),
    connected: true,
    gateOpen: true,
    seq: 0,
    axes: [0, 0, 0, 0],
    triggerValues: { lt: 0, rt: 0 },
    pressed: noButtons(),
    held: {},
    layerStack: [],
    latched: [],
    fine: false,
    chord: { pending: null, active: null },
    pendingTaps: [],
    repeats: [],
    seqs: [],
    keys: [],
    cmdHolds: [],
    mouse: [],
    mods: [],
    sticks: { lstick: emptyStick(), rstick: emptyStick() },
    triggers: {
      lt: { engaged: false, engagedAt: 0, blocked: false, binding: null },
      rt: { engaged: false, engagedAt: 0, blocked: false, binding: null },
    },
    jog: { active: false, stick: null, acc: 0, lastAt: 0, suppressed: false },
    shuttle: {
      owner: null,
      binding: null,
      zone: 0,
      holds: [],
      candidate: { lt: null, rt: null },
      suppressed: { lt: false, rt: false },
    },
    drive: { active: null, cooldownUntil: 0, activeWheel: 'gain' },
  };
}

/** Compile a raw profile and return its initial state. */
export function createEngine(rawProfile: unknown, mode?: string): EngineState {
  return createState(compileProfile(rawProfile), mode);
}

// --- safety ------------------------------------------------------------------

function stickLive(state: EngineState, stick: StickId): boolean {
  const [ix, iy] = STICK_AXES[stick];
  return processStick(state.axes[ix] ?? 0, state.axes[iy] ?? 0, state.profile.settings).n > 0;
}

function triggerLive(state: EngineState, trig: TriggerId): boolean {
  return processTrigger(state.triggerValues[trig], state.profile.settings.triggerDeadzone) > 0;
}

/**
 * Release everything this engine holds: drive → mouse buttons → keys → modifiers,
 * then layers. Inputs still physically down are consumed (their release emits
 * nothing) and live sticks/triggers must return to the deadzone before acting again.
 */
export function releaseAll(ctx: Ctx): void {
  const s = ctx.state;
  s.chord = { pending: null, active: null };
  s.pendingTaps = [];
  s.repeats = [];
  s.seqs = [];
  driveEnd(ctx);
  jogStop(ctx);
  s.jog.suppressed = false;
  s.shuttle = {
    owner: null,
    binding: null,
    zone: 0,
    holds: [],
    candidate: { lt: null, rt: null },
    suppressed: { lt: false, rt: false },
  };
  releaseOutputs(ctx);
  clearLayers(ctx);
  for (const b of BUTTON_INPUTS) {
    if (s.pressed[b]) s.held[b] = { kind: 'consumed' };
    else s.held[b] = undefined;
  }
  for (const stick of STICKS) {
    s.sticks[stick] = { ...emptyStick(), blocked: stickLive(s, stick) };
  }
  for (const trig of TRIGGERS) {
    s.triggers[trig] = {
      engaged: false,
      engagedAt: 0,
      blocked: triggerLive(s, trig),
      binding: null,
    };
  }
}

function switchMode(ctx: Ctx, mode: string): void {
  const s = ctx.state;
  if (!ctx.profile.modes.includes(mode) || mode === s.mode) return;
  releaseAll(ctx);
  s.mode = mode;
  ctx.out.push({ type: 'modeChanged', mode });
  if ((ctx.profile.source.modeSwitch?.haptic ?? 'pulse') === 'pulse')
    ctx.out.push({ type: 'haptic', kind: 'pulse' });
}

// --- chords ------------------------------------------------------------------

function chordsFor(ctx: Ctx): CompiledChord[] {
  return ctx.profile.chords.filter((c) => c.mode === null || c.mode === ctx.state.mode);
}

function isParticipant(ctx: Ctx, input: ButtonInput): boolean {
  return chordsFor(ctx).some((c) => c.inputs.includes(input));
}

function releaseActiveChord(ctx: Ctx): void {
  const a = ctx.state.chord.active;
  if (!a) return;
  ctx.state.chord.active = null;
  const c = ctx.profile.chords[a.index];
  if (c?.binding) releaseAction(ctx, c.binding, a.owner);
}

function fireChord(ctx: Ctx, c: CompiledChord): void {
  if (c.binding === null) {
    const modes = ctx.profile.modes;
    const next = modes[(modes.indexOf(ctx.state.mode) + 1) % modes.length] as string;
    ctx.switchMode(next);
    return;
  }
  const owner = newOwner(ctx.state, 'chord');
  ctx.state.chord.active = { index: c.index, owner, members: [...c.inputs] };
  pressAction(ctx, c.binding, null, owner);
}

function matchChord(ctx: Ctx): void {
  const s = ctx.state;
  const p = s.chord.pending;
  if (!p) return;
  const chords = chordsFor(ctx);
  const participants = new Set(chords.flatMap((c) => c.inputs));
  const down = [...participants].filter((i) => s.pressed[i]);
  // Every member must have been pressed inside this window: a participant already
  // held (and dispatched) from before the window can't complete a chord.
  const inWindow = new Set(p.events.filter((e) => e.kind === 'press').map((e) => e.input));
  const match = chords.find(
    (c) =>
      c.inputs.length === down.length && c.inputs.every((i) => s.pressed[i] && inWindow.has(i)),
  );
  if (!match || match.index === p.fired) return;
  // A larger chord replaces (and releases) a smaller one fired earlier in the window.
  if (p.fired !== null) releaseActiveChord(ctx);
  fireChord(ctx, match);
  if (s.chord.pending === p) p.fired = match.index;
}

function chordPress(ctx: Ctx, input: ButtonInput): void {
  const s = ctx.state;
  if (!s.chord.pending)
    s.chord.pending = {
      events: [],
      deadline: ctx.now + ctx.profile.settings.chordWindowMs,
      fired: null,
    };
  s.chord.pending.events.push({ kind: 'press', input });
  matchChord(ctx);
}

function chordRelease(ctx: Ctx, input: ButtonInput): void {
  const s = ctx.state;
  if (s.chord.pending) {
    // Parked: replayed after the press/chord dispatch at the end of the window.
    s.chord.pending.events.push({ kind: 'release', input });
    return;
  }
  const a = s.chord.active;
  if (a && a.members.includes(input)) {
    releaseActiveChord(ctx);
    for (const m of a.members) if (m !== input && s.pressed[m]) s.held[m] = { kind: 'consumed' };
    s.held[input] = undefined;
    return;
  }
  releaseResolved(ctx, input);
}

function flushChord(ctx: Ctx): void {
  const s = ctx.state;
  const p = s.chord.pending;
  if (!p) return;
  s.chord.pending = null;
  const members = s.chord.active?.members ?? [];
  for (const ev of p.events) {
    const inChord = p.fired !== null && members.includes(ev.input);
    if (ev.kind === 'press') {
      if (!inChord) pressResolved(ctx, ev.input);
    } else if (inChord) {
      chordRelease(ctx, ev.input);
    } else {
      releaseResolved(ctx, ev.input);
    }
  }
}

// --- digital path --------------------------------------------------------------

function onPress(ctx: Ctx, input: ButtonInput): void {
  if (isParticipant(ctx, input)) chordPress(ctx, input);
  else pressResolved(ctx, input);
}

function onRelease(ctx: Ctx, input: ButtonInput): void {
  if (isParticipant(ctx, input) || ctx.state.chord.active?.members.includes(input))
    chordRelease(ctx, input);
  else releaseResolved(ctx, input);
}

function handleFrame(ctx: Ctx, frame: PadFrame): void {
  const s = ctx.state;
  s.connected = true;
  s.axes = [0, 1, 2, 3].map((i) => frame.axes[i] ?? 0);
  s.triggerValues = {
    lt: frame.buttons[BUTTON_INDEX.lt] ?? 0,
    rt: frame.buttons[BUTTON_INDEX.rt] ?? 0,
  };
  const next = noButtons();
  for (const b of BUTTON_INPUTS) {
    const v = frame.buttons[BUTTON_INDEX[b]] ?? 0;
    next[b] =
      b === 'lt' || b === 'rt'
        ? s.pressed[b]
          ? v > TRIGGER_RELEASE
          : v > TRIGGER_PRESS
        : v > BUTTON_PRESS;
  }
  if (!s.gateOpen) {
    // Gated: frames are dropped; only track physical state.
    for (const b of BUTTON_INPUTS) {
      if (!next[b]) s.held[b] = undefined;
    }
    s.pressed = next;
    return;
  }
  for (const b of BUTTON_INPUTS) {
    if (s.pressed[b] && !next[b]) {
      s.pressed[b] = false;
      onRelease(ctx, b);
    }
  }
  for (const b of BUTTON_INPUTS) {
    if (!s.pressed[b] && next[b]) {
      s.pressed[b] = true;
      onPress(ctx, b);
    }
  }
}

// --- analog path (consumed on ticks) --------------------------------------------

function axisBinding(
  ctx: Ctx,
  stick: StickId,
  st: StickState,
  b: CompiledBinding,
  v: number,
): void {
  if (b.action.type === 'jog') {
    jogUpdate(ctx, stick, b, v);
    return;
  }
  const val = v * (b.dir ?? 1);
  const owner = st.axisPressed[b.index];
  if (owner === undefined && val >= AXIS_PRESS) {
    const o = newOwner(ctx.state, b.input);
    st.axisPressed[b.index] = o;
    pressAction(ctx, b, null, o);
  } else if (owner !== undefined && val < AXIS_RELEASE) {
    st.axisPressed[b.index] = undefined;
    releaseAction(ctx, b, owner);
  }
}

function disengageStick(ctx: Ctx, stick: StickId): void {
  const s = ctx.state;
  const st = s.sticks[stick];
  if (s.jog.stick === stick) jogStop(ctx);
  s.jog.suppressed = false;
  for (const b of [...st.x, ...st.y]) {
    const owner = st.axisPressed[b.index];
    if (owner !== undefined) releaseAction(ctx, b, owner);
  }
  s.sticks[stick] = emptyStick();
}

function handleTick(ctx: Ctx): void {
  const s = ctx.state;
  if (!s.gateOpen || !s.connected) return;
  const settings = ctx.profile.settings;
  const candidates: DriveCandidate[] = [];

  for (const stick of STICKS) {
    const st = s.sticks[stick];
    const [ix, iy] = STICK_AXES[stick];
    const x = s.axes[ix] ?? 0;
    const y = s.axes[iy] ?? 0;
    const lin = processStick(x, y, settings);
    if (st.blocked) {
      if (lin.n === 0) st.blocked = false;
      continue;
    }
    if (!st.engaged) {
      if (lin.n === 0) continue;
      const found = lookupStick(s, stick);
      Object.assign(st, {
        engaged: true,
        engagedAt: ctx.now,
        vec: found.vec,
        x: found.x,
        y: found.y,
        needsLock: found.x.length > 0 && found.y.length > 0,
        lock: null,
        axisPressed: {},
      });
      mouseStop(st);
    } else if (lin.n === 0) {
      disengageStick(ctx, stick);
      continue;
    }
    if (st.needsLock && st.lock === null)
      st.lock = decideLock(lin.x, lin.y, settings.axisLockRatio, ctx.now - st.engagedAt);
    const xv = st.needsLock ? (st.lock === 'x' ? lin.x : 0) : lin.x;
    const yv = st.needsLock ? (st.lock === 'y' ? lin.y : 0) : lin.y;
    if (!st.needsLock || st.lock !== null) {
      for (const b of st.x) axisBinding(ctx, stick, st, b, xv);
      for (const b of st.y) axisBinding(ctx, stick, st, b, yv);
    }
    const vec = st.vec;
    if (vec?.action.type === 'wheel')
      candidates.push({ input: stick, binding: vec, engagedAt: st.engagedAt, x, y });
    else if (vec?.action.type === 'mouseMove') mouseUpdate(ctx, st, vec, x, y);
  }

  for (const trig of TRIGGERS) {
    const ts = s.triggers[trig];
    const raw = s.triggerValues[trig];
    const p = processTrigger(raw, settings.triggerDeadzone);
    if (ts.blocked) {
      if (p === 0) ts.blocked = false;
      continue;
    }
    if (!ts.engaged && p > 0) {
      ts.engaged = true;
      ts.engagedAt = ctx.now;
      ts.binding = lookupTrigger(s, trig);
    } else if (ts.engaged && p === 0) {
      ts.engaged = false;
      ts.binding = null;
    }
    const b = ts.binding;
    shuttleUpdate(ctx, trig, b?.action.type === 'shuttle' ? b : null, raw);
    if (b?.action.type === 'wheel')
      candidates.push({ input: trig, binding: b, engagedAt: ts.engagedAt, x: raw, y: 0 });
  }

  driveUpdate(ctx, candidates);
}

// --- step ---------------------------------------------------------------------

function runTimers(ctx: Ctx): void {
  const s = ctx.state;
  if (s.chord.pending && s.chord.pending.deadline <= ctx.now) flushChord(ctx);
  runGestureTimers(ctx);
  runRepeats(ctx);
  runSeqs(ctx);
}

function wantsTick(s: EngineState): boolean {
  if (!s.connected || !s.gateOpen) return false;
  return (
    STICKS.some((k) => s.sticks[k].engaged || stickLive(s, k)) ||
    TRIGGERS.some((k) => s.triggers[k].engaged || triggerLive(s, k)) ||
    s.jog.active ||
    s.drive.active !== null ||
    s.shuttle.owner !== null
  );
}

function nextWake(ctx: Ctx): number | null {
  const s = ctx.state;
  const times: number[] = [];
  if (s.chord.pending) times.push(s.chord.pending.deadline);
  const g = gestureWake(ctx);
  if (g !== null) times.push(g);
  for (const r of s.repeats) times.push(r.nextAt);
  for (const q of s.seqs) times.push(q.nextAt);
  return times.length === 0 ? null : Math.min(...times);
}

/**
 * Advance the engine. Pure apart from consuming `state`: the returned state replaces it.
 * No timers, no I/O — all timing comes from `now`.
 */
export function step(state: EngineState, input: EngineInput, now: number): StepResult {
  const ctx: Ctx = {
    state,
    profile: state.profile,
    now,
    out: [],
    switchMode: (mode) => switchMode(ctx, mode),
  };
  runTimers(ctx);
  switch (input.kind) {
    case 'frame':
      handleFrame(ctx, input.frame);
      break;
    case 'tick':
      handleTick(ctx);
      break;
    case 'disconnect':
      releaseAll(ctx);
      state.pressed = noButtons();
      state.held = {};
      state.axes = [0, 0, 0, 0];
      state.triggerValues = { lt: 0, rt: 0 };
      for (const stick of STICKS) state.sticks[stick].blocked = false;
      for (const trig of TRIGGERS) state.triggers[trig].blocked = false;
      state.connected = false;
      break;
    case 'gate':
      if (!input.open && state.gateOpen) {
        releaseAll(ctx);
        state.gateOpen = false;
      } else if (input.open && !state.gateOpen) {
        state.gateOpen = true;
        for (const b of BUTTON_INPUTS) if (state.pressed[b]) state.held[b] = { kind: 'consumed' };
        for (const stick of STICKS)
          state.sticks[stick] = { ...emptyStick(), blocked: stickLive(state, stick) };
        for (const trig of TRIGGERS)
          state.triggers[trig] = {
            engaged: false,
            engagedAt: 0,
            blocked: triggerLive(state, trig),
            binding: null,
          };
      }
      break;
    case 'releaseAll':
      releaseAll(ctx);
      break;
    case 'setMode':
      switchMode(ctx, input.mode);
      break;
  }
  return { state, commands: ctx.out, tick: wantsTick(state), wakeAt: nextWake(ctx) };
}
