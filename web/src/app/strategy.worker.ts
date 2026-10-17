/// <reference lib="webworker" />
// Strategy search (Monte Carlo), off the UI thread.
//
// 'hint': from the current RaceState, try one more stop at each (lap × compound).
// 'recommend': from the grid, try start compound × 1-stop / 2-stop plans.
// 'compare': score each answer to a radio decision (a list of player commands) by its best
//   continuation: no further stop if the two-compound rule allows it, else one more stop.
// Sample i uses the same race key for every candidate (common random numbers), so candidates
// are compared on the same futures: same incidents, same noise.
// Real-events replays are simulated with random incidents: the strategist can't see the future.
import {
  applyCommand,
  availableCompounds,
  runToFinish,
  type Compound,
  type PlannedStop,
  type PlayerCommand,
  type RaceState,
  type TrackData,
} from '@pit-wall/engine';

export interface WorkerRequest {
  kind: 'hint' | 'recommend' | 'compare';
  id: number;
  track: TrackData;
  state: RaceState;
  samples: number;
  /** 'compare' only: the commands behind each answer. */
  options?: PlayerCommand[][];
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
  kind: 'hint' | 'recommend' | 'compare';
  /** Best plans, best first. */
  plans: Plan[];
  /** 'hint' only: best pit window per compound. */
  windows: { compound: Compound; from: number; to: number; meanPos: number }[];
  /** 'compare' only: expected finishing position per option, in request order. */
  estimates?: number[];
  ms: number;
}

const WINDOW_TOLERANCE = 0.35;
const HORIZON = 30;

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  postMessage(data.kind === 'hint' ? hint(data) : data.kind === 'compare' ? compare(data) : recommend(data));
});

function evaluator(track: TrackData, state: RaceState, samples: number) {
  const keys = Array.from({ length: samples }, (_, i) => mix(state.rngState, i));
  const me0 = state.cars.find((c) => c.isPlayer)!;
  return (start: Compound | null, stops: PlannedStop[], commands: PlayerCommand[] = []): Plan => {
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
      const config = { ...state.config, realEvents: false };
      const s0 = commands.reduce(applyCommand, { ...state, cars, config, rngState: key });
      const end = runToFinish(track, s0);
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
  const compounds = availableCompounds(track);
  const me = state.cars.find((c) => c.isPlayer)!;
  const lastLap = Math.min(state.totalLaps - 2, state.lap + HORIZON);
  const plans: Plan[] = [];
  if (me.compoundsUsed.length >= 2) plans.push(evaluate(null, []));
  for (const compound of compounds) {
    for (let lap = state.lap + 1; lap <= lastLap; lap++) plans.push(evaluate(null, [{ lap, compound }]));
  }
  plans.sort((a, b) => a.meanPos - b.meanPos);

  const windows = compounds.flatMap((compound) => {
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

function compare({ id, track, state, samples, options = [] }: WorkerRequest): HintResponse {
  const t0 = performance.now();
  const evaluate = evaluator(track, state, samples);
  const compounds = availableCompounds(track);
  const lastLap = Math.min(state.totalLaps - 2, state.lap + HORIZON);
  const estimates = options.map((commands) => {
    const after = commands.reduce(applyCommand, state).cars.find((c) => c.isPlayer)!;
    const used = new Set([...after.compoundsUsed, ...(after.pendingBox ? [after.pendingBox] : [])]);
    const first = state.lap + (after.pendingBox ? 3 : 1);
    let best = used.size >= 2 ? evaluate(null, [], commands).meanPos : Infinity;
    for (const compound of compounds) {
      for (let lap = first; lap <= lastLap; lap += 3) best = Math.min(best, evaluate(null, [{ lap, compound }], commands).meanPos);
    }
    return best;
  });
  return { id, kind: 'compare', plans: [], windows: [], estimates, ms: performance.now() - t0 };
}

function recommend({ id, track, state, samples }: WorkerRequest): HintResponse {
  const t0 = performance.now();
  const evaluate = evaluator(track, state, samples);
  const compounds = availableCompounds(track);
  const N = state.totalLaps;
  const plans: Plan[] = [];
  const step = Math.max(2, Math.round(N / 20));
  for (const a of compounds) {
    for (const b of compounds) {
      if (a === b) continue;
      for (let lap = Math.round(N * 0.2); lap <= Math.round(N * 0.75); lap += step) {
        plans.push(evaluate(a, [{ lap, compound: b }]));
      }
    }
  }
  const twoStops = (
    [
      ['S', 'M', 'H'],
      ['M', 'H', 'M'],
      ['S', 'H', 'M'],
      ['M', 'H', 'S'],
      ['S', 'M', 'S'],
      ['H', 'M', 'S'],
      ['S', 'H', 'S'],
      ['S', 'S', 'H'],
      ['H', 'S', 'S'],
    ] as [Compound, Compound, Compound][]
  ).filter((seq) => seq.every((c) => compounds.includes(c)) && new Set(seq).size >= 2);
  // High-deg classics (2011–13) were won on 3 and 4 stops.
  if (compounds.length === 2) {
    const [soft, hard] = compounds as [Compound, Compound];
    for (const seq of [[soft, soft, soft, hard], [soft, soft, hard, soft], [soft, soft, soft, soft, hard]] as Compound[][]) {
      const n = seq.length;
      plans.push(evaluate(seq[0]!, seq.slice(1).map((compound, i) => ({ lap: Math.round((N * (i + 1)) / n), compound }))));
    }
  }
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
