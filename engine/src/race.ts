/**
 * Race loop, rough v1: lap loop + traffic (M1), tyre wear + pace modes (M2),
 * pit stops + player commands (M3), SC/VSC/red (M4), AI strategies (M5).
 *
 * Contract: functions are pure. They take state, return new state, and get all
 * randomness from the Rng restored from `state.rngState`.
 *
 * RNG (part of determinism; change it on purpose only):
 *   createRace draws from Rng(seed), in order: (1) Hard-mode wear factor for S, M, H,
 *     (2) per car in grid order: AI strategy pick + pit-lap jitter, (3) per car in grid order:
 *     launch offset. Its final state becomes RaceState.rngState, the race KEY.
 *   stepLap never chains state. Every lap uses independent streams hashed from
 *     (key, lap, car, purpose), so a decision on lap N changes nothing else that lap draws
 *     and nothing on later laps except through the race itself (common random numbers):
 *     - incident stream (key, lap): one incident draw if eligible, + duration on SC/VSC
 *     - per-car lap stream (key, lap, driver): lap noise, S1 jitter, S2 jitter, overtake chance,
 *       then the held-up gap if the pass fails
 *     - per-car pit stream (key, lap, driver): stationary noise, slow-stop chance, slow extra
 *   'driver' is the driver's index in track.drivers, so running order doesn't matter.
 */
import { Rng } from './rng';
import type {
  CarState,
  Compound,
  CompoundModel,
  PaceMode,
  PlannedStop,
  PlayerCommand,
  RaceConfig,
  RaceEvent,
  RaceState,
  Strategy,
  TrackData,
} from './types';

// ---------------------------------------------------------------------------
// Tunables not (yet) in the schema. PLACEHOLDERS: revisit in M5 balance / D1–D2.
// ---------------------------------------------------------------------------

/** PLAN.md open question #3 proposal. */
export const PACE_MODES: Record<PaceMode, { lapDelta: number; wearMult: number }> = {
  push: { lapDelta: -0.25, wearMult: 1.35 },
  neutral: { lapDelta: 0, wearMult: 1 },
  conserve: { lapDelta: 0.3, wearMult: 0.75 },
};

/** PLACEHOLDER (open question #6): seconds between grid slots at the start line. */
export const GRID_SLOT_GAP = 0.25;
/** PLACEHOLDER (open question #6): σ of each car's launch, in seconds. */
export const LAUNCH_SIGMA = 0.15;
/** PLACEHOLDER: closest a held-up car gets to the car ahead at the line. */
export const MIN_FOLLOW_GAP = 0.3;
/** PLACEHOLDER: a held-up car sits 0–this much further back than MIN_FOLLOW_GAP (per-car stream). */
export const HELD_GAP_SPREAD = 0.5;
/** PLACEHOLDER: fraction of each gap kept per SC lap (until scCompressedGap). */
export const SC_GAP_KEEP = 0.35;
/** PLACEHOLDER: σ of stationary time around pit.stationaryMean. */
export const STATIONARY_SIGMA = 0.2;
/** PLACEHOLDER: σ of the S1/S2 split jitter (s). The lap total is unaffected. */
export const SECTOR_SIGMA = 0.08;
/** Hard mode: trueDeg = deg × lognormal(0, σ). */
export const HARD_DEG_SIGMA = 0.15;
/** AI never makes a planned stop this close to the flag. */
const NO_STOP_FINAL_LAPS = 1;

const COMPOUNDS: readonly Compound[] = ['S', 'M', 'H'];

// ---------------------------------------------------------------------------
// Lap-time model (exported for tests and Easy/Normal UI readouts)
// ---------------------------------------------------------------------------

export function tempMult(track: TrackData, model: CompoundModel): number {
  return 1 + model.tempSens * (track.conditions.trackTempC - track.conditions.refTempC);
}

/** Seconds the tyre has lost versus a new set: linear deg + quadratic cliff. */
export function tyreLoss(track: TrackData, model: CompoundModel, age: number, pace: PaceMode): number {
  const cliff = Math.max(0, age - model.cliffLap);
  return model.degRate * tempMult(track, model) * PACE_MODES[pace].wearMult * age + model.cliffK * cliff * cliff;
}

