/// <reference lib="webworker" />
// Strategy search (Monte Carlo), off the UI thread.
//
// 'hint': from the current RaceState, try one more stop at each (lap × compound).
// 'recommend': from the grid, try start compound × 1-stop / 2-stop plans.
// Sample i uses the same race key for every candidate (common random numbers), so candidates
// are compared on the same futures: same incidents, same noise.
import { runToFinish, type Compound, type PlannedStop, type RaceState, type TrackData } from '@pit-wall/engine';

export interface WorkerRequest {
  kind: 'hint' | 'recommend';
  id: number;
  track: TrackData;
  state: RaceState;
  samples: number;
}

export interface Plan {
  start: Compound | null;
  stops: PlannedStop[];
  meanPos: number;
  /** Share of samples finishing ahead of the player's grid slot. */
  gainShare: number;
}

export interface HintResponse {
  id: number;
  kind: 'hint' | 'recommend';
  /** Best plans, best first. */
  plans: Plan[];
  /** 'hint' only: best pit window per compound. */
  windows: { compound: Compound; from: number; to: number; meanPos: number }[];
  ms: number;
}

const COMPOUNDS: Compound[] = ['S', 'M', 'H'];
const WINDOW_TOLERANCE = 0.35;
const HORIZON = 30;

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  postMessage(data.kind === 'hint' ? hint(data) : recommend(data));
});

function evaluator(track: TrackData, state: RaceState, samples: number) {
  const keys = Array.from({ length: samples }, (_, i) => mix(state.rngState, i));
  const me0 = state.cars.find((c) => c.isPlayer)!;
  return (start: Compound | null, stops: PlannedStop[]): Plan => {
    let total = 0;
    let gains = 0;
    for (const key of keys) {
      const cars = state.cars.map((c) => {
        if (!c.isPlayer) return c;
        const compound = start ?? c.compound;
        return {
          ...c,
          compound,
          stints: start ? [{ compound, startLap: 1, endLap: null }] : c.stints,
          compoundsUsed: start ? [compound] : c.compoundsUsed,
          pendingBox: null,
          strategy: { ...c.strategy, startCompound: compound, stops },
        };
      });
      const end = runToFinish(track, { ...state, cars, rngState: key });
      const pos = end.cars.find((c) => c.isPlayer)!.position;
      total += pos;
      if (pos < me0.position) gains++;
    }
    return { start, stops, meanPos: total / samples, gainShare: gains / samples };
  };
}

function hint({ id, track, state, samples }: WorkerRequest): HintResponse {
  const t0 = performance.now();
  const evaluate = evaluator(track, state, samples);
  const me = state.cars.find((c) => c.isPlayer)!;
  const lastLap = Math.min(state.totalLaps - 2, state.lap + HORIZON);
  const plans: Plan[] = [];
  if (me.compoundsUsed.length >= 2) plans.push(evaluate(null, []));
  for (const compound of COMPOUNDS) {
    for (let lap = state.lap + 1; lap <= lastLap; lap++) plans.push(evaluate(null, [{ lap, compound }]));
  }
  plans.sort((a, b) => a.meanPos - b.meanPos);

  const windows = COMPOUNDS.flatMap((compound) => {
    const mine = plans.filter((p) => p.stops[0]?.compound === compound);
    if (!mine.length) return [];
    const top = mine[0]!;
    const good = new Set(mine.filter((p) => p.meanPos <= top.meanPos + WINDOW_TOLERANCE).map((p) => p.stops[0]!.lap));
    let from = top.stops[0]!.lap;
    let to = from;
    while (good.has(from - 1)) from--;
    while (good.has(to + 1)) to++;
    return [{ compound, from, to, meanPos: top.meanPos }];
  });
  windows.sort((a, b) => a.meanPos - b.meanPos);
  return { id, kind: 'hint', plans: plans.slice(0, 5), windows, ms: performance.now() - t0 };
}

function recommend({ id, track, state, samples }: WorkerRequest): HintResponse {
  const t0 = performance.now();
  const evaluate = evaluator(track, state, samples);
  const N = state.totalLaps;
  const plans: Plan[] = [];
  const step = Math.max(2, Math.round(N / 20));
  for (const a of COMPOUNDS) {
    for (const b of COMPOUNDS) {
      if (a === b) continue;
      for (let lap = Math.round(N * 0.2); lap <= Math.round(N * 0.75); lap += step) {
        plans.push(evaluate(a, [{ lap, compound: b }]));
      }
    }
  }
  const twoStops: [Compound, Compound, Compound][] = [
    ['S', 'M', 'H'],
    ['M', 'H', 'M'],
    ['S', 'H', 'M'],
    ['M', 'H', 'S'],
    ['S', 'M', 'S'],
    ['H', 'M', 'S'],
  ];
  for (const [a, b, c] of twoStops) {
    for (const f1 of [0.25, 0.32, 0.4]) {
      for (const f2 of [0.6, 0.68, 0.76]) {
        plans.push(
          evaluate(a, [
            { lap: Math.round(N * f1), compound: b },
            { lap: Math.round(N * f2), compound: c },
          ]),
        );
      }
    }
  }
  plans.sort((x, y) => x.meanPos - y.meanPos);
  // Keep the best plan per (start + compound sequence) so the list shows real alternatives.
  const seen = new Set<string>();
  const distinct = plans.filter((p) => {
    const k = (p.start ?? '') + p.stops.map((s) => s.compound).join('');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { id, kind: 'recommend', plans: distinct.slice(0, 4), windows: [], ms: performance.now() - t0 };
}

/** Deterministic 32-bit mix of the race key and a sample index. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
