import { describe, expect, it } from 'vitest';
import fixture from './fixtures/edit-session.frames.json';
import { editSessionFixture } from './generators';
import { framesToInputs, run } from '../src/replay';
import { ids, lines, resolveEngine } from './helpers';
import type { PadFrame } from '../src/types';

describe('replay fixtures', () => {
  it('the committed fixture is exactly its generator output', () => {
    expect(fixture).toEqual(editSessionFixture());
  });

  it('replaying it jogs, shuttles, undoes, ripple-deletes and leaves nothing held at rest', () => {
    const { log, state } = run(resolveEngine('edit'), framesToInputs(fixture.frames as PadFrame[]));
    const used = new Set(ids(log));
    for (const id of [
      'nav.stepFrameForward',
      'nav.stepFrameBackward',
      'transport.stop',
      'transport.playForward',
      'edit.undo',
      'edit.rippleDelete',
    ])
      expect(used).toContain(id);
    expect(lines(log)).toContain('command down transport.playForward');
    expect([state.keys, state.cmdHolds, state.mods, state.mouse]).toEqual([[], [], [], []]);
  });
});
