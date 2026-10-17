/// <reference lib="webworker" />
// Strategy search (Monte Carlo pit windows), off the UI thread. Rough v1 of PLAN.md M7.
//
// From the current RaceState, for each candidate (pit lap × compound) the player's plan
// is replaced with that single stop and the race is run to the flag N times. Sample i
// reseeds every candidate identically (common random numbers), so candidates are compared
// on the same futures.
import { runToFinish, type Compound, type RaceState, type TrackData } from '@pit-wall/engine';

export interface HintRequest {
  id: number;
  track: TrackData;
  state: RaceState;
  samples: number;
}

export interface HintCandidate {
  lap: number | null;
  compound: Compound | null;
  meanPos: number;
}

export interface HintResponse {
  id: number;
  best: HintCandidate;
  /** Best pit window per compound: laps whose mean position is within 0.35 of that compound's best. */
  windows: { compound: Compound; from: number; to: number; meanPos: number }[];
  ms: number;
}

const COMPOUNDS: Compound[] = ['S', 'M', 'H'];
const WINDOW_TOLERANCE = 0.35;
const HORIZON = 30;

addEventListener('message', ({ data }: MessageEvent<HintRequest>) => {
  postMessage(search(data));
});

function search({ id, track, state, samples }: HintRequest): HintResponse {
  const t0 = performance.now();
  const me = state.cars.find((c) => c.isPlayer)!;
  const lastLap = Math.min(state.totalLaps - 2, state.lap + HORIZON);
  const seeds = Array.from({ length: samples }, (_, i) => mix(state.rngState, i));

  const evaluate = (stop: { lap: number; compound: Compound } | null): number => {
    let total = 0;
    for (const seed of seeds) {
      const cars = state.cars.map((c) =>
        c.isPlayer ? { ...c, pendingBox: null, strategy: { ...c.strategy, stops: stop ? [stop] : [] } } : c,
      );
      const end = runToFinish(track, { ...state, cars, rngState: seed });
      total += end.cars.find((c) => c.isPlayer)!.position;
    }
    return total / samples;
  };

  const candidates: HintCandidate[] = [];
  if (me.compoundsUsed.length >= 2) candidates.push({ lap: null, compound: null, meanPos: evaluate(null) });
  for (const compound of COMPOUNDS) {
    for (let lap = state.lap + 1; lap <= lastLap; lap++) {
      candidates.push({ lap, compound, meanPos: evaluate({ lap, compound }) });
    }
  }

  const best = candidates.reduce((a, b) => (b.meanPos < a.meanPos ? b : a));
  const windows = COMPOUNDS.flatMap((compound) => {
    const mine = candidates.filter((c) => c.compound === compound);
    if (mine.length === 0) return [];
    const top = mine.reduce((a, b) => (b.meanPos < a.meanPos ? b : a));
    const good = mine.filter((c) => c.meanPos <= top.meanPos + WINDOW_TOLERANCE).map((c) => c.lap!);
    // Contiguous run around the best lap.
    let from = top.lap!;
    let to = top.lap!;
    while (good.includes(from - 1)) from--;
    while (good.includes(to + 1)) to++;
    return [{ compound, from, to, meanPos: top.meanPos }];
  });
  windows.sort((a, b) => a.meanPos - b.meanPos);

  return { id, best, windows, ms: performance.now() - t0 };
}

/** Deterministic 32-bit mix of the race RNG state and a sample index. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
