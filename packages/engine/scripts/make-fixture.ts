/** Writes test/fixtures/edit-session.frames.json from its generator. */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editSessionFixture } from '../test/generators/index';

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/edit-session.frames.json',
);
writeFileSync(out, `${JSON.stringify(editSessionFixture())}\n`);
console.log(`wrote ${out}`);
