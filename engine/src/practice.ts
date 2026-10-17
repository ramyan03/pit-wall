/**
 * Simulated Friday long runs: noisy lap times on each compound, generated from the race's
 * effective tyre model. The player sees only the lap times (and a regression on them), so this
 * is fair game in Hard mode: it's observed data, not the hidden truth.
 *
 * Uses its OWN Rng stream (seed mixed with PRACTICE_SALT), so generating practice never
 * changes the race's draws.
 */
import { availableCompounds, tyreLoss } from './race';
import { Rng } from './rng';
import type { Compound, CompoundModel, DriverCode, TrackData } from './types';

export const PRACTICE_SALT = 0x5eed_f9a1;
/** PLACEHOLDER: practice is noisier than the race (traffic, programme variation). */
const PRACTICE_NOISE_MULT = 1.4;
/** PLACEHOLDER: chance a lap is compromised by traffic, and the cost. */
const TRAFFIC_LAP_PROB = 0.08;
const TRAFFIC_LAP_COST: [number, number] = [0.8, 2.5];
/** Long runs start on roughly this many laps of fuel and burn it down. */
const RUN_FUEL_LAPS = 30;
/** Practice track temp offset vs race day (°C). Friday sessions run hotter or colder. */
const PRACTICE_TEMP_RANGE: [number, number] = [-4, 6];
/** Drivers doing long runs (each runs every compound). */
const RUNNERS = 3;

export interface PracticeRun {
  driver: DriverCode;
  compound: Compound;
  /** Lap times in order; index 0 = first flying lap on a new set. */
  laps: number[];
  /** Laps flagged as compromised by traffic (the player can choose to ignore them). */
  traffic: boolean[];
}

export interface PracticeSession {
  trackTempC: number;
  runs: PracticeRun[];
}

export function simulatePractice(track: TrackData, tyres: Record<Compound, CompoundModel>, seed: number): PracticeSession {
  const rng = new Rng((seed ^ PRACTICE_SALT) >>> 0);
  const tempDelta = rng.uniform(PRACTICE_TEMP_RANGE[0], PRACTICE_TEMP_RANGE[1]);
  const trackTempC = Math.round((track.conditions.trackTempC + tempDelta) * 10) / 10;
  const fpTrack: TrackData = { ...track, conditions: { ...track.conditions, trackTempC } };

  // Three front-half drivers each do a long run on every compound, so compounds can be
  // compared within a driver (that's how teams read Friday data).
  const pool = [...track.drivers].sort((a, b) => a.basePace - b.basePace).slice(0, 12);
  const picked: typeof pool = [];
  while (picked.length < RUNNERS) {
    const d = pool[rng.int(0, pool.length - 1)]!;
    if (!picked.includes(d)) picked.push(d);
  }
  const runs: PracticeRun[] = [];
  for (const compound of availableCompounds(track)) {
    const model = tyres[compound];
    for (const d of picked) {
      const length = rng.int(compound === 'S' ? 7 : 10, compound === 'S' ? 11 : 15);
      const laps: number[] = [];
      const traffic: boolean[] = [];
      for (let i = 0; i < length; i++) {
        const age = i + 1;
        let t =
          d.basePace +
          model.compoundOffset +
          tyreLoss(fpTrack, model, age, 'neutral') +
          track.fuel.fuelSecPerLap * (RUN_FUEL_LAPS - i) +
          rng.normal(0, track.noiseSigma * PRACTICE_NOISE_MULT);
        const hit = rng.chance(TRAFFIC_LAP_PROB);
        if (hit) t += rng.uniform(TRAFFIC_LAP_COST[0], TRAFFIC_LAP_COST[1]);
        laps.push(t);
        traffic.push(hit);
      }
      runs.push({ driver: d.code, compound, laps, traffic });
    }
  }
  return { trackTempC, runs };
}

export interface PracticeEstimate {
  /** Fuel-corrected deg, s/lap. */
  deg: number;
  /** ±1 standard error on deg. */
  degSe: number;
  /** Fresh-tyre pace vs `vs` (the Medium, or the Hard when no Medium ran), s, within each driver. */
  offset: number;
  vs: Compound;
  /** Clean laps used. */
  laps: number;
}

/**
 * What a strategist would do with the runs: fuel-correct, drop traffic laps, fit one slope per
 * compound with each run's level removed (driver pace), then compare fresh-tyre intercepts.
 */
export function analysePractice(session: PracticeSession, fuelSecPerLap: number): Record<Compound, PracticeEstimate | null> {
  const out = {} as Record<Compound, PracticeEstimate | null>;
  // Fresh-tyre (age 1) intercept per compound per driver.
  const fresh: Partial<Record<Compound, Map<string, number>>> = {};
  for (const c of ['S', 'M', 'H'] as Compound[]) {
    const runs = session.runs
      .filter((r) => r.compound === c)
      .map((run) => ({
        driver: run.driver,
        pts: run.laps
          .map((t, i) => ({ age: i + 1, t: t + fuelSecPerLap * i, traffic: run.traffic[i] }))
          .filter((p) => !p.traffic),
      }))
      .filter((r) => r.pts.length >= 3);
    const centred = runs.map(({ driver, pts }) => {
      const mt = pts.reduce((a, p) => a + p.t, 0) / pts.length;
      const ma = pts.reduce((a, p) => a + p.age, 0) / pts.length;
      return { driver, pts, mt, ma };
    });
    const xs = centred.flatMap((r) => r.pts.map((p) => p.age - r.ma));
    const ys = centred.flatMap((r) => r.pts.map((p) => p.t - r.mt));
    if (xs.length < 4) {
      out[c] = null;
      continue;
    }
    const sxx = xs.reduce((a, x) => a + x * x, 0);
    const slope = xs.reduce((a, x, i) => a + x * ys[i]!, 0) / sxx;
    const s2 = ys.reduce((a, y, i) => a + (y - slope * xs[i]!) ** 2, 0) / Math.max(1, xs.length - 1 - centred.length);
    out[c] = { deg: slope, degSe: Math.sqrt(s2 / sxx), offset: 0, vs: c, laps: xs.length };
    fresh[c] = new Map(centred.map((r) => [r.driver, r.mt - slope * (r.ma - 1)]));
  }
  const vs: Compound = fresh.M ? 'M' : 'H';
  for (const c of ['S', 'M', 'H'] as Compound[]) {
    const mine = fresh[c];
    const ref = fresh[vs];
    if (!out[c] || !mine || !ref) continue;
    out[c]!.vs = vs;
    const diffs = [...mine].filter(([d]) => ref.has(d)).map(([d, v]) => v - ref.get(d)!);
    if (diffs.length) out[c]!.offset = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }
  return out;
}
