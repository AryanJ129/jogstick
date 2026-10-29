import { step } from './engine';
import type { Command, EngineInput, EngineState, PadFrame } from './types';

export interface TimedInput {
  now: number;
  input: EngineInput;
}

export interface LogEntry {
  now: number;
  command: Command;
}

/** Interleave recorded frames with host-style ticks every `tickMs`, plus a tail so timers settle. */
export function framesToInputs(frames: PadFrame[], tickMs = 8, tailMs = 500): TimedInput[] {
  const out: TimedInput[] = [];
  if (frames.length === 0) return out;
  const start = (frames[0] as PadFrame).t;
  const end = (frames[frames.length - 1] as PadFrame).t + tailMs;
  let i = 0;
  for (let t = start; t <= end; t += tickMs) {
    while (i < frames.length && (frames[i] as PadFrame).t <= t) {
      const f = frames[i] as PadFrame;
      out.push({ now: f.t, input: { kind: 'frame', frame: f } });
      i++;
    }
    out.push({ now: t, input: { kind: 'tick' } });
  }
  return out;
}

/** Feed inputs through the engine and collect every command with its timestamp. */
export function run(
  initial: EngineState,
  inputs: TimedInput[],
): { state: EngineState; log: LogEntry[] } {
  let state = initial;
  const log: LogEntry[] = [];
  for (const { now, input } of inputs) {
    const r = step(state, input, now);
    state = r.state;
    for (const command of r.commands) log.push({ now, command });
  }
  return { state, log };
}

export function formatCommand(c: Command): string {
  switch (c.type) {
    case 'command':
      return `command ${c.phase} ${c.id}${c.mods.length ? ` +${c.mods.join('+')}` : ''}`;
    case 'keyDown':
      return `keyDown ${[...c.mods, c.code].join('+')} (${c.owner})`;
    case 'keyUp':
      return `keyUp ${c.code} (${c.owner})`;
    case 'modifierDown':
    case 'modifierUp':
      return `${c.type} ${c.mod}`;
    case 'mouseButton':
      return `mouseButton ${c.button} ${c.down ? 'down' : 'up'}`;
    case 'mouseMove':
    case 'driveDelta':
      return `${c.type} ${c.dx},${c.dy}`;
    case 'scroll':
      return `scroll ${c.dx},${c.dy} ${c.units}`;
    case 'driveStart':
      return `driveStart ${c.wheel} ${c.part} (${c.input})`;
    case 'driveEnd':
      return 'driveEnd';
    case 'modeChanged':
      return `modeChanged ${c.mode}`;
    case 'layerChanged':
      return `layerChanged [${c.layers.join(',')}]${c.fine ? ' fine' : ''}`;
    case 'haptic':
      return `haptic ${c.kind}`;
  }
}
