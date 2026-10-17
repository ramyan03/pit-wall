import { describe, expect, it } from 'vitest';
import { createRace, runToFinish, simulateRace, stepLap } from '../src/race';
import type { RaceConfig, RaceState, TrackData } from '../src/types';
import { synthetic22 } from './fixtures';

const config = (seed: number, over: Partial<RaceConfig> = {}): RaceConfig => ({
  seed,
  difficulty: 'normal',
  playerDriver: 'AAA',
  playerStrategy: { startCompound: 'M', stops: [{ lap: 25, compound: 'H' }], neutralisedPitWindow: 3 },
  ...over,
});

/** synthetic22 with a scripted race: lap-1 SC, VSC on lap 30, two retirements and one for the player. */
const scripted: TrackData = {
  ...synthetic22,
  realEvents: {
    incidents: [
      { lap: 1, type: 'sc', laps: 3 },
      { lap: 30, type: 'vsc', laps: 2 },
    ],
    retirements: [
      { driver: synthetic22.drivers[1]!.code, lap: 1 },
      { driver: synthetic22.drivers[5]!.code, lap: 40 },
      { driver: 'AAA', lap: 10 },
    ],
  },
};

const incidents = (s: RaceState) => s.events.filter((e) => /sc_|vsc_|red_flag|restart/.test(e.type));

describe('real-events replay', () => {
  it('follows the real neutralisations exactly, whatever the seed', () => {
    for (const seed of [1, 2, 3]) {
      const end = simulateRace(scripted, config(seed, { realEvents: true }));
      expect(incidents(end).map((e) => [e.type, e.lap])).toEqual([
        ['sc_deployed', 1],
        ['sc_ending', 3],
        ['vsc_deployed', 30],
        ['vsc_ending', 31],
      ]);
    }
  });

  it('retires AI cars at the start of their lap; never the player', () => {
    const early = synthetic22.drivers[1]!.code;
    const late = synthetic22.drivers[5]!.code;
    let s = createRace(scripted, config(4, { realEvents: true }));
    s = stepLap(scripted, s);
    const out = s.cars.find((c) => c.driver === early)!;
    expect(out.status).toBe('retired');
    expect(out.retiredLap).toBe(1);
    expect(out.position).toBe(22);
    const end = runToFinish(scripted, s);
    const lateCar = end.cars.find((c) => c.driver === late)!;
    expect(lateCar.status).toBe('retired');
    expect(lateCar.position).toBe(21); // retired later, so classified ahead of the lap-1 retirement
    expect(end.cars.find((c) => c.driver === early)!.position).toBe(22);
    expect(end.cars.find((c) => c.isPlayer)!.status).not.toBe('retired');
    expect(end.events.filter((e) => e.type === 'retirement').map((e) => e.driver)).toEqual([early, late]);
    // A retired car's time stops: it never completes another lap.
    expect(end.cars.find((c) => c.driver === early)!.totalTime).toBe(out.totalTime);
  });

  it('without realEvents the same track races with random incidents and no retirements', () => {
    const end = simulateRace(scripted, config(4));
    expect(end.cars.every((c) => c.status !== 'retired')).toBe(true);
  });
});

describe('nominated compounds', () => {
  const twoCompound: TrackData = {
    ...synthetic22,
    availableCompounds: ['S', 'H'],
    strategies: [{ id: 'SH', stints: ['S', 'H'], pitLaps: [20], pitLapJitter: 2, weight: 1 }],
  };

  it('rejects a start compound that was not nominated', () => {
    expect(() => createRace(twoCompound, config(1))).toThrow(/not available/);
  });

  it('red-flag tyre changes only fit nominated compounds', () => {
    const track: TrackData = { ...twoCompound, realEvents: { incidents: [{ lap: 12, type: 'red', laps: 1 }], retirements: [] } };
    const end = simulateRace(track, config(2, { realEvents: true, playerStrategy: { startCompound: 'S', stops: [], neutralisedPitWindow: 0 } }));
    for (const car of end.cars) for (const st of car.stints) expect(['S', 'H']).toContain(st.compound);
  });
});
