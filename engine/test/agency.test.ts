import { describe, expect, it } from 'vitest';
import { applyCommand, COVER_PROB, createRace, ERS, naturalLapTime, runToFinish, stepLap, WARMUP_PENALTY } from '../src/race';
import type { DriverEntry, RaceConfig, RaceState, Strategy, TrackData } from '../src/types';
import { syntheticTrack } from './fixtures';

const strat = (lap: number): Strategy => ({ startCompound: 'M', stops: [{ lap, compound: 'H' }], neutralisedPitWindow: 3 });
const manual: Strategy = { startCompound: 'M', stops: [], neutralisedPitWindow: 3 };

const config = (seed: number, playerDriver: string, playerStrategy: Strategy): RaceConfig => ({
  seed,
  difficulty: 'normal',
  playerDriver,
  playerStrategy,
});

/** Calm, noise-free copy of the synthetic track with the given grid and one AI strategy. */
function duel(drivers: Partial<DriverEntry>[], aiStopLap = 45): TrackData {
  return {
    ...syntheticTrack,
    noiseSigma: 0,
    incidents: { ...syntheticTrack.incidents, scHazardPerLap: 0, vscHazardPerLap: 0, redHazardPerLap: 0 },
    drivers: drivers.map((d, i) => ({ code: `D${i}`, number: i + 1, teamId: `team-${i}`, fullName: `D${i}`, basePace: 90, gridPosition: i + 1, ...d })),
    strategies: [{ id: 'one', stints: ['M', 'H'], pitLaps: [aiStopLap], pitLapJitter: 0, weight: 1 }],
  };
}

function stepTo(track: TrackData, s: RaceState, lap: number): RaceState {
  while (s.lap < lap && !s.finished) s = stepLap(track, s);
  return s;
}

const car = (s: RaceState, code: string) => s.cars.find((c) => c.driver === code)!;

describe('undercut / overcut', () => {
  it('the out-lap pays a compound warm-up penalty', () => {
    const track = duel([{ code: 'AAA' }]);
    let s = stepTo(track, createRace(track, config(1, 'AAA', manual)), 15);
    s = stepLap(track, applyCommand(s, { type: 'box', compound: 'H' }));
    const before = car(s, 'AAA');
    s = stepLap(track, s);
    const natural = naturalLapTime(track, s.effectiveTyres, { ...before, tyreAge: 0 }, 17, s.totalLaps);
    expect(car(s, 'AAA').lastLapTime!).toBeCloseTo(natural + WARMUP_PENALTY.H, 6);
  });

  it('pitting first gains time on the car ahead (undercut)', () => {
    // AAA (player) leads and stops on lap 30; the AI behind stops on lap 26 or 30.
    const gapAfter = (aiStop: number) => {
      const track = duel([{ code: 'AAA' }, { code: 'BBB' }], aiStop);
      const end = stepTo(track, createRace(track, config(3, 'AAA', strat(30))), 32);
      return car(end, 'BBB').totalTime - car(end, 'AAA').totalTime;
    };
    expect(gapAfter(26)).toBeLessThan(gapAfter(30) - 1);
  });

  it('an AI car ahead covers an undercut most of the time', () => {
    let eligible = 0;
    let covered = 0;
    for (let seed = 0; seed < 200; seed++) {
      // AI leads with a stop due on lap 25; the player behind boxes on lap 20.
      const track = duel([{ code: 'AI' }, { code: 'ME' }], 25);
      let s = stepTo(track, createRace(track, config(seed, 'ME', manual)), 19);
      if (s.cars[0]!.driver !== 'AI' || s.cars[1]!.interval > 3) continue;
      eligible++;
      s = stepLap(track, applyCommand(s, { type: 'box', compound: 'H' }));
      if (s.events.some((e) => e.type === 'cover' && e.driver === 'AI' && e.rival === 'ME')) {
        covered++;
        s = stepLap(track, s);
        expect(s.events.some((e) => e.type === 'pit_stop' && e.driver === 'AI' && e.lap === 21)).toBe(true);
      }
    }
    expect(eligible).toBeGreaterThan(150);
    expect(covered / eligible).toBeGreaterThan(COVER_PROB - 0.12);
    expect(covered / eligible).toBeLessThan(COVER_PROB + 0.12);
  });
});

