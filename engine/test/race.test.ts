import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createRace,
  naturalLapTime,
  PACE_MODES,
  runToFinish,
  simulateRace,
  stepLap,
  tyreLoss,
} from '../src/race';
import type { PaceMode, RaceConfig, RaceState, TrackData } from '../src/types';
import { synthetic22, syntheticTrack } from './fixtures';

const config = (seed: number, over: Partial<RaceConfig> = {}): RaceConfig => ({
  seed,
  difficulty: 'normal',
  playerDriver: 'AAA',
  playerStrategy: { startCompound: 'M', stops: [{ lap: 22, compound: 'H' }], neutralisedPitWindow: 3 },
  ...over,
});

/** Every lap's state, from the grid to the flag. */
function laps(track: TrackData, cfg: RaceConfig): RaceState[] {
  const out = [createRace(track, cfg)];
  while (!out.at(-1)!.finished) out.push(stepLap(track, out.at(-1)!));
  return out;
}

/** A calm copy of a track: no incidents, plus any overrides. */
function calm(track: TrackData, over: Partial<TrackData> = {}): TrackData {
  return {
    ...track,
    incidents: { ...track.incidents, scHazardPerLap: 0, vscHazardPerLap: 0, redHazardPerLap: 0 },
    ...over,
  };
}

const lateStop = { startCompound: 'M' as const, stops: [{ lap: 45, compound: 'H' as const }], neutralisedPitWindow: 3 };