/** Noise-free green-flag lap time for `car` on lap `lap` (1-based). */
export function naturalLapTime(
  track: TrackData,
  tyres: Record<Compound, CompoundModel>,
  car: Pick<CarState, 'driver' | 'compound' | 'tyreAge' | 'paceMode'>,
  lap: number,
  totalLaps: number,
  basePace = driverPace(track, car.driver),
): number {
  const model = tyres[car.compound];
  const lapsRemaining = totalLaps - lap + 1; // fuel on board at the start of this lap
  return (
    basePace +
    model.compoundOffset +
    tyreLoss(track, model, car.tyreAge, car.paceMode) +
    track.fuel.fuelSecPerLap * lapsRemaining -
    track.trackEvo * lap +
    PACE_MODES[car.paceMode].lapDelta
  );
}

function driverPace(track: TrackData, code: string): number {
  const d = track.drivers.find((x) => x.code === code);
  if (!d) throw new Error(`unknown driver ${code}`);
  return d.basePace;
}

// ---------------------------------------------------------------------------
// createRace
// ---------------------------------------------------------------------------

export function createRace(track: TrackData, config: RaceConfig): RaceState {
  if (!track.drivers.some((d) => d.code === config.playerDriver)) {
    throw new Error(`playerDriver ${config.playerDriver} is not on the grid`);
  }
  const rng = new Rng(config.seed);

  // (1) Hard mode hides the real deg behind a lognormal draw.
  const effectiveTyres = {} as Record<Compound, CompoundModel>;
  for (const c of COMPOUNDS) {
    const m = track.tyres[c];
    const factor = config.difficulty === 'hard' ? rng.lognormal(0, HARD_DEG_SIGMA) : 1;
    effectiveTyres[c] = { ...m, degRate: m.degRate * factor };
  }

  const grid = [...track.drivers].sort((a, b) => a.gridPosition - b.gridPosition);

  // (2) Strategies.
  const strategies = grid.map((d) =>
    d.code === config.playerDriver ? config.playerStrategy : pickAiStrategy(rng, track),
  );

  // (3) Launch: grid stagger plus a small seeded getaway, so lap 1 can shuffle.
  const cars: CarState[] = grid.map((d, i) => {
    const strategy = strategies[i]!;
    const offset = i * GRID_SLOT_GAP + rng.normal(0, LAUNCH_SIGMA);
    return {
      driver: d.code,
      teamId: d.teamId,
      isPlayer: d.code === config.playerDriver,
      status: 'running',
      position: i + 1,
      totalTime: offset,
      lastLapTime: null,
      bestLapTime: null,
      lastSectors: null,
      bestSectors: [null, null, null],
      gapToLeader: 0,
      interval: 0,
      compound: strategy.startCompound,
      tyreAge: 0,
      stints: [{ compound: strategy.startCompound, startLap: 1, endLap: null }],
      compoundsUsed: [strategy.startCompound],
      paceMode: 'neutral',
      strategy,
      pitStops: 0,
      pendingBox: null,
    };
  });

  return {
    config,
    trackId: track.meta.trackId,
    lap: 0,
    totalLaps: track.meta.laps,
    neutralisation: { status: 'green', lapsRemaining: 0 },
    effectiveTyres,
    cars,
    events: [{ type: 'race_start', lap: 0 }],
    rngState: rng.state,
    finished: false,
  };
}

function pickAiStrategy(rng: Rng, track: TrackData): Strategy {
  const t = track.strategies[rng.weightedIndex(track.strategies.map((s) => s.weight))]!;
  const stops: PlannedStop[] = [];
  let prev = 0;
  t.pitLaps.forEach((lap, i) => {
    const jittered = lap + rng.int(-t.pitLapJitter, t.pitLapJitter);
    const clamped = Math.min(track.meta.laps - 2, Math.max(prev + 3, jittered));
    stops.push({ lap: clamped, compound: t.stints[i + 1]! });
    prev = clamped;
  });
  return { startCompound: t.stints[0]!, stops, neutralisedPitWindow: 3 };
}

// ---------------------------------------------------------------------------
// stepLap
// ---------------------------------------------------------------------------

