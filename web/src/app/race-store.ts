import { computed, Injectable, signal } from '@angular/core';
import {
  applyCommand,
  createRace,
  stepLap,
  type Compound,
  type Difficulty,
  type PlayerCommand,
  type RaceEvent,
  type RaceState,
  type TrackData,
} from '@pit-wall/engine';
import type { HintRequest, HintResponse } from './strategy.worker';
import { hintsAllowed } from './visibility';

export type Speed = 0 | 1 | 4 | 16;

/** Wall-clock ms per lap at 1×. PLAN.md suggests ~62 s; the demo runs much faster. */
const MS_PER_LAP_1X = 2400;
const HINT_SAMPLES = 24;

export interface RaceSetup {
  seed: number;
  difficulty: Difficulty;
  playerDriver: string;
  startCompound: Compound;
}

@Injectable({ providedIn: 'root' })
export class RaceStore {
  readonly track = signal<TrackData | null>(null);
  readonly state = signal<RaceState | null>(null);
  /** One state per completed lap (index = lap), for charts. */
  readonly history = signal<RaceState[]>([]);
  readonly speed = signal<Speed>(0);
  readonly hint = signal<HintResponse | null>(null);
  readonly hintPending = signal(false);
  /** Last auto-slow reason, shown briefly in the header. */
  readonly autoSlow = signal<string | null>(null);

  readonly player = computed(() => this.state()?.cars.find((c) => c.isPlayer) ?? null);
  readonly hintsAllowed = computed(() => {
    const s = this.state();
    return s ? hintsAllowed(s) : false;
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private worker: Worker | null = null;
  private hintId = 0;

  async loadTrack(url = 'tracks/synthetic-22.json'): Promise<void> {
    const res = await fetch(url);
    this.track.set((await res.json()) as TrackData);
  }

  start(setup: RaceSetup): void {
    const track = this.track();
    if (!track) return;
    this.stop();
    const state = createRace(track, {
      seed: setup.seed,
      difficulty: setup.difficulty,
      playerDriver: setup.playerDriver,
      playerStrategy: { startCompound: setup.startCompound, stops: [], neutralisedPitWindow: 0 },
    });
    this.state.set(state);
    this.history.set([state]);
    this.hint.set(null);
    this.autoSlow.set(null);
  }

  reset(): void {
    this.stop();
    this.state.set(null);
    this.history.set([]);
    this.hint.set(null);
  }

  setSpeed(speed: Speed): void {
    this.speed.set(speed);
    this.autoSlow.set(null);
    this.schedule();
  }

  command(cmd: PlayerCommand): void {
    const s = this.state();
    if (s) this.state.set(applyCommand(s, cmd));
  }

  /** Advance one lap now (also used by the "+1 lap" button while paused). */
  step(): void {
    const track = this.track();
    const prev = this.state();
    if (!track || !prev || prev.finished) return;
    const next = stepLap(track, prev);
    this.state.set(next);
    this.history.update((h) => [...h, next]);
    const newEvents = next.events.slice(prev.events.length);
    this.maybeAutoSlow(newEvents, next);
    if (this.hint() && this.hint()!.best.lap !== null && this.hint()!.best.lap! <= next.lap) this.hint.set(null);
    if (next.finished) this.stop();
  }

  requestHint(): void {
    const track = this.track();
    const state = this.state();
    if (!track || !state || state.finished || !hintsAllowed(state)) return;
    this.worker ??= this.createWorker();
    const req: HintRequest = { id: ++this.hintId, track, state, samples: HINT_SAMPLES };
    this.hintPending.set(true);
    this.worker.postMessage(req);
  }

  private createWorker(): Worker {
    const w = new Worker(new URL('./strategy.worker', import.meta.url), { type: 'module' });
    w.onmessage = ({ data }: MessageEvent<HintResponse>) => {
      if (data.id !== this.hintId) return; // stale
      this.hint.set(data);
      this.hintPending.set(false);
    };
    return w;
  }

  private maybeAutoSlow(events: RaceEvent[], state: RaceState): void {
    if (this.speed() <= 1) return;
    const me = state.cars.find((c) => c.isPlayer)!;
    const near = new Set(state.cars.filter((c) => !c.isPlayer && Math.abs(c.position - me.position) <= 2).map((c) => c.driver));
    let reason: string | null = null;
    for (const e of events) {
      if (e.type === 'sc_deployed') reason = 'Safety car';
      else if (e.type === 'vsc_deployed') reason = 'Virtual safety car';
      else if (e.type === 'red_flag') reason = 'Red flag';
      else if (e.type === 'pit_stop' && near.has(e.driver)) reason = `${e.driver} pitted`;
    }
    if (reason) {
      this.speed.set(1);
      this.autoSlow.set(reason);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const speed = this.speed();
    if (speed === 0 || !this.state() || this.state()!.finished) return;
    this.timer = setTimeout(() => {
      this.step();
      this.schedule();
    }, MS_PER_LAP_1X / speed);
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.speed.set(0);
  }
}
