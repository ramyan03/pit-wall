import { Component, computed, inject, OnInit, signal } from '@angular/core';
import type { CarState, Compound, Difficulty, PaceMode, RaceEvent } from '@pit-wall/engine';
import { RaceStore, type Speed } from './race-store';
import { tyreGuide, wearReadout } from './visibility';

const COMPOUND_NAME: Record<Compound, string> = { S: 'Soft', M: 'Medium', H: 'Hard' };

interface TracePoint {
  lap: number;
  time: number;
  x: number;
  y: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly store = inject(RaceStore);
  protected readonly compounds: Compound[] = ['S', 'M', 'H'];
  protected readonly compoundName = COMPOUND_NAME;
  protected readonly speeds: Speed[] = [1, 4, 16];
  protected readonly paceModes: PaceMode[] = ['push', 'neutral', 'conserve'];
  protected readonly difficulties: { id: Difficulty; blurb: string }[] = [
    { id: 'easy', blurb: 'No incidents. Wear shown. Strategist hints.' },
    { id: 'normal', blurb: 'SC / VSC / red flags. Wear shown. Strategist hints.' },
    { id: 'hard', blurb: 'Incidents on. No wear readout, no hints. Read the lap times.' },
  ];

  // Setup form
  protected readonly setupDriver = signal('');
  protected readonly setupDifficulty = signal<Difficulty>('normal');
  protected readonly setupCompound = signal<Compound>('M');
  protected readonly setupSeed = signal(randomSeed());

  protected readonly track = this.store.track;
  protected readonly state = this.store.state;
  protected readonly me = this.store.player;

  protected readonly teams = computed(() => new Map((this.track()?.teams ?? []).map((t) => [t.id, t])));
  protected readonly grid = computed(() => [...(this.track()?.drivers ?? [])].sort((a, b) => a.gridPosition - b.gridPosition));

  /** Position change versus the previous lap, per driver. */
  protected readonly posDelta = computed(() => {
    const h = this.store.history();
    const prev = h.at(-2);
    const out = new Map<string, number>();
    if (!prev) return out;
    const before = new Map(prev.cars.map((c) => [c.driver, c.position]));
    for (const c of h.at(-1)!.cars) out.set(c.driver, (before.get(c.driver) ?? c.position) - c.position);
    return out;
  });

  protected readonly pittedThisLap = computed(() => {
    const s = this.state();
    if (!s) return new Set<string>();
    return new Set(s.events.filter((e) => e.type === 'pit_stop' && e.lap === s.lap).map((e) => (e as { driver: string }).driver));
  });

  protected readonly wear = computed(() => {
    const t = this.track();
    const s = this.state();
    const me = this.me();
    return t && s && me ? wearReadout(t, s, me) : null;
  });

  protected readonly guide = computed(() => {
    const t = this.track();
    const s = this.state();
    return t && s ? tyreGuide(t, s) : null;
  });

  protected readonly neighbours = computed(() => {
    const s = this.state();
    const me = this.me();
    if (!s || !me) return { ahead: null, behind: null };
    return { ahead: s.cars[me.position - 2] ?? null, behind: s.cars[me.position] ?? null };
  });

  protected readonly twoCompoundWarning = computed(() => {
    const s = this.state();
    const me = this.me();
    if (!s || !me || s.finished) return false;
    const willUse = new Set([...me.compoundsUsed, ...(me.pendingBox ? [me.pendingBox] : [])]);
    return willUse.size < 2;
  });

  protected readonly feed = computed(() => {
    const s = this.state();
    if (!s) return [];
    const me = this.me()?.driver;
    return s.events
      // Every on-track pass would flood the feed; keep only the player's.
      .filter((e) => e.type !== 'overtake' || involves(e, me))
      .slice(-60)
      .reverse()
      .map((e) => ({ e, text: describe(e), radio: e.type === 'radio', mine: involves(e, me) }));
  });