describe('battery (Attack / Defend / Harvest)', () => {
  it('attack drains the battery, then drops to neutral with a radio event', () => {
    const track = duel([{ code: 'AAA' }]);
    let s = applyCommand(createRace(track, config(1, 'AAA', manual)), { type: 'set_ers', mode: 'attack' });
    const lapsOfCharge = Math.floor(1 / -ERS.attack.charge);
    s = stepTo(track, s, lapsOfCharge);
    expect(car(s, 'AAA').battery).toBeCloseTo(1 + lapsOfCharge * ERS.attack.charge, 9);
    expect(car(s, 'AAA').ersMode).toBe('attack');
    s = stepLap(track, s);
    expect(car(s, 'AAA').ersMode).toBe('neutral');
    expect(s.events.some((e) => e.type === 'battery_empty' && e.driver === 'AAA')).toBe(true);
  });

  it('harvest is slower but recharges, capped at full', () => {
    const track = duel([{ code: 'AAA' }]);
    let s = applyCommand(createRace(track, config(1, 'AAA', manual)), { type: 'set_ers', mode: 'attack' });
    s = stepTo(track, s, 3);
    const low = car(s, 'AAA').battery;
    const neutralLap = stepLap(track, applyCommand(s, { type: 'set_ers', mode: 'neutral' }));
    const harvestLap = stepLap(track, applyCommand(s, { type: 'set_ers', mode: 'harvest' }));
    expect(car(harvestLap, 'AAA').battery).toBeCloseTo(low + ERS.harvest.charge, 9);
    expect(car(harvestLap, 'AAA').lastLapTime! - car(neutralLap, 'AAA').lastLapTime!).toBeCloseTo(ERS.harvest.lapDelta, 6);
    const full = stepTo(track, harvestLap, 20);
    expect(car(full, 'AAA').battery).toBe(1);
  });

  it('attack gets the player past a slower car sooner; defend holds a faster car off longer', () => {
    // FST is 0.5 s/lap quicker than SLO (below overtakeDelta), so passes are coin flips.
    const passedWithin = (player: 'SLO' | 'FST', mode: 'attack' | 'defend' | 'neutral') => {
      let n = 0;
      for (let seed = 0; seed < 300; seed++) {
        const track = duel([
          { code: 'SLO', basePace: 90.5 },
          { code: 'FST', basePace: 90 },
        ]);
        const s0 = createRace(track, config(seed, player, strat(45)));
        if (car(s0, 'FST').totalTime < car(s0, 'SLO').totalTime) continue;
        const s = stepTo(track, applyCommand(s0, { type: 'set_ers', mode }), 4);
        if (s.events.some((e) => e.type === 'overtake' && e.driver === 'FST')) n++;
      }
      return n;
    };
    expect(passedWithin('FST', 'attack')).toBeGreaterThan(passedWithin('FST', 'neutral') + 30);
    expect(passedWithin('SLO', 'defend')).toBeLessThan(passedWithin('SLO', 'neutral') - 30);
  });
});

describe('push targets', () => {
  it('push for N laps, then back to neutral with a radio event', () => {
    const track = duel([{ code: 'AAA' }]);
    let s = stepTo(track, createRace(track, config(1, 'AAA', manual)), 10);
    s = applyCommand(s, { type: 'push_for', laps: 3 });
    s = stepTo(track, s, 12);
    expect(car(s, 'AAA').paceMode).toBe('push');
    s = stepLap(track, s);
    expect(car(s, 'AAA').paceMode).toBe('neutral');
    expect(car(s, 'AAA').pushUntil).toBeNull();
    expect(s.events.some((e) => e.type === 'push_done' && e.lap === 13)).toBe(true);
  });

  it('setting a pace mode clears the push target', () => {
    const track = duel([{ code: 'AAA' }]);
    let s = applyCommand(createRace(track, config(1, 'AAA', manual)), { type: 'push_for', laps: 5 });
    s = applyCommand(s, { type: 'set_pace', mode: 'conserve' });
    expect(car(s, 'AAA').pushUntil).toBeNull();
    s = stepTo(track, s, 8);
    expect(car(s, 'AAA').paceMode).toBe('conserve');
  });
});

describe('team orders', () => {
  it('let by: the teammate ahead yields on the next lap', () => {
    const track = duel([
      { code: 'MATE', teamId: 'team-x' },
      { code: 'ME', teamId: 'team-x' },
    ]);
    let checked = 0;
    for (let seed = 0; seed < 20; seed++) {
      let s = stepTo(track, createRace(track, config(seed, 'ME', strat(45))), 5);
      if (s.cars[0]!.driver !== 'MATE' || s.cars[1]!.interval > 0.9) continue;
      checked++;
      s = stepLap(track, applyCommand(s, { type: 'team_order', order: 'let_by' }));
      expect(s.cars[0]!.driver).toBe('ME');
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('hold up: a rival stuck behind the teammate passes less often, and the teammate pays for it', () => {
    const run = (order: 'none' | 'hold_up') => {
      let passes = 0;
      for (let seed = 0; seed < 200; seed++) {
        const track = duel([
          { code: 'ME', teamId: 'team-x', basePace: 89 },
          { code: 'MATE', teamId: 'team-x', basePace: 90.5 },
          { code: 'RIV', basePace: 90 },
        ]);
        const end = runToFinish(track, applyCommand(createRace(track, config(seed, 'ME', strat(45))), { type: 'team_order', order }));
        passes += end.events.filter((e) => e.type === 'overtake' && e.driver === 'RIV' && e.passed === 'MATE' && e.lap <= 10).length;
      }
      return passes;
    };
    expect(run('hold_up')).toBeLessThan(run('none') * 0.7);
  });
});
