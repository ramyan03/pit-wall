/**
 * Pit-wall chatter that reads rivals' races the way a real strategist does: from compounds, tyre
 * ages, stop counts and lap times on the timing screen. It never reads AI strategies or the
 * hidden tyre model (`effectiveTyres` / `TrackData.tyres`), so it's safe in Hard mode and can be
 * wrong, like a real pit wall.
 */
import type { Compound, RaceState, TrackData } from '@pit-wall/engine';

export type ReadKind = 'long' | 'two_stop' | 'dropping' | 'closing' | 'catching';

export interface RivalRead {
  kind: ReadKind;
  driver: string;
  text: string;
  /** Lower = more urgent. */
  priority: number;
}

/** Rule of thumb for how much of a race one stint can last. Public knowledge, not the tyre model. */
const STINT_SHARE: Record<Compound, number> = { S: 0.35, M: 0.5, H: 0.7 };
const NAME: Record<Compound, string> = { S: 'softs', M: 'mediums', H: 'hards' };
/** Fuel-and-rubber-corrected lap-time slope (s/lap) that counts as "dropping off". Normal deg is ~0.03–0.09. */
const DROP_SLOPE = 0.15;
/** Laps the slope is fitted over (fewer is too noisy at σ ≈ 0.3). */
const TREND_LAPS = 8;
/** Gap change per lap that counts as closing / catching. */
const CLOSING_RATE = 0.25;
/** Only read cars this many places either side of the player (plus the leader). */
const RANGE = 3;

/**
 * Reads on the rivals around the player, as of the end of lap `L` (the player's last completed
 * lap). `hist[k]` is the race after lap k, the same history the timing screen shows.
 */
export function readRivals(track: TrackData, hist: RaceState[], L: number, names: Map<string, string>): RivalRead[] {
  const state = hist[L];
  if (!state || L < 4) return [];
  const me = state.cars.find((c) => c.isPlayer);
  if (!me || me.status !== 'running') return [];
  const total = state.totalLaps;
  const left = total - L;
  const sur = (code: string) => {
    const n = names.get(code) ?? code;
    return n.split(' ').slice(1).join(' ') || n;
  };
  const reads: RivalRead[] = [];

  for (const r of state.cars) {
    if (r.isPlayer || r.status !== 'running') continue;
    const dPos = r.position - me.position;
    if (Math.abs(dPos) > RANGE && r.position !== 1) continue;
    const ahead = dPos < 0;
    const gap = Math.abs(r.totalTime - me.totalTime);
    const who = sur(r.driver);
    const stint = STINT_SHARE[r.compound] * total;

    // Going long: no stop yet, deep into what a first stint normally lasts.
    if (r.pitStops === 0 && r.tyreAge >= stint && left > 5) {
      const advice = ahead
        ? me.pitStops > 0
          ? "He still has to stop, so that's track position for us. Keep pushing."
          : 'Undercut is on if we want it.'
        : "He'll come back at us on fresher tyres at the end.";
      reads.push({ kind: 'long', driver: r.driver, priority: 2, text: `${who} is still out on ${r.tyreAge}-lap ${NAME[r.compound]}. Looks like he's going long, one stop. ${advice}` });
    }

    // Can't reach the flag on this set: another stop is coming.
    if (r.pitStops >= 1 && left > stint + 3 && r.tyreAge >= 3) {
      const advice = ahead
        ? "Don't burn the tyres chasing him, he has to stop again."
        : "Don't fight him too hard, he's got another stop to make.";
      reads.push({ kind: 'two_stop', driver: r.driver, priority: 3, text: `${who} is on ${NAME[r.compound]} with ${left} to go. He can't make that last, so it's a two-stop. ${advice}` });
    }

    // Pace dropping off on old tyres.
    const trend = paceTrend(track, hist, L, r.driver);
    if (trend !== null && trend > DROP_SLOPE && r.tyreAge >= TREND_LAPS) {
      const advice = ahead && gap < 8 ? ' Push now, we can close this.' : '';
      reads.push({ kind: 'dropping', driver: r.driver, priority: ahead ? 1 : 4, text: `${who}'s pace is dropping off, losing about ${trend.toFixed(2)} a lap. Tyres are going.${advice}` });
    }

    // Gap trend to a neighbour.
    if (Math.abs(dPos) === 1 && gap < 6) {
      const rate = gapRate(hist, L, r.driver, me.driver);
      if (rate !== null && rate > CLOSING_RATE) {
        reads.push(
          ahead
            ? { kind: 'catching', driver: r.driver, priority: 2, text: `We're catching ${who}, ${rate.toFixed(1)} a lap. Gap ${gap.toFixed(1)}.` }
            : { kind: 'closing', driver: r.driver, priority: 1, text: `${who} is closing, about ${rate.toFixed(1)} a lap. Gap ${gap.toFixed(1)}.` },
        );
      }
    }
  }
  return reads.sort((a, b) => a.priority - b.priority);
}

/** True if lap k (1-based) was a clean green lap for `code`: no SC/VSC, no in-lap or out-lap. */
function cleanLap(hist: RaceState[], k: number, code: string): boolean {
  const prev = hist[k - 1]!;
  const cur = hist[k]!;
  if (k < 2 || prev.neutralisation.status !== 'green') return false;
  if (cur.events.some((e) => e.lap === k && /deployed|red_flag/.test(e.type))) return false;
  const a = prev.cars.find((c) => c.driver === code)!;
  const b = cur.cars.find((c) => c.driver === code)!;
  return b.pitStops === a.pitStops && a.tyreAge > 0;
}

/**
 * Least-squares slope (s/lap) of the car's recent lap times in its current stint, corrected for fuel
 * burn and track evolution. Laps spent stuck behind another car are skipped.
 */
function paceTrend(track: TrackData, hist: RaceState[], L: number, code: string): number | null {
  const pts: [number, number][] = [];
  for (let k = L; k > 1 && pts.length < TREND_LAPS; k--) {
    if (!cleanLap(hist, k, code)) break; // only within the current stint
    const before = hist[k - 1]!.cars.find((c) => c.driver === code)!;
    if (before.position > 1 && before.interval < track.traffic.followGap) continue; // held up
    const t = hist[k]!.cars.find((c) => c.driver === code)!.lastLapTime!;
    pts.push([k, t + (track.fuel.fuelSecPerLap + track.trackEvo) * (k - L)]);
  }
  if (pts.length < TREND_LAPS - 2) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  return sxy / sxx;
}

/** How fast the gap between `code` and the player is shrinking (s/lap, + = closing), over 3 laps. */
function gapRate(hist: RaceState[], L: number, code: string, meCode: string): number | null {
  const gapAt = (k: number) => {
    const s = hist[k]!;
    const r = s.cars.find((c) => c.driver === code)!;
    const m = s.cars.find((c) => c.driver === meCode)!;
    return { gap: Math.abs(r.totalTime - m.totalTime), stops: r.pitStops + m.pitStops };
  };
  if (L < 4) return null;
  for (let k = L - 2; k <= L; k++) if (!cleanLap(hist, k, code) || !cleanLap(hist, k, meCode)) return null;
  const a = gapAt(L - 3);
  const b = gapAt(L);
  if (a.stops !== b.stops) return null;
  return (a.gap - b.gap) / 3;
}
