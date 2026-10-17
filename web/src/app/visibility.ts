/**
 * The ONE place the UI may touch hidden tyre truth (CLAUDE.md convention #4).
 * In Hard mode these selectors never read `RaceState.effectiveTyres` or
 * `TrackData.tyres`: the player gets track temp, `priorTyres` and lap times only.
 */
import {
  analysePractice,
  simulatePractice,
  tyreLoss,
  type CarState,
  type Compound,
  type CompoundModel,
  type PracticeEstimate,
  type PracticeSession,
  type RaceState,
  type TrackData,
} from '@pit-wall/engine';

export interface WearReadout {
  /** Seconds per lap lost versus a new set of the same compound. */
  loss: number;
  /** Laps until the cliff starts (0 = already past it). */
  lapsToCliff: number;
}

/** Live wear for a car, or null when the difficulty hides it. */
export function wearReadout(track: TrackData, state: RaceState, car: CarState): WearReadout | null {
  if (state.config.difficulty === 'hard') return null;
  const model = state.effectiveTyres[car.compound];
  return {
    loss: tyreLoss(track, model, car.tyreAge, car.paceMode),
    lapsToCliff: Math.max(0, Math.ceil(model.cliffLap - car.tyreAge)),
  };
}

/** Pre-race tyre guide: the real fit in Easy/Normal, last year's fit (or nothing) in Hard. */
export function tyreGuide(
  track: TrackData,
  state: RaceState,
): { source: 'race' | 'prior' | 'none'; tyres: Record<Compound, CompoundModel> | null } {
  if (state.config.difficulty === 'hard') {
    return track.priorTyres ? { source: 'prior', tyres: track.priorTyres } : { source: 'none', tyres: null };
  }
  return { source: 'race', tyres: state.effectiveTyres };
}

/** Pit-window hints are Easy/Normal only. */
export function hintsAllowed(state: RaceState): boolean {
  return state.config.difficulty !== 'hard';
}

/**
 * Simulated Friday long runs. Generated from the race-day truth but it only exposes noisy lap
 * times (plus the strategist's regression on them), so it's allowed in every mode, and it is
 * Hard mode's main clue.
 */
export function practiceFor(track: TrackData, state: RaceState): { session: PracticeSession; estimate: Record<Compound, PracticeEstimate | null> } {
  const session = simulatePractice(track, state.effectiveTyres, state.config.seed);
  return { session, estimate: analysePractice(session, track.fuel.fuelSecPerLap) };
}