  /** Player's green-flag lap times, for reading wear off the stopwatch. */
  protected readonly trace = computed(() => {
    const me = this.me();
    if (!me) return null;
    const pts: { lap: number; time: number }[] = [];
    for (const s of this.store.history()) {
      if (s.lap < 2 || s.neutralisation.status !== 'green') continue;
      const car = s.cars.find((c) => c.isPlayer)!;
      const pitted = s.events.some((e) => e.type === 'pit_stop' && e.driver === car.driver && e.lap === s.lap);
      const neutral = s.events.some(
        (e) => e.lap === s.lap && (e.type === 'sc_ending' || e.type === 'vsc_ending' || e.type === 'restart'),
      );
      if (!pitted && !neutral && car.lastLapTime !== null) pts.push({ lap: s.lap, time: car.lastLapTime });
    }
    const recent = pts.slice(-25);
    if (recent.length < 2) return null;
    const W = 320;
    const H = 120;
    const pad = { l: 58, r: 8, t: 10, b: 20 };
    const times = recent.map((p) => p.time);
    const lo = Math.floor(Math.min(...times) * 2) / 2;
    const hi = Math.max(lo + 1, Math.ceil(Math.max(...times) * 2) / 2);
    const firstLap = recent[0]!.lap;
    const lastLap = recent.at(-1)!.lap;
    const x = (lap: number) => pad.l + ((lap - firstLap) / Math.max(1, lastLap - firstLap)) * (W - pad.l - pad.r);
    const y = (t: number) => pad.t + (1 - (t - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const points: TracePoint[] = recent.map((p) => ({ ...p, x: x(p.lap), y: y(p.time) }));
    const stints = me.stints.filter((st) => st.startLap > firstLap).map((st) => ({ x: x(st.startLap - 0.5), c: st.compound }));
    return {
      W,
      H,
      points,
      path: points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      gridY: [lo, (lo + hi) / 2, hi].map((t) => ({ t, y: y(t) })),
      firstLap,
      lastLap,
      stints,
      bottom: H - pad.b,
      left: pad.l,
      right: W - pad.r,
    };
  });
  protected readonly hover = signal<TracePoint | null>(null);

  protected readonly results = computed(() => {
    const s = this.state();
    if (!s?.finished) return null;
    return s.cars.map((c) => ({ car: c, dsq: c.status === 'disqualified' }));
  });

  protected readonly myResult = computed(() => {
    const me = this.results()?.find((x) => x.car.isPlayer);
    if (!me) return null;
    return { ...me, gridPos: this.track()!.drivers.find((d) => d.code === me.car.driver)!.gridPosition };
  });

  async ngOnInit(): Promise<void> {
    await this.store.loadTrack();
    const grid = this.grid();
    this.setupDriver.set(grid[Math.floor(grid.length / 2)]?.code ?? '');
  }

  protected start(): void {
    this.store.start({
      seed: this.setupSeed(),
      difficulty: this.setupDifficulty(),
      playerDriver: this.setupDriver(),
      startCompound: this.setupCompound(),
    });
  }

  protected newSeed(): void {
    this.setupSeed.set(randomSeed());
  }

  protected box(c: Compound): void {
    this.store.command(this.me()?.pendingBox === c ? { type: 'cancel_box' } : { type: 'box', compound: c });
  }

  protected teamColour(car: CarState): string {
    return this.teams().get(car.teamId)?.colour ?? '#888';
  }

  protected teamName(id: string): string {
    return this.teams().get(id)?.name ?? id;
  }

  protected lapTime(t: number | null): string {
    if (t === null) return '—';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }

  protected gap(t: number, i: number): string {
    if (this.state()?.lap === 0) return '';
    return i === 0 ? 'Leader' : `+${t.toFixed(3)}`;
  }

  /** Whole-race time as h:mm:ss.sss. */
  protected raceTime(t: number): string {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  }

  protected window(from: number, to: number): string {
    return from === to ? `L${from}` : `L${from}–${to}`;
  }

  protected abs(n: number): number {
    return Math.abs(n);
  }
}

function randomSeed(): number {
  // UI-only randomness (the engine never calls Math.random).
  return Math.floor(Math.random() * 1_000_000);
}

function involves(e: RaceEvent, code: string | undefined): boolean {
  if (!code) return false;
  return ('driver' in e && e.driver === code) || ('passed' in e && e.passed === code) || ('winner' in e && e.winner === code);
}

function describe(e: RaceEvent): string {
  switch (e.type) {
    case 'race_start':
      return 'Lights out. Away we go.';
    case 'pit_stop':
      return `${e.driver} pits: ${COMPOUND_NAME[e.from]} → ${COMPOUND_NAME[e.to]} (${e.stationary.toFixed(1)} s${e.slow ? ', slow stop' : ''})`;
    case 'overtake':
      return `${e.driver} passes ${e.passed}`;
    case 'sc_deployed':
      return `Safety car deployed (${e.laps} laps)`;
    case 'vsc_deployed':
      return `Virtual safety car (${e.laps} laps)`;
    case 'sc_ending':
      return 'Safety car in this lap';
    case 'vsc_ending':
      return 'VSC ending';
    case 'red_flag':
      return 'RED FLAG. Free tyre change for everyone.';
    case 'restart':
      return 'Race restarts in order';
    case 'fastest_lap':
      return `Fastest lap: ${e.driver}, ${Math.floor(e.time / 60)}:${(e.time % 60).toFixed(3).padStart(6, '0')}`;
    case 'radio':
      return `📻 ${e.driver}: “${e.message}”`;
    case 'race_finish':
      return `Chequered flag. ${e.winner} wins.`;
  }
}
