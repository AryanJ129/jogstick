/**
 * pnpm engine:replay <fixture.frames.json> [--profile <profile.json>] [--mode edit|color]
 *
 * Replays recorded or synthetic pad frames through the engine (8 ms host ticks are
 * synthesized between frames) and prints the command log.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, formatCommand, framesToInputs, run } from '../src/index';
import type { PadFrame } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
// pnpm -F runs scripts from the package dir; resolve user paths from where they typed.
const base = process.env.INIT_CWD ?? process.cwd();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const fixturePath = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
if (!fixturePath) {
  console.error(
    'usage: pnpm engine:replay <fixture.frames.json> [--profile <profile.json>] [--mode <mode>]',
  );
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(resolve(base, fixturePath), 'utf8')) as {
  description?: string;
  mode?: string;
  frames: PadFrame[];
};
const profilePath = arg('--profile') ?? resolve(here, '../../profiles/resolve-default.json');
const profile: unknown = JSON.parse(readFileSync(resolve(base, profilePath), 'utf8'));
const mode = arg('--mode') ?? fixture.mode;

const { log } = run(createEngine(profile, mode), framesToInputs(fixture.frames));
const t0 = fixture.frames[0]?.t ?? 0;
console.log(
  `# ${fixture.description ?? fixturePath} — ${fixture.frames.length} frames, ${log.length} commands`,
);
for (const { now, command } of log)
  console.log(`${String(Math.round(now - t0)).padStart(6)} ms  ${formatCommand(command)}`);