/** Advance the race by one leader lap. */
export function stepLap(track: TrackData, state: RaceState): RaceState {
  if (state.finished) return state;
  const lap = state.lap + 1;
  const key = state.rngState;
  const driverIdx = new Map(track.drivers.map((d, i) => [d.code, i + 1]));
  const rng = new Rng(streamSeed(key, lap, 0, SALT_INCIDENT));
  const total = state.totalLaps;
  const events: RaceEvent[] = [];
  const inc = track.incidents;

  // (1) Incidents. Not on lap 1 or the final lap, never in Easy.
  let neut = { ...state.neutralisation };
  if (neut.status === 'green' && state.config.difficulty !== 'easy' && lap > 1 && lap < total) {
    const u = rng.next();
    if (u < inc.redHazardPerLap) {
      neut = { status: 'red', lapsRemaining: 1 };
      events.push({ type: 'red_flag', lap });
    } else if (u < inc.redHazardPerLap + inc.scHazardPerLap) {
      const laps = rng.int(inc.scDurationLaps[0], inc.scDurationLaps[1]);
      neut = { status: 'sc', lapsRemaining: laps };
      events.push({ type: 'sc_deployed', lap, laps });
    } else if (u < inc.redHazardPerLap + inc.scHazardPerLap + inc.vscHazardPerLap) {
      const laps = rng.int(inc.vscDurationLaps[0], inc.vscDurationLaps[1]);
      neut = { status: 'vsc', lapsRemaining: laps };
      events.push({ type: 'vsc_deployed', lap, laps });
    }
  }
  const status = neut.status;

  // Running order at the start of the lap.
  const order = state.cars
    .map((c) => ({ ...c }))
    .sort((a, b) => a.totalTime - b.totalTime || a.position - b.position);

  // Who boxes at the end of this lap (no RNG).
  const boxTo = order.map((c) => pitDecision(c, lap, total, status));

  // (2) Natural lap times + noise, and the natural S1/S2 split.
  const [f1, f2] = track.sectorFractions;
  const split: [number, number][] = [];
  const carRngs = order.map((c) => new Rng(streamSeed(key, lap, driverIdx.get(c.driver)!, SALT_LAP)));
  const lapTimes = order.map((c, i) => {
    const rng = carRngs[i]!;
    const noise = rng.normal(0, track.noiseSigma);
    const lt = naturalLapTime(track, state.effectiveTyres, c, lap, total) + noise;
    split.push([f1 * lt + rng.normal(0, SECTOR_SIGMA), f2 * lt + rng.normal(0, SECTOR_SIGMA)]);
    return lt;
  });
  const pitAdded = order.map(() => 0);

  const startTimes = order.map((c) => c.totalTime);
  const newTimes = order.map(() => 0);
  const passes: { driver: string; passed: string }[] = [];

  if (status === 'green') {
    // (3) Traffic. The car directly ahead on track is the on-track car (already processed)
    // that crosses the line LATEST; `next` is the one in front of that. A car may pass at
    // most one car per lap: it can't finish ahead of `next` unless it passes it next lap.
    let ahead = -1;
    let next = -1;
    for (let i = 0; i < order.length; i++) {
      let t = startTimes[i]! + lapTimes[i]!;
      if (boxTo[i] === null && ahead >= 0) {
        const aheadT = newTimes[ahead]!;
        if (t < aheadT + MIN_FOLLOW_GAP) {
          const advantage = lapTimes[ahead]! - lapTimes[i]!;
          const gotBy = advantage > track.traffic.overtakeDelta || carRngs[i]!.chance(track.traffic.overtakeProb);
          const passT = Math.max(Math.min(t, aheadT - MIN_FOLLOW_GAP), next >= 0 ? newTimes[next]! + MIN_FOLLOW_GAP : -Infinity);
          if (gotBy && passT < aheadT) {
            t = passT;
            passes.push({ driver: order[i]!.driver, passed: order[ahead]!.driver });
          } else {
            t = aheadT + MIN_FOLLOW_GAP + HELD_GAP_SPREAD * carRngs[i]!.next();
          }
        }
      }
      newTimes[i] = t;
      if (boxTo[i] === null) {
        if (ahead < 0 || t > newTimes[ahead]!) {
          next = ahead;
          ahead = i;
        } else if (next < 0 || t > newTimes[next]!) {
          next = i;
        }
      }
    }
  } else if (status === 'vsc') {
    // Everyone runs the same delta lap, so gaps are preserved.
    const vscLap = lapTimes[0]! * inc.lapTimeMult.vsc;
    for (let i = 0; i < order.length; i++) newTimes[i] = startTimes[i]! + vscLap;
  } else {
    // SC / red: queue up behind the leader, gaps shrink toward scCompressedGap.
    let prev = -1;
    for (let i = 0; i < order.length; i++) {
      const own = startTimes[i]! + lapTimes[i]! * inc.lapTimeMult.sc;
      if (prev < 0 || boxTo[i] !== null) {
        newTimes[i] = own;
      } else {
        const gap = startTimes[i]! - startTimes[prev]!;
        newTimes[i] = newTimes[prev]! + Math.max(inc.scCompressedGap, gap * SC_GAP_KEEP);
      }
      if (boxTo[i] === null) prev = i;
    }
  }

  // (4) Pit stops.
  const lossMult = status === 'sc' || status === 'red' ? inc.pitLossMult.sc : status === 'vsc' ? inc.pitLossMult.vsc : 1;
  for (let i = 0; i < order.length; i++) {
    const car = order[i]!;
    const to = boxTo[i];
    if (to === null || to === undefined) {
      car.tyreAge += 1;
      continue;
    }
    const rng = new Rng(streamSeed(key, lap, driverIdx.get(car.driver)!, SALT_PIT));
    const stationary = Math.max(1.6, track.pit.stationaryMean + rng.normal(0, STATIONARY_SIGMA));
    const slow = rng.chance(track.pit.slowStopProb);
    const extra = slow ? rng.uniform(track.pit.slowStopExtra[0], track.pit.slowStopExtra[1]) : 0;
    pitAdded[i] = track.pit.pitLoss * lossMult + stationary + extra;
    newTimes[i]! += pitAdded[i]!;
    events.push({ type: 'pit_stop', lap, driver: car.driver, from: car.compound, to, stationary: stationary + extra, slow });
    if (car.isPlayer) events.push({ type: 'radio', lap, driver: car.driver, message: slow ? 'Box, box. Slow stop, sorry.' : 'Box, box.' });
    fitTyres(car, to, lap);
    car.pitStops += 1;
    car.pendingBox = null;
    if (car.strategy.stops.length > 0 && car.strategy.stops[0]!.lap <= lap + car.strategy.neutralisedPitWindow) {
      car.strategy = { ...car.strategy, stops: car.strategy.stops.slice(1) };
    }
  }

  // Lap times as the timing screen sees them (incl. pit loss), then the red-flag reset.
  let fastest = bestOverall(state);
  for (let i = 0; i < order.length; i++) {
    const car = order[i]!;
    const lt = newTimes[i]! - startTimes[i]!;
    car.lastLapTime = lt;
    car.totalTime = newTimes[i]!;
    // Green: S1/S2 as driven, traffic + pit in S3. Neutralised: the split scaled to the slow lap.
    const driven = lt - pitAdded[i]!;
    const k = status === 'green' ? 1 : driven / lapTimes[i]!;
    const s1 = split[i]![0] * k;
    const s2 = split[i]![1] * k;
    car.lastSectors = [s1, s2, driven - s1 - s2 + pitAdded[i]!];
    if (status === 'green' && lap > 1) {
      car.bestSectors = car.bestSectors.map((b, j) => {
        const s = car.lastSectors![j]!;
        return j === 2 && boxTo[i] !== null ? b : b === null || s < b ? s : b;
      }) as CarState['bestSectors'];
    }
    if (lap > 1 && boxTo[i] === null && (car.bestLapTime === null || lt < car.bestLapTime)) {
      car.bestLapTime = lt;
      if (status === 'green' && (fastest === null || lt < fastest)) {
        fastest = lt;
        events.push({ type: 'fastest_lap', lap, driver: car.driver, time: lt });
      }
    }
  }

  if (status === 'red') {
    // Free tyre change for everyone, then restart in order at scCompressedGap.
    order.sort((a, b) => a.totalTime - b.totalTime);
    const lead = order[0]!.totalTime;
    order.forEach((car, i) => {
      fitTyres(car, redFlagCompound(car, total - lap), lap);
      car.pendingBox = null;
      car.totalTime = lead + i * inc.scCompressedGap;
    });
    neut = { status: 'green', lapsRemaining: 0 };
    events.push({ type: 'restart', lap });
  } else if (status === 'sc' || status === 'vsc') {
    neut.lapsRemaining -= 1;
    if (neut.lapsRemaining <= 0) {
      events.push({ type: status === 'sc' ? 'sc_ending' : 'vsc_ending', lap });
      neut = { status: 'green', lapsRemaining: 0 };
    }
  }

  for (const p of passes) events.push({ type: 'overtake', lap, ...p });

  // Radio: the player's tyres fall off the cliff.
  for (const car of order) {
    if (car.isPlayer && car.tyreAge === Math.ceil(state.effectiveTyres[car.compound].cliffLap) + 2) {
      events.push({ type: 'radio', lap, driver: car.driver, message: 'Tyres are gone, mate.' });
    }
  }

  const finished = lap >= total;
  if (finished) {
    for (const car of order) car.status = car.compoundsUsed.length >= 2 ? 'finished' : 'disqualified';
  }

  const cars = classify(order);
  if (finished) events.push({ type: 'race_finish', lap, winner: cars[0]!.driver });

  return {
    ...state,
    lap,
    neutralisation: neut,
    cars,
    events: events.length ? state.events.concat(events) : state.events,
    finished,
  };
}

