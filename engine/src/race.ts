/**
 * Race loop: STUBS ONLY. Implemented across milestones M1–M5 in PLAN.md.
 *
 * Contract: functions are pure. They take state, return new state, and get all
 * randomness from the Rng restored from `state.rngState`.
 */
import type { PlayerCommand, RaceConfig, RaceState, TrackData } from './types';

export function createRace(_track: TrackData, _config: RaceConfig): RaceState {
  throw new Error('createRace: not implemented (PLAN.md M1)');
}

/** Advance the race by one leader lap. */
export function stepLap(_track: TrackData, _state: RaceState): RaceState {
  throw new Error('stepLap: not implemented (PLAN.md M1)');
}

export function applyCommand(_state: RaceState, _cmd: PlayerCommand): RaceState {
  throw new Error('applyCommand: not implemented (PLAN.md M3)');
}

/** Run a whole race to the finish (for tests, balance, Monte Carlo). */
export function simulateRace(track: TrackData, config: RaceConfig): RaceState {
  let state = createRace(track, config);
  while (!state.finished) state = stepLap(track, state);
  return state;
}
