/**
 * Live race playback. The engine steps whole laps; this store plays them out in race time so
 * the timing screen updates sector by sector and the map dots move.
 *
 * - `history[L]` = RaceState after lap L (history[0] = grid). Each car crosses the line at
 *   `history[L].car.totalTime`, and its lap-L sectors are `history[L].car.lastSectors`.
 * - `simTime` is race seconds. At 1× it runs at TIME_SCALE (10) race-seconds per wall-second,
 *   i.e. 1/10 real time: ~10 s per lap, ~3 s per sector.
 * - Laps are computed just in time (when the leader starts them). A BOX call re-simulates the
 *   player's current lap from its start state; per-lap RNG streams mean nothing else that's
 *   already on screen changes, except through the race itself (traffic behind you).
 * - Pace, battery, push targets and team orders take effect from the player's next lap.
 * - Radio decisions: at key moments the engineer asks a question with 2–3 answers. Where hints
 *   are allowed the worker scores each answer (expected finishing position).
 */
import { computed, Injectable, signal } from '@angular/core';
import {
  applyCommand,
  createRace,
  stepLap,
  type CarState,
  type Compound,
  type Difficulty,
  type ErsMode,
  type PaceMode,
  type PlayerCommand,
  type RaceEvent,
  type RaceState,
  type TeamOrder,
  type TrackData,
} from '@pit-wall/engine';
import { readRivals, type ReadKind } from './chatter';
import type { Circuit, RealResult } from './data';
import { finishLine, firstName, gapUpdate, radioFor, type RadioContext, type RadioLine } from './radio';
import type { HintResponse, WorkerRequest } from './strategy.worker';
import { hintsAllowed } from './visibility';

/** Playback multiplier: 0 = paused, else MIN_SPEED–MAX_SPEED. */
export type Speed = number;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 30;
/** Race seconds per wall second at 1×: 1/10 real time. */
export const TIME_SCALE = 10;
/** Past this share of the lap, a BOX call is too late for the pit entry and goes to next lap. */
const PIT_ENTRY = 0.9;
/** A rival pitting within this gap (s) or ±2 places triggers an undercut decision. */
const DECISION_GAP = 4;
/** Laps between chatter reads, and before the same read about the same driver repeats. */
const CHATTER_EVERY = 2;
const CHATTER_COOLDOWN = 10;
/** Worker samples per decision answer. */
const COMPARE_SAMPLES = 10;

export interface DecisionOption {
  label: string;
  commands: PlayerCommand[];
  /** Expected finishing position (worker), or null while pending / when hints are off. */
  estimate: number | null;
}

export interface Decision {
  id: number;
  lap: number;
  prompt: string;
  options: DecisionOption[];
  /** Race time it was asked, and when it lapses (no answer = do nothing). */
  t: number;
  expiresT: number;
}

export interface RaceSetup {
  seed: number;
  difficulty: Difficulty;
  playerDriver: string;
  startCompound: Compound;
}

export type SectorColour = 'purple' | 'green' | 'yellow' | 'none';

export interface LiveCar {
  code: string;
  teamId: string;
  isPlayer: boolean;
  /** State as of the last completed lap. */
  car: CarState;
  completedLaps: number;
  /** Sectors done in the lap in progress (0–2), or 3 once finished. */
  sectorsDone: number;
  /** This lap's completed sectors, else last lap's (dim). */
  sectors: { time: number | null; colour: SectorColour; current: boolean }[];
  /** Laps + fraction of distance, for the map. */
  progress: number;
  /** Fraction of the current lap's distance, 0–1. */
  lapFraction: number;
  gap: number | null;
  interval: number | null;
  inPitLap: boolean;
  finished: boolean;
  position: number;
}

interface TimedEvent {
  t: number;
  e: RaceEvent;
}

@Injectable({ providedIn: 'root' })
export class RaceStore {
  readonly track = signal<TrackData | null>(null);
  readonly circuit = signal<Circuit | null>(null);
  readonly real = signal<RealResult | null>(null);
  readonly history = signal<RaceState[]>([]);
  readonly simTime = signal(0);
  readonly speed = signal<Speed>(0);
  readonly radio = signal<RadioLine[]>([]);
  readonly hint = signal<HintResponse | null>(null);
  readonly hintPending = signal(false);
  readonly autoSlow = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly showResults = signal(false);
  readonly decision = signal<Decision | null>(null);
  readonly decisionPending = signal(false);