describe('M1 lap loop', () => {
  it('determinism: same seed and inputs give an identical RaceState, lap by lap', () => {
    const a = laps(synthetic22, config(123));
    const b = laps(synthetic22, config(123));
    expect(a.length).toBe(63);
    a.forEach((s, i) => expect(s).toEqual(b[i]));
  });

  it('a different seed gives a different race', () => {
    const a = simulateRace(synthetic22, config(1));
    const b = simulateRace(synthetic22, config(2));
    expect(a.cars.map((c) => c.totalTime)).not.toEqual(b.cars.map((c) => c.totalTime));
  });

  it('resumes from a JSON snapshot mid-race and finishes identically', () => {
    const states = laps(synthetic22, config(77));
    const snapshot = JSON.parse(JSON.stringify(states[30])) as RaceState;
    expect(runToFinish(synthetic22, snapshot)).toEqual(states.at(-1));
  });

  it('commands are part of the input: same seed + same commands = same race', () => {
    const run = () => {
      let s = createRace(synthetic22, config(9));
      while (!s.finished) {
        if (s.lap === 10) s = applyCommand(s, { type: 'set_pace', mode: 'push' });
        if (s.lap === 18) s = applyCommand(s, { type: 'box', compound: 'H' });
        s = stepLap(synthetic22, s);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('race ends at meta.laps with ordered positions, gaps and intervals', () => {
    const s = simulateRace(synthetic22, config(5));
    expect(s.finished).toBe(true);
    expect(s.lap).toBe(synthetic22.meta.laps);
    expect(s.cars.map((c) => c.position)).toEqual(s.cars.map((_, i) => i + 1));
    expect(s.cars[0]!.gapToLeader).toBe(0);
    for (let i = 1; i < s.cars.length; i++) {
      const [ahead, car] = [s.cars[i - 1]!, s.cars[i]!];
      if (car.status === 'disqualified') continue;
      expect(car.interval).toBeGreaterThanOrEqual(0);
      expect(car.interval).toBeCloseTo(car.totalTime - ahead.totalTime, 9);
      expect(car.gapToLeader).toBeCloseTo(car.totalTime - s.cars[0]!.totalTime, 9);
    }
    expect(s.events.at(-1)).toEqual({ type: 'race_finish', lap: 62, winner: s.cars[0]!.driver });
  });

  it('grid-start offsets shuffle lap 1 a little, never a lot', () => {
    // Same tyres for everyone, so only the launch offsets can reorder the field.
    const track = calm(synthetic22, { strategies: [{ id: 'late', stints: ['M', 'H'], pitLaps: [40], pitLapJitter: 0, weight: 1 }] });
    const grid = Object.fromEntries(track.drivers.map((d) => [d.code, d.gridPosition]));
    let changed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const s = stepLap(track, createRace(track, config(seed)));
      for (const car of s.cars) {
        expect(Math.abs(car.position - grid[car.driver]!)).toBeLessThanOrEqual(3);
        if (car.position !== grid[car.driver]) changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('no green lap is faster than the model allows', () => {
    const track = calm(synthetic22);
    const fastestOffset = Math.min(...Object.values(track.tyres).map((t) => t.compoundOffset));
    const s = laps(track, config(3));
    for (let lap = 2; lap < s.length; lap++) {
      for (const car of s[lap]!.cars) {
        const d = track.drivers.find((x) => x.code === car.driver)!;
        const floor = d.basePace + fastestOffset + PACE_MODES.push.lapDelta - track.trackEvo * lap - 6 * track.noiseSigma;
        expect(car.lastLapTime!).toBeGreaterThan(floor);
      }
    }
  });

  it('a faster car stuck behind a slower one passes within the expected laps', () => {
    // 0.5 s/lap quicker (below overtakeDelta), so each lap stuck is a 15% coin flip.
    // Expected laps to pass ≈ 1/0.15 ≈ 6.7; P(still stuck after 30 laps) = 0.85^30 ≈ 0.8%.
    const track = calm(syntheticTrack, {
      noiseSigma: 0,
      drivers: [
        { code: 'SLO', number: 1, teamId: 'team-a', basePace: 90.5, gridPosition: 1 },
        { code: 'FST', number: 2, teamId: 'team-b', basePace: 90.0, gridPosition: 2 },
      ],
      strategies: [{ id: 'late', stints: ['M', 'H'], pitLaps: [45], pitLapJitter: 0, weight: 1 }],
    });
    const passLaps: number[] = [];
    for (let seed = 0; seed < 200; seed++) {
      const cfg = config(seed, { playerDriver: 'SLO', playerStrategy: lateStop });
      const start = createRace(track, cfg);
      if (start.cars[1]!.totalTime < start.cars[0]!.totalTime) continue; // FST won the launch: nothing to pass
      const end = runToFinish(track, start);
      const pass = end.events.find((e) => e.type === 'overtake' && e.driver === 'FST');
      passLaps.push(pass ? pass.lap : Infinity);
    }
    const passed = passLaps.filter(Number.isFinite);
    const mean = passed.reduce((a, b) => a + b, 0) / passed.length;
    expect(passLaps.length).toBeGreaterThan(150);
    expect(passLaps.filter((l) => l > 30).length).toBeLessThanOrEqual(5);
    expect(mean).toBeGreaterThan(3);
    expect(mean).toBeLessThan(12);
  });

  it('a much faster car (beyond overtakeDelta) passes on the first lap', () => {
    const track = calm(syntheticTrack, {
      noiseSigma: 0,
      drivers: [
        { code: 'SLO', number: 1, teamId: 'team-a', basePace: 91.5, gridPosition: 1 },
        { code: 'FST', number: 2, teamId: 'team-b', basePace: 90.0, gridPosition: 2 },
      ],
      strategies: [{ id: 'late', stints: ['M', 'H'], pitLaps: [45], pitLapJitter: 0, weight: 1 }],
    });
    const s = laps(track, config(1, { playerDriver: 'SLO' }));
    expect(s[1]!.cars[0]!.driver).toBe('FST');
  });

  it('runs 22 cars × 62 laps in < 5 ms', () => {
    for (let i = 0; i < 20; i++) simulateRace(synthetic22, config(i)); // warm up the JIT
    const n = 200;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) simulateRace(synthetic22, config(1000 + i));
    const ms = (performance.now() - t0) / n;
    console.log(`simulateRace 22×62: ${ms.toFixed(3)} ms/race (mean of ${n})`);
    expect(ms).toBeLessThan(5);
  });
});

describe('M2 tyre wear + pace modes', () => {
  const base: { driver: string; compound: 'M'; paceMode: PaceMode } = { driver: 'AAA', compound: 'M', paceMode: 'neutral' };
  const lt = (age: number, over: Partial<typeof base> = {}) =>
    naturalLapTime(synthetic22, synthetic22.tyres, { ...base, tyreAge: age, ...over }, 10, 62);

  it('lap time is non-decreasing in tyre age (σ = 0)', () => {
    for (let age = 1; age < 50; age++) expect(lt(age)).toBeGreaterThanOrEqual(lt(age - 1));
  });

  it('past cliffLap the extra loss grows quadratically', () => {
    const m = synthetic22.tyres.M;
    const linear = (age: number) => tyreLoss(synthetic22, { ...m, cliffK: 0 }, age, 'neutral');
    const cliffPart = (k: number) => tyreLoss(synthetic22, m, m.cliffLap + k, 'neutral') - linear(m.cliffLap + k);
    expect(cliffPart(0)).toBe(0);
    expect(cliffPart(4)).toBeCloseTo(m.cliffK * 16, 9);
    expect(cliffPart(8)).toBeCloseTo(m.cliffK * 64, 9);
  });

  it('push is faster on fresh tyres but wears faster than conserve', () => {
    expect(lt(0, { paceMode: 'push' })).toBeLessThan(lt(0, { paceMode: 'conserve' }));
    const m = synthetic22.tyres.M;
    expect(tyreLoss(synthetic22, m, 20, 'push')).toBeGreaterThan(tyreLoss(synthetic22, m, 20, 'conserve'));
  });
});

describe('M3 pit stops + commands', () => {
  const manual = { startCompound: 'M' as const, stops: [], neutralisedPitWindow: 3 };

  it('BOX pits at the end of the lap and fits the new compound', () => {
    const track = calm(synthetic22);
    let s = createRace(track, config(4, { playerStrategy: manual }));
    for (let i = 0; i < 15; i++) s = stepLap(track, s);
    s = applyCommand(s, { type: 'box', compound: 'H' });
    s = stepLap(track, s);
    const me = s.cars.find((c) => c.isPlayer)!;
    expect(me.compound).toBe('H');
    expect(me.tyreAge).toBe(0);
    expect(me.pitStops).toBe(1);
    expect(me.compoundsUsed).toEqual(['M', 'H']);
    expect(me.lastLapTime!).toBeGreaterThan(95 + track.pit.pitLoss);
    expect(s.events.some((e) => e.type === 'pit_stop' && e.driver === 'AAA' && e.lap === 16)).toBe(true);
  });

  it('a car that never changes compound is disqualified', () => {
    const s = simulateRace(calm(synthetic22), config(4, { playerStrategy: { ...manual, startCompound: 'H' } }));
    const me = s.cars.find((c) => c.isPlayer)!;
    expect(me.status).toBe('disqualified');
    expect(me.position).toBe(22);
  });

  it('slow stops happen at roughly slowStopProb', () => {
    let stops = 0;
    let slow = 0;
    for (let seed = 0; seed < 400; seed++) {
      for (const e of simulateRace(synthetic22, config(seed)).events) {
        if (e.type !== 'pit_stop') continue;
        stops++;
        if (e.slow) slow++;
      }
    }
    expect(stops).toBeGreaterThan(5000);
    expect(slow / stops).toBeGreaterThan(0.04);
    expect(slow / stops).toBeLessThan(0.06);
  });
});

describe('M4 SC / VSC / red flag', () => {
  it('SC frequency follows the hazard; Easy has no incidents', () => {
    const n = 2000;
    let sc = 0;
    for (let seed = 0; seed < n; seed++) {
      sc += simulateRace(synthetic22, config(seed)).events.filter((e) => e.type === 'sc_deployed').length;
    }
    for (let seed = 0; seed < 50; seed++) {
      const easy = simulateRace(synthetic22, config(seed, { difficulty: 'easy' }));
      expect(easy.events.some((e) => e.type === 'sc_deployed' || e.type === 'vsc_deployed' || e.type === 'red_flag')).toBe(false);
    }
    // 60 eligible laps, minus the ones already neutralised, so a bit under hazard × 60.
    const expected = synthetic22.incidents.scHazardPerLap * 60;
    expect(sc / n).toBeGreaterThan(expected * 0.75);
    expect(sc / n).toBeLessThan(expected * 1.1);
  });

  it('gaps compress toward scCompressedGap under the SC', () => {
    const track: TrackData = {
      ...synthetic22,
      incidents: { ...synthetic22.incidents, scHazardPerLap: 1, vscHazardPerLap: 0, redHazardPerLap: 0, scDurationLaps: [5, 5] },
    };
    let s = createRace(track, config(8, { difficulty: 'easy' }));
    for (let i = 0; i < 20; i++) s = stepLap(track, s);
    s = { ...s, config: { ...s.config, difficulty: 'normal' } };
    for (let i = 0; i < 4; i++) s = stepLap(track, s);
    expect(s.neutralisation.status).toBe('sc');
    for (const c of s.cars.slice(1)) expect(c.interval).toBeLessThan(3);
  });

  it('a red flag gives everyone a free tyre change', () => {
    const track: TrackData = {
      ...synthetic22,
      incidents: { ...synthetic22.incidents, redHazardPerLap: 1 },
    };
    let s = createRace(track, config(2, { playerStrategy: { startCompound: 'H', stops: [], neutralisedPitWindow: 3 } }));
    s = stepLap(track, s); // lap 1: no incidents
    s = stepLap(track, s); // lap 2: red
    expect(s.events.some((e) => e.type === 'red_flag')).toBe(true);
    const me = s.cars.find((c) => c.isPlayer)!;
    expect(me.compoundsUsed.length).toBe(2);
    expect(me.tyreAge).toBe(0);
  });
});
