/**
 * `npm run balance`: sims N races per strategy for a mid-field player car (all
 * others AI) and prints mean/median finishing position and race time ± sd.
 * Rough v1: runs on the 22-car synthetic fixture until D1/D2 land real data.
 * Uses paired seeds (same seed for every strategy), so incidents line up.
 */
import { simulateRace } from '../src/race';
import type { Strategy } from '../src/types';
import { synthetic22 as track } from '../test/fixtures/index';

const N = Number(process.argv[2] ?? 1000);
const player = [...track.drivers].sort((a, b) => a.gridPosition - b.gridPosition)[10]!.code;

const strategies: Record<string, Strategy> = Object.fromEntries(
  track.strategies.map((t) => [
    t.id,
    {
      startCompound: t.stints[0]!,
      stops: t.pitLaps.map((lap, i) => ({ lap, compound: t.stints[i + 1]! })),
      neutralisedPitWindow: 3,
    },
  ]),
);

const results: Record<string, { pos: number[]; time: number[] }> = {};
for (const [id, playerStrategy] of Object.entries(strategies)) {
  results[id] = { pos: [], time: [] };
  for (let seed = 0; seed < N; seed++) {
    const end = simulateRace(track, { seed, difficulty: 'normal', playerDriver: player, playerStrategy });
    const me = end.cars.find((c) => c.isPlayer)!;
    results[id]!.pos.push(me.position);
    results[id]!.time.push(me.totalTime);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`balance: ${track.meta.eventName}, player ${player} (grid P11), ${N} paired seeds per strategy\n`);
console.log('strategy      mean pos  median pos  race time (s)');
for (const [id, r] of Object.entries(results)) {
  console.log(
    `${id.padEnd(13)} ${mean(r.pos).toFixed(2).padStart(8)}  ${String(median(r.pos)).padStart(10)}  ${mean(r.time).toFixed(1)} ± ${sd(r.time).toFixed(1)}`,
  );
}

const ids = Object.keys(results);
console.log('\nhead-to-head (row beats column, % of paired seeds)');
console.log(' '.repeat(13) + ids.map((id) => id.padStart(11)).join(''));
for (const a of ids) {
  const row = ids.map((b) => {
    if (a === b) return '—'.padStart(11);
    const wins = results[a]!.time.filter((t, i) => t < results[b]!.time[i]!).length;
    return `${((100 * wins) / N).toFixed(0)}%`.padStart(11);
  });
  console.log(a.padEnd(13) + row.join(''));
}