const SALT_INCIDENT = 0x1c1d;
const SALT_LAP = 0x1a9e;
const SALT_PIT = 0x9175;

/** Seed for an independent stream: a 32-bit hash of (key, lap, car, purpose). */
export function streamSeed(key: number, lap: number, car: number, salt: number): number {
  let h = (key ^ Math.imul(lap + 1, 0x9e3779b9) ^ Math.imul(car + 1, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Compound to fit at the end of `lap`, or null to stay out. */
function pitDecision(car: CarState, lap: number, total: number, status: RaceState['neutralisation']['status']): Compound | null {
  if (car.status !== 'running' || status === 'red') return null; // red flag: free change instead
  if (car.pendingBox) return car.pendingBox;
  const next = car.strategy.stops[0];
  if (!next || lap > total - NO_STOP_FINAL_LAPS) return null;
  if (next.lap <= lap) return next.compound;
  const neutralised = status === 'sc' || status === 'vsc';
  if (neutralised && next.lap - lap <= car.strategy.neutralisedPitWindow) return next.compound;
  return null;
}

function fitTyres(car: CarState, to: Compound, lap: number): void {
  car.stints = car.stints.map((s, i, all) => (i === all.length - 1 ? { ...s, endLap: lap } : s));
  car.stints = [...car.stints, { compound: to, startLap: lap + 1, endLap: null }];
  car.compound = to;
  car.tyreAge = 0;
  if (!car.compoundsUsed.includes(to)) car.compoundsUsed = [...car.compoundsUsed, to];
}

function redFlagCompound(car: CarState, lapsLeft: number): Compound {
  if (car.pendingBox) return car.pendingBox;
  const next = car.strategy.stops[0];
  if (next) {
    car.strategy = { ...car.strategy, stops: car.strategy.stops.slice(1) };
    return next.compound;
  }
  if (car.compoundsUsed.length >= 2) return lapsLeft > 20 ? 'H' : lapsLeft > 10 ? 'M' : 'S';
  const pref: Compound[] = lapsLeft > 25 ? ['H', 'M', 'S'] : lapsLeft > 12 ? ['M', 'H', 'S'] : ['S', 'M', 'H'];
  return pref.find((c) => c !== car.compound)!;
}

function bestOverall(state: RaceState): number | null {
  let best: number | null = null;
  for (const c of state.cars) if (c.bestLapTime !== null && (best === null || c.bestLapTime < best)) best = c.bestLapTime;
  return best;
}

/** Sort by race time (DSQ cars last), then fill position, gap and interval. */
function classify(cars: CarState[]): CarState[] {
  const sorted = [...cars].sort(
    (a, b) => Number(a.status === 'disqualified') - Number(b.status === 'disqualified') || a.totalTime - b.totalTime,
  );
  const lead = sorted[0]!.totalTime;
  sorted.forEach((car, i) => {
    car.position = i + 1;
    car.gapToLeader = car.totalTime - lead;
    car.interval = i === 0 ? 0 : car.totalTime - sorted[i - 1]!.totalTime;
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Commands and whole-race helpers
// ---------------------------------------------------------------------------

export function applyCommand(state: RaceState, cmd: PlayerCommand): RaceState {
  if (state.finished) return state;
  const cars = state.cars.map((car) => {
    if (!car.isPlayer) return car;
    switch (cmd.type) {
      case 'box':
        return { ...car, pendingBox: cmd.compound };
      case 'cancel_box':
        return { ...car, pendingBox: null };
      case 'set_pace':
        return { ...car, paceMode: cmd.mode };
    }
  });
  return { ...state, cars };
}

/** Run a whole race to the finish (for tests, balance, Monte Carlo). */
export function simulateRace(track: TrackData, config: RaceConfig): RaceState {
  return runToFinish(track, createRace(track, config));
}

export function runToFinish(track: TrackData, state: RaceState): RaceState {
  let s = state;
  while (!s.finished) s = stepLap(track, s);
  return s;
}
