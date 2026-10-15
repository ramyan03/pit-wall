import { describe, expect, it } from 'vitest';
import { createRace } from '../src/race';
import { syntheticTrack } from './fixtures';

describe('race engine (stubs)', () => {
  it('createRace is a stub until M1', () => {
    expect(() =>
      createRace(syntheticTrack, {
        seed: 1,
        difficulty: 'normal',
        playerDriver: 'AAA',
        playerStrategy: { startCompound: 'M', stops: [{ lap: 22, compound: 'H' }], neutralisedPitWindow: 3 },
      }),
    ).toThrow(/not implemented/);
  });

  // Acceptance tests that later milestones must turn green (see PLAN.md).
  it.todo('M1 determinism: same seed and inputs give an identical RaceState, lap by lap');
  it.todo('M2 tyre wear: lap time rises with tyre age and steepens past cliffLap');
  it.todo('M3 two-compound rule: a car that finishes on one dry compound gets a penalty or DSQ');
  it.todo('M4 SC compresses gaps to ~scCompressedGap and halves pit loss');
  it.todo('M8 real-race replay: real top-5 strategies give finishing gaps within PLAN.md tolerances');
});
