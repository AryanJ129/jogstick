import { createEngine } from '../src/engine';
import { formatCommand, run } from '../src/replay';
import type { LogEntry } from '../src/replay';
import type { ProfileInput } from '../src/schema';
import type { Command, EngineState } from '../src/types';
import { Timeline } from './generators';
import resolveDefault from '../../profiles/resolve-default.json';

type BindingInput = ProfileInput['bindings'][number];

/** A small two-mode profile; tests add bindings and override settings. */
export function testProfile(
  bindings: BindingInput[],
  extra: Partial<ProfileInput> = {},
): ProfileInput {
  return {
    version: 1,
    id: 'test',
    name: 'Test',
    modes: ['edit', 'color'],
    modeSwitch: { chord: ['view', 'menu'] },
    layers: [],
    bindings,
    ...extra,
  };
}

/** Narrow away undefined/null, failing the test with a clear message instead of a `!` assertion. */
export function must<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`expected ${what} to exist`);
  return v;
}

export function engineFor(profile: unknown, mode?: string): EngineState {
  return createEngine(profile, mode);
}

export function resolveEngine(mode?: string): EngineState {
  return createEngine(resolveDefault, mode);
}

export function play(state: EngineState, tl: Timeline): { state: EngineState; log: LogEntry[] } {
  return run(state, tl.events);
}

export const cmds = (log: LogEntry[]): Command[] => log.map((l) => l.command);
export const lines = (log: LogEntry[]): string[] => log.map((l) => formatCommand(l.command));
export const linesAt = (log: LogEntry[]): string[] =>
  log.map((l) => `${l.now} ${formatCommand(l.command)}`);
export const ids = (log: LogEntry[], phase: 'tap' | 'down' | 'up' = 'tap'): string[] =>
  log.flatMap((l) =>
    l.command.type === 'command' && l.command.phase === phase ? [l.command.id] : [],
  );
export const count = (log: LogEntry[], pred: (c: Command) => boolean): number =>
  log.filter((l) => pred(l.command)).length;
export const ofType = <T extends Command['type']>(
  log: LogEntry[],
  type: T,
): Extract<Command, { type: T }>[] =>
  log.flatMap((l) => (l.command.type === type ? [l.command as Extract<Command, { type: T }>] : []));

export { Timeline };