  private timed: TimedEvent[] = [];
  private processedT = -Infinity;
  private raf = 0;
  private lastFrame = 0;
  private worker: Worker | null = null;
  private hintId = 0;
  private compareId = 0;
  private decisionLap = new Map<string, number>();
  private chatterLap = -Infinity;
  private chatterSeen = new Map<string, number>();
  private lastSpeed: Speed = 1;

  readonly head = computed(() => this.history().at(-1) ?? null);
  readonly difficulty = computed(() => this.history()[0]?.config.difficulty ?? 'normal');
  readonly hintsAllowed = computed(() => {
    const s = this.history()[0];
    return s ? hintsAllowed(s) : false;
  });

  /** Live view of every car at simTime, in running order. */
  readonly live = computed<LiveCar[]>(() => {
    const hist = this.history();
    const track = this.track();
    if (!hist.length || !track) return [];
    const T = this.simTime();
    const f = track.sectorFractions;
    const dist = [0, f[0], f[0] + f[1], 1];
    const byLap = hist.map((s) => new Map(s.cars.map((c) => [c.driver, c])));
    const total = hist[0]!.totalLaps;

    const rows = hist[0]!.cars.map((c0) => {
      const code = c0.driver;
      let L = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (byLap[i]!.get(code)!.totalTime <= T) {
          L = i;
          break;
        }
      }
      const done = byLap[L]!.get(code)!;
      const next = byLap[L + 1]?.get(code) ?? null;
      const finished = L >= total;
      let k = 0;
      let lapFraction = 0;
      let cross = done.totalTime;
      if (!finished && next?.lastSectors) {
        const elapsed = Math.max(0, T - done.totalTime);
        let acc = 0;
        while (k < 2 && acc + next.lastSectors[k]! <= elapsed) acc += next.lastSectors[k++]!;
        cross = done.totalTime + acc;
        lapFraction = dist[k]! + Math.min(1, (elapsed - acc) / next.lastSectors[k]!) * f[k]!;
      }
      if (T < done.totalTime) lapFraction = 0; // on the grid
      return { code, L, k, cross, done, next, finished, lapFraction };
    });

    const line = (r: { L: number; k: number; finished: boolean }) => (r.finished ? total * 3 : r.L * 3 + r.k);
    rows.sort((a, b) => line(b) - line(a) || a.cross - b.cross);

    // Crossing time of a timing line for a car that has passed it.
    const crossAt = (code: string, lineIdx: number): number => {
      const L = Math.floor(lineIdx / 3);
      const k = lineIdx % 3;
      const base = byLap[L]!.get(code)!.totalTime;
      if (k === 0) return base;
      const secs = byLap[L + 1]!.get(code)!.lastSectors!;
      return base + secs.slice(0, k).reduce((a, b) => a + b, 0);
    };

    const leader = rows[0]!;
    const started = T >= Math.min(...hist[0]!.cars.map((c) => c.totalTime));
    return rows.map((r, i) => {
      const myLine = line(r);
      const gap = !started || i === 0 ? null : r.cross - crossAt(leader.code, myLine);
      const interval = !started || i === 0 ? null : r.cross - crossAt(rows[i - 1]!.code, myLine);
      // Sector colours vs personal best / overall best before this lap.
      const pbState = byLap[r.L]!.get(r.code)!;
      const overall = [0, 1, 2].map((j) => Math.min(...[...byLap[r.L]!.values()].map((c) => c.bestSectors[j] ?? Infinity)));
      const colour = (j: number, s: number): SectorColour => {
        if (s <= overall[j]!) return 'purple';
        const pb = pbState.bestSectors[j];
        return pb === null || s <= pb ? 'green' : 'yellow';
      };
      const sectors = [0, 1, 2].map((j) => {
        if (!r.finished && r.next?.lastSectors && j < r.k) {
          const s = r.next.lastSectors[j]!;
          return { time: s, colour: colour(j, s), current: true };
        }
        const last = r.done.lastSectors?.[j] ?? null;
        return { time: last, colour: 'none' as SectorColour, current: false };
      });
      const pitted = !!r.next && r.next.pitStops > r.done.pitStops;
      return {
        code: r.code,
        teamId: r.done.teamId,
        isPlayer: r.done.isPlayer,
        car: r.done,
        completedLaps: r.L,
        sectorsDone: r.finished ? 3 : r.k,
        sectors,
        progress: r.L + r.lapFraction,
        lapFraction: r.lapFraction,
        gap,
        interval,
        inPitLap: pitted && r.k === 2,
        finished: r.finished,
        position: i + 1,
      };
    });
  });

  readonly me = computed(() => this.live().find((c) => c.isPlayer) ?? null);
  readonly leaderLap = computed(() => {
    const l = this.live()[0];
    const total = this.history()[0]?.totalLaps ?? 0;
    return l ? Math.min(total, l.finished ? total : l.completedLaps + 1) : 0;
  });

  /** Race-control status as the viewer currently knows it (from visible events). */
  readonly flag = computed<'green' | 'sc' | 'vsc' | 'red' | 'chequered'>(() => {
    const T = this.simTime();
    this.history(); // re-evaluate when laps are added
    let st: 'green' | 'sc' | 'vsc' | 'red' | 'chequered' = 'green';
    for (const { t, e } of this.timed) {
      if (t > T) break;
      if (e.type === 'sc_deployed') st = 'sc';
      else if (e.type === 'vsc_deployed') st = 'vsc';
      else if (e.type === 'red_flag') st = 'red';
      else if (e.type === 'sc_ending' || e.type === 'vsc_ending' || e.type === 'restart') st = 'green';
      else if (e.type === 'race_finish') st = 'chequered';
    }
    return st;
  });

  readonly visibleEvents = computed(() => {
    const T = this.simTime();
    this.history();
    return this.timed.filter((x) => x.t <= T);
  });

  readonly finishedAll = computed(() => {
    const live = this.live();
    return live.length > 0 && live.every((c) => c.finished);
  });

  // ---------------------------------------------------------------------------

  load(track: TrackData, circuit: Circuit, real: RealResult | null): void {
    this.stop();
    this.track.set(track);
    this.circuit.set(circuit);
    this.real.set(real);
    this.history.set([]);
  }

  /** Preview state for the pre-race screen (no playback). */
  preview(setup: RaceSetup): RaceState | null {
    const track = this.track();
    if (!track) return null;
    return createRace(track, {
      seed: setup.seed,
      difficulty: setup.difficulty,
      playerDriver: setup.playerDriver,
      playerStrategy: { startCompound: setup.startCompound, stops: [], neutralisedPitWindow: 0 },
    });
  }

  start(setup: RaceSetup): void {
    const s0 = this.preview(setup);
    if (!s0) return;
    this.stop();
    this.timed = [];
    this.radio.set([]);
    this.hint.set(null);
    this.autoSlow.set(null);
    this.notice.set(null);
    this.showResults.set(false);
    this.decision.set(null);
    this.decisionLap.clear();
    this.chatterSeen.clear();
    this.chatterLap = -Infinity;
    this.history.set([s0]);
    const first = Math.min(...s0.cars.map((c) => c.totalTime));
    this.timed.push({ t: first, e: s0.events[0]! });
    this.simTime.set(first - 3); // a beat on the grid before lights out
    this.processedT = -Infinity;
    this.ensureComputed();
    this.speed.set(1);
    this.loop();
  }

  quit(): void {
    this.stop();
    this.history.set([]);
  }

  setSpeed(speed: Speed): void {
    const v = speed <= 0 ? 0 : Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    if (v > 0) this.lastSpeed = v;
    this.speed.set(v);
    this.autoSlow.set(null);
    if (v > 0) this.loop();
  }

  togglePause(): void {
    this.setSpeed(this.speed() > 0 ? 0 : this.lastSpeed);
  }

  /** Skip to the next lap line for the player (useful while paused). */
  skipToNextLap(): void {
    const me = this.me();
    const hist = this.history();
    if (!me || me.finished) return;
    const next = hist[me.completedLaps + 1]?.cars.find((c) => c.isPlayer);
    if (next) {
      this.simTime.set(next.totalTime + 0.01);
      this.ensureComputed();
      this.processEvents();
    }
  }

  box(compound: Compound | null): void {
    const me = this.me();
    const hist = this.history();
    if (!me || me.finished) return;
    const L = me.completedLaps;
    const cmd = compound ? ({ type: 'box', compound } as const) : ({ type: 'cancel_box' } as const);
    if (me.lapFraction < PIT_ENTRY && hist[L + 1]) {
      // Still before pit entry: this lap's box (or cancel) takes effect now.
      this.rebuildFrom(L, applyCommand(hist[L]!, cmd));
      this.notice.set(compound ? null : 'Box cancelled.');
    } else if (hist[L + 1]) {
      this.rebuildFrom(L + 1, applyCommand(hist[L + 1]!, cmd));
      this.notice.set(compound ? 'Past pit entry. Boxing at the end of NEXT lap.' : 'Box cancelled for next lap.');
    }
  }

  /** The pending box the player will take, if any (this lap's or next). */
  readonly pendingBox = computed(() => {
    const me = this.me();
    const hist = this.history();
    if (!me) return null;
    const cur = hist[me.completedLaps]?.cars.find((c) => c.isPlayer)?.pendingBox ?? null;
    if (cur) return { compound: cur, thisLap: true };
    const nxt = hist[me.completedLaps + 1]?.cars.find((c) => c.isPlayer)?.pendingBox ?? null;
    return nxt ? { compound: nxt, thisLap: false } : null;
  });

  setPace(mode: PaceMode): void {
    this.nextLap({ type: 'set_pace', mode });
  }
  pushFor(laps: number): void {
    this.nextLap({ type: 'push_for', laps });
  }
  setErs(mode: ErsMode): void {
    this.nextLap({ type: 'set_ers', mode });
  }
  setTeamOrder(order: TeamOrder): void {
    this.nextLap({ type: 'team_order', order });
  }

  /** Apply a command from the player's next lap (this lap's sectors are already being timed). BOX keeps its own timing. */
  private nextLap(cmd: PlayerCommand): void {
    if (cmd.type === 'box' || cmd.type === 'cancel_box') return this.box(cmd.type === 'box' ? cmd.compound : null);
    const me = this.me();
    const hist = this.history();
    if (!me || me.finished) return;
    const L = me.completedLaps + 1;
    if (hist[L]) this.rebuildFrom(L, applyCommand(hist[L]!, cmd));
  }

  /** The player's car as it will start their next lap (what the controls show as set). */
  private readonly nextState = computed(() => {
    const me = this.me();
    const hist = this.history();
    if (!me) return null;
    return (hist[me.completedLaps + 1] ?? hist[me.completedLaps])!.cars.find((c) => c.isPlayer)!;
  });
  readonly paceMode = computed<PaceMode>(() => this.nextState()?.paceMode ?? 'neutral');
  readonly pushUntil = computed(() => this.nextState()?.pushUntil ?? null);
  readonly ersMode = computed<ErsMode>(() => this.nextState()?.ersMode ?? 'neutral');
  readonly teamOrder = computed<TeamOrder>(() => this.nextState()?.teamOrder ?? 'none');
  /** Battery as of the player's last line crossing. */
  readonly battery = computed(() => this.me()?.car.battery ?? 1);
  readonly teammate = computed(() => {
    const me = this.me();
    return me ? (this.live().find((c) => !c.isPlayer && c.teamId === me.teamId) ?? null) : null;
  });

  /** Compound to suggest for a stop: the hint's if it's legal, else one that suits the laps left. */
  suggestedCompound(): Compound {
    const me = this.me()?.car;
    const total = this.history()[0]?.totalLaps;
    if (!me || !total) return 'H';
    const ruleOk = (c: Compound) => me.compoundsUsed.length >= 2 || c !== me.compound;
    const hinted = this.hint()?.windows[0]?.compound;
    if (hinted && ruleOk(hinted)) return hinted;
    const left = total - this.leaderLap();
    const pref: Compound[] = left > total * 0.45 ? ['H', 'M', 'S'] : left > total * 0.25 ? ['M', 'H', 'S'] : ['S', 'M', 'H'];
    return pref.find(ruleOk)!;
  }

  answer(i: number): void {
    const d = this.decision();
    if (!d) return;
    const opt = d.options[i];
    this.decision.set(null);
    this.decisionPending.set(false);
    if (!opt) return;
    for (const cmd of opt.commands) this.nextLap(cmd);
    this.radio.update((r) => [...r, { t: this.simTime(), lap: d.lap, who: 'drv' as const, text: `Copy. ${opt.label}.` }]);
  }

  requestHint(): void {
    const track = this.track();
    const me = this.me();
    if (!track || !me || me.finished || !this.hintsAllowed()) return;
    const state = this.history()[me.completedLaps]!;
    this.post({ kind: 'hint', id: ++this.hintId, track, state, samples: 24 });
    this.hintPending.set(true);
  }

  /** Pre-race strategy recommendation (Easy/Normal). Resolves with the worker's answer. */
  recommend(state: RaceState): Promise<HintResponse> {
    const track = this.track()!;
    const id = ++this.hintId;
    this.post({ kind: 'recommend', id, track, state, samples: 16 });
    this.hintPending.set(true);
    return new Promise((resolve) => {
      this.pendingRecommend = { id, resolve };
    });
  }
  private pendingRecommend: { id: number; resolve: (r: HintResponse) => void } | null = null;

  // ---------------------------------------------------------------------------

  private post(req: WorkerRequest): void {
    this.worker ??= this.createWorker();
    this.worker.postMessage(req);
  }

  private createWorker(): Worker {
    const w = new Worker(new URL('./strategy.worker', import.meta.url), { type: 'module' });
    w.onmessage = ({ data }: MessageEvent<HintResponse>) => {
      if (data.kind === 'compare') {
        const d = this.decision();
        if (!d || data.id !== d.id) return; // answered or lapsed
        this.decisionPending.set(false);
        this.decision.set({ ...d, options: d.options.map((o, i) => ({ ...o, estimate: data.estimates?.[i] ?? null })) });
        return;
      }
      if (data.id !== this.hintId) return; // stale
      this.hintPending.set(false);
      if (this.pendingRecommend?.id === data.id) {
        this.pendingRecommend.resolve(data);
        this.pendingRecommend = null;
      } else {
        this.hint.set(data);
      }
    };
    return w;
  }

  /** Replace history[i] with `state` and re-simulate the laps that were already computed after it. */
  private rebuildFrom(i: number, state: RaceState): void {
    const track = this.track()!;
    const hist = this.history();
    const horizon = hist.length - 1;
    const out = hist.slice(0, i);
    out.push(state);
    while (out.length - 1 < horizon && !out.at(-1)!.finished) out.push(stepLap(track, out.at(-1)!));
    this.history.set(out);
    this.retime(i + 1);
  }

  private ensureComputed(): void {
    const track = this.track();
    let hist = this.history();
    if (!track || !hist.length) return;
    let added = false;
    // Compute lap L+1 as soon as any car can start it.
    while (!hist.at(-1)!.finished && this.simTime() >= Math.min(...hist.at(-1)!.cars.map((c) => c.totalTime)) - 1) {
      hist = [...hist, stepLap(track, hist.at(-1)!)];
      added = true;
    }
    if (added) {
      const from = this.history().length;
      this.history.set(hist);
      this.retime(from);
    }
  }

  /** (Re)build the timed event list for laps >= fromLap. */
  private retime(fromLap: number): void {
    const hist = this.history();
    this.timed = this.timed.filter((x) => x.e.lap < fromLap);
    for (let L = Math.max(1, fromLap); L < hist.length; L++) {
      const prev = hist[L - 1]!;
      const cur = hist[L]!;
      const start = Math.min(...prev.cars.map((c) => c.totalTime));
      const leaderLap = cur.cars[0]!.lastLapTime ?? 100;
      const endOf = (code: string) => cur.cars.find((c) => c.driver === code)!.totalTime;
      for (const e of cur.events.slice(prev.events.length)) {
        let t: number;
        switch (e.type) {
          case 'sc_deployed':
          case 'vsc_deployed':
          case 'red_flag':
            t = start + 0.35 * leaderLap;
            break;
          case 'sc_ending':
          case 'vsc_ending':
          case 'restart':
            t = start + 0.6 * leaderLap;
            break;
          case 'race_finish':
            t = endOf(e.winner);
            break;
          case 'overtake':
            t = endOf(e.driver) - 2;
            break;
          case 'race_start':
            t = start;
            break;
          default:
            t = endOf(e.driver);
        }
        this.timed.push({ t, e });
      }
    }
    this.timed.sort((a, b) => a.t - b.t);
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      const speed = this.speed();
      if (speed > 0 && this.history().length) {
        try {
          this.simTime.update((t) => t + dt * TIME_SCALE * speed);
          this.ensureComputed();
          this.processEvents();
        } catch (err) {
          // Never freeze silently: pause and say what broke.
          console.error('[pit-wall] sim error', err);
          this.speed.set(0);
          this.notice.set(`Sim error, paused: ${(err as Error).message}`);
          return;
        }
        if (this.finishedAll()) {
          this.speed.set(0);
          this.showResults.set(true);
          return;
        }
        this.raf = requestAnimationFrame(frame);
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** A hidden tab pauses the race (rAF stops anyway; this keeps the speed buttons honest). */
  private readonly onVisibility = () => {
    if (document.hidden && this.speed() > 0) {
      this.speed.set(0);
      this.notice.set('Paused while the tab was hidden.');
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.speed.set(0);
  }

  /** Radio, auto-slow and gap updates for events that just became visible. */
  private processEvents(): void {
    const T = this.simTime();
    const hist = this.history();
    const meLive = this.me();
    if (!meLive) return;
    const state = hist[meLive.completedLaps]!;
    const ctx: RadioContext = {
      me: meLive.car,
      meName: firstName(this.track()!.drivers.find((d) => d.code === meLive.code)!.fullName),
      state,
      names: new Map(this.track()!.drivers.map((d) => [d.code, d.fullName])),
    };
    const lines: RadioLine[] = [];
    let slow: string | null = null;
    const d0 = this.decision();
    if (d0 && T > d0.expiresT) {
      this.decision.set(null);
      this.decisionPending.set(false);
    }
    const nearby = new Set(
      this.live()
        .filter((c) => !c.isPlayer && Math.abs(c.position - meLive.position) <= 2)
        .map((c) => c.code),
    );
    for (const { t, e } of this.timed) {
      if (t <= this.processedT) continue;
      if (t > T) break;
      lines.push(...radioFor(e, t, ctx));
      if (e.type === 'sc_deployed') slow = 'Safety car';
      else if (e.type === 'vsc_deployed') slow = 'Virtual safety car';
      else if (e.type === 'red_flag') slow = 'Red flag';
      else if (e.type === 'pit_stop' && nearby.has(e.driver)) slow = `${e.driver} pitted`;
      this.maybeDecide(e, t, ctx);
      if (e.type === 'race_finish') {
        const meEnd = hist.at(-1)!.cars.find((c) => c.isPlayer)!;
        lines.push(...finishLine(t + 8, e.lap, { ...ctx, me: meEnd }));
      }
    }
    // Gap update when the player crosses the line.
    const myLineT = state.cars.find((c) => c.isPlayer)!.totalTime;
    if (myLineT > this.processedT && myLineT <= T) {
      const g = gapUpdate(myLineT, meLive.completedLaps, ctx);
      if (g) lines.push(g);
      lines.push(...this.chatter(myLineT, meLive.completedLaps, ctx));
    }
    this.processedT = T;
    if (lines.length) this.radio.update((r) => [...r, ...lines].slice(-80));
    const d1 = this.decision();
    if (!slow && d1 && d1 !== d0) slow = 'Radio decision';
    if (slow && this.speed() > 1) {
      this.speed.set(1);
      this.autoSlow.set(slow);
    }
  }

  // ---------------------------------------------------------------------------
  // Chatter and radio decisions

  /** One rival read at most every CHATTER_EVERY laps. Closing / catching may open a decision. */
  private chatter(t: number, lap: number, ctx: RadioContext): RadioLine[] {
    if (lap - this.chatterLap < CHATTER_EVERY) return [];
    const reads = readRivals(this.track()!, this.history(), lap, ctx.names);
    const fresh = reads.find((r) => lap - (this.chatterSeen.get(r.kind + r.driver) ?? -Infinity) >= CHATTER_COOLDOWN);
    if (!fresh) return [];
    this.chatterLap = lap;
    this.chatterSeen.set(fresh.kind + fresh.driver, lap);
    if (fresh.kind === 'closing' || fresh.kind === 'catching') this.askBattle(fresh.kind, fresh.driver, t, lap, ctx);
    return [{ t: t + 2, lap, who: 'eng', text: fresh.text }];
  }

  private askBattle(kind: ReadKind, code: string, t: number, lap: number, ctx: RadioContext): void {
    const rival = ctx.state.cars.find((c) => c.driver === code);
    const gap = rival ? Math.abs(rival.totalTime - ctx.me.totalTime) : Infinity;
    if (!rival || gap > 1.2) return;
    const who = this.surname(code);
    if (kind === 'closing') {
      this.ask('defend', t, lap, `${who} is ${gap.toFixed(1)} behind and closing. Defend?`, [
        { label: 'Defend, use the battery', commands: [{ type: 'set_ers', mode: 'defend' }] },
        { label: 'Let him go, save the tyres', commands: [{ type: 'set_pace', mode: 'conserve' }, { type: 'set_ers', mode: 'harvest' }] },
        { label: 'Keep doing what we are doing', commands: [] },
      ]);
    } else {
      const mate = rival.teamId === ctx.me.teamId;
      this.ask('attack', t, lap, mate ? `We're right behind ${who}, and we're quicker.` : `We're right with ${who}. Go for it?`, [
        mate
          ? { label: `Ask ${who} to let you by`, commands: [{ type: 'team_order', order: 'let_by' }] }
          : { label: 'Attack, deploy the battery', commands: [{ type: 'set_ers', mode: 'attack' }] },
        { label: 'Push for 3 laps', commands: [{ type: 'push_for', laps: 3 }] },
        { label: 'Hold position, harvest', commands: [{ type: 'set_ers', mode: 'harvest' }] },
      ]);
    }
  }

  /** Radio decisions triggered by race events (neutralisations, rivals pitting near us). */
  private maybeDecide(e: RaceEvent, t: number, ctx: RadioContext): void {
    const me = ctx.me;
    if (me.status !== 'running' || this.pendingBox()) return;
    const left = ctx.state.totalLaps - e.lap;
    const c = this.suggestedCompound();
    const tyre = { S: 'softs', M: 'mediums', H: 'hards' }[c];
    if ((e.type === 'sc_deployed' || e.type === 'vsc_deployed') && me.tyreAge >= 5 && left > 3) {
      const sc = e.type === 'sc_deployed' ? 'Safety car' : 'VSC';
      this.ask('neutralised', t, e.lap, `${sc}. A stop is cheap now. Box for ${tyre}?`, [
        { label: `Box for ${tyre}`, commands: [{ type: 'box', compound: c }] },
        { label: 'Stay out, keep track position', commands: [] },
      ]);
    } else if (e.type === 'pit_stop' && e.driver !== me.driver && left > 5 && me.tyreAge >= 5) {
      // Where the rival was relative to us at the start of the lap it boxed.
      const rival = ctx.state.cars.find((x) => x.driver === e.driver);
      if (!rival) return;
      const dPos = rival.position - me.position;
      if (Math.abs(dPos) > 2 && Math.abs(rival.totalTime - me.totalTime) > DECISION_GAP) return;
      const who = this.surname(e.driver);
      if (dPos > 0) {
        this.ask('undercut', t, e.lap, `${who} has boxed behind us. That's the undercut. Cover?`, [
          { label: `Box this lap for ${tyre}`, commands: [{ type: 'box', compound: c }] },
          { label: 'Stay out and push 3 laps (overcut)', commands: [{ type: 'push_for', laps: 3 }] },
          { label: 'Stay out, stick to the plan', commands: [] },
        ]);
      } else {
        this.ask('overcut', t, e.lap, `${who} has boxed ahead of us. Clear air now.`, [
          { label: 'Push 3 laps, try the overcut', commands: [{ type: 'push_for', laps: 3 }] },
          { label: `Box this lap for ${tyre} too`, commands: [{ type: 'box', compound: c }] },
          { label: 'Stick to the plan', commands: [] },
        ]);
      }
    }
  }

  /** Open a decision: one at a time, each kind at most once per 3 laps. */
  private ask(kind: string, t: number, lap: number, prompt: string, options: Omit<DecisionOption, 'estimate'>[]): void {
    if (this.decision() || lap - (this.decisionLap.get(kind) ?? -Infinity) < 3) return;
    this.decisionLap.set(kind, lap);
    const lapLen = this.history().at(-1)!.cars[0]!.lastLapTime ?? 100;
    const id = ++this.compareId;
    this.decision.set({ id, lap, prompt, t, expiresT: t + lapLen, options: options.map((o) => ({ ...o, estimate: null })) });
    const me = this.me();
    if (this.hintsAllowed() && me) {
      this.decisionPending.set(true);
      const state = this.history()[me.completedLaps]!;
      this.post({ kind: 'compare', id, track: this.track()!, state, samples: COMPARE_SAMPLES, options: options.map((o) => o.commands) });
    }
  }

  private surname(code: string): string {
    const n = this.track()?.drivers.find((d) => d.code === code)?.fullName ?? code;
    return n.split(' ').slice(1).join(' ') || n;
  }
}
