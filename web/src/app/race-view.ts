import { Component, computed, inject, output, signal } from '@angular/core';
import type { Compound, ErsMode, PaceMode, TeamOrder } from '@pit-wall/engine';
import { CircuitMap, type MapDot } from './circuit-map';
import { DataService } from './data';
import { MAX_SPEED, MIN_SPEED, RaceStore, type LiveCar, type Speed } from './race-store';
import { ENGINEERS } from './radio';
import { compoundNames, compoundsOf } from './tyres';
import { wearReadout } from './visibility';

interface Bar {
  lap: number;
  time: number;
  compound: Compound;
  kind: 'green' | 'neutral' | 'pit';
  x: number;
  y: number;
  h: number;
}

@Component({
  selector: 'app-race-view',
  imports: [CircuitMap],
  templateUrl: './race-view.html',
})
export class RaceView {
  protected readonly store = inject(RaceStore);
  protected readonly data = inject(DataService);
  readonly exit = output<'circuits' | 'prerace'>();

  /** Nominated compounds and their era names (classics differ). */
  protected get compounds(): Compound[] {
    return compoundsOf(this.track());
  }
  protected get name(): Record<Compound, string> {
    return compoundNames(this.track());
  }
  protected readonly paceModes: PaceMode[] = ['push', 'neutral', 'conserve'];
  protected readonly ersModes: { mode: ErsMode; label: string; title: string }[] = [
    { mode: 'attack', label: 'Attack', title: 'Spend charge: quicker and better at passing' },
    { mode: 'defend', label: 'Defend', title: 'Spend charge: harder to pass' },
    { mode: 'neutral', label: 'Neutral', title: 'Slow trickle charge' },
    { mode: 'harvest', label: 'Harvest', title: 'Slower lap, recharges the battery' },
  ];
  protected readonly pushLaps = [3, 5, 10];
  protected readonly teamOrders: { order: TeamOrder; label: string }[] = [
    { order: 'none', label: 'Race' },
    { order: 'hold_up', label: 'Hold up rival' },
    { order: 'let_by', label: 'Let me by' },
  ];

  /** Share of the radio decision's time left, 0–1 (drives the countdown bar). */
  protected readonly decisionLeft = computed(() => {
    const d = this.store.decision();
    if (!d) return 0;
    return Math.max(0, Math.min(1, (d.expiresT - this.store.simTime()) / (d.expiresT - d.t)));
  });

  /** Slider position 0–1 ↔ speed MIN_SPEED–MAX_SPEED on a log scale. */
  protected sliderValue(speed: Speed): number {
    const s = speed > 0 ? speed : this.store.speed() || 1;
    return Math.log(s / MIN_SPEED) / Math.log(MAX_SPEED / MIN_SPEED);
  }
  protected onSlider(v: string): void {
    const raw = MIN_SPEED * Math.pow(MAX_SPEED / MIN_SPEED, Number(v));
    // Snap to the nice values the label shows.
    const snapped = raw < 1 ? Math.round(raw * 4) / 4 : raw < 10 ? Math.round(raw * 2) / 2 : Math.round(raw);
    this.store.setSpeed(snapped);
  }
  protected readonly showGap = signal(false);

  protected readonly track = this.store.track;
  protected readonly live = this.store.live;
  protected readonly me = this.store.me;
  protected readonly teams = computed(() => new Map((this.track()?.teams ?? []).map((t) => [t.id, t])));
  protected readonly drivers = computed(() => new Map((this.track()?.drivers ?? []).map((d) => [d.code, d])));
  protected readonly engineer = computed(() => {
    const me = this.me();
    return me ? (ENGINEERS[me.teamId] ?? 'Race engineer') : '';
  });

  /** Compound the BOX button will fit. Defaults to one that satisfies the two-compound rule. */
  private readonly chosen = signal<Compound | null>(null);
  protected readonly boxCompound = computed<Compound>(() => {
    const c = this.chosen();
    if (c) return c;
    const me = this.me()?.car;
    if (!me) return 'H';
    return this.store.suggestedCompound();
  });
  protected choose(c: Compound): void {
    this.chosen.set(c);
  }

  protected readonly dots = computed<MapDot[]>(() => {
    const live = this.live();
    const me = this.me();
    return live.filter((c) => !c.retired).map((c) => ({
      code: c.code,
      colour: this.teams().get(c.teamId)?.colour ?? '#999',
      fraction: c.lapFraction,
      player: c.isPlayer,
      label: c.isPlayer || c.position === 1 || (!!me && Math.abs(c.position - me.position) === 1),
      pit: c.inPitLap,
    }));
  });

  protected readonly neighbours = computed(() => {
    const live = this.live();
    const me = this.me();
    if (!me) return { ahead: null, behind: null };
    const behind = live[me.position];
    return { ahead: live[me.position - 2] ?? null, behind: behind && !behind.retired ? behind : null };
  });

  protected readonly wear = computed(() => {
    const t = this.track();
    const me = this.me();
    const s0 = this.store.history()[0];
    return t && me && s0 ? wearReadout(t, s0, me.car) : null;
  });

  protected readonly twoCompound = computed(() => {
    const me = this.me()?.car;
    if (!me) return { ok: false, pending: false };
    const pend = this.store.pendingBox();
    const used = new Set([...me.compoundsUsed, ...(pend ? [pend.compound] : [])]);
    return { ok: me.compoundsUsed.length >= 2, pending: used.size >= 2 && me.compoundsUsed.length < 2 };
  });

  /** Player lap-time bars, one per completed lap. */
  protected readonly bars = computed(() => {
    const hist = this.store.history();
    const me = this.me();
    if (!me || me.completedLaps < 1) return null;
    const raw: Omit<Bar, 'x' | 'y' | 'h'>[] = [];
    for (let L = 1; L <= me.completedLaps; L++) {
      const prev = hist[L - 1]!.cars.find((c) => c.isPlayer)!;
      const cur = hist[L]!.cars.find((c) => c.isPlayer)!;
      const neutral = hist[L - 1]!.neutralisation.status !== 'green' || hist[L]!.events.some((e) => e.lap === L && /deployed|red_flag/.test(e.type));
      raw.push({ lap: L, time: cur.lastLapTime!, compound: prev.compound, kind: cur.pitStops > prev.pitStops ? 'pit' : neutral || L === 1 ? 'neutral' : 'green' });
    }
    const greens = raw.filter((r) => r.kind === 'green').map((r) => r.time);
    const floor = greens.length ? Math.floor((Math.min(...greens) - 0.5) * 2) / 2 : Math.min(...raw.map((r) => r.time)) - 0.5;
    const ceil = floor + 4;
    const W = 340;
    const H = 110;
    const pad = { l: 34, r: 4, t: 6, b: 16 };
    const total = this.store.history()[0]!.totalLaps;
    const bw = (W - pad.l - pad.r) / total;
    const y = (t: number) => pad.t + (1 - (Math.min(t, ceil) - floor) / (ceil - floor)) * (H - pad.t - pad.b);
    const bars: Bar[] = raw.map((r) => ({ ...r, x: pad.l + (r.lap - 1) * bw, y: y(r.time), h: H - pad.b - y(r.time) }));
    return { W, H, bars, bw: Math.max(1, bw - 1), floor, ceil, yFloor: y(floor), yCeil: y(ceil), left: pad.l, right: W - pad.r, bottom: H - pad.b, total };
  });
  protected readonly hoverBar = signal<Bar | null>(null);

  protected readonly radio = computed(() => {
    const T = this.store.simTime();
    return this.store
      .radio()
      .filter((r) => r.t <= T)
      .slice(-30)
      .reverse();
  });

  protected readonly results = computed(() => {
    if (!this.store.showResults()) return null;
    const end = this.store.history().at(-1)!;
    const real = this.store.real();
    return end.cars.map((c) => ({
      car: c,
      real: real?.results.find((r) => r.code === c.driver) ?? null,
      grid: this.drivers().get(c.driver)!.gridPosition,
    }));
  });
  protected readonly myResult = computed(() => this.results()?.find((r) => r.car.isPlayer) ?? null);

  protected speedLabel(s: Speed): string {
    if (s <= 0) return 'Paused';
    const frac: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
    return `${frac[s] ?? (Number.isInteger(s) ? s : s.toFixed(1))}×`;
  }

  protected lapTime(t: number | null | undefined): string {
    if (t === null || t === undefined) return '';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
  }

  protected raceTime(t: number): string {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`;
  }

  protected gapText(c: LiveCar): string {
    if (c.car.status === 'disqualified' && c.finished) return 'DSQ';
    if (c.retired) return 'OUT';
    const v = this.showGap() ? c.gap : c.interval;
    if (c.position === 1) return this.showGap() ? 'Leader' : 'Interval';
    return v === null ? '' : `+${v.toFixed(3)}`;
  }

  protected surname(code: string): string {
    const n = this.drivers().get(code)?.fullName ?? code;
    return n.split(' ').slice(1).join(' ') || n;
  }

  protected fullName(code: string): string {
    return this.drivers().get(code)?.fullName ?? code;
  }

  protected colour(teamId: string): string {
    return this.teams().get(teamId)?.colour ?? '#888';
  }

  protected restart(): void {
    const s0 = this.store.history()[0]!;
    this.store.start({
      seed: s0.config.seed,
      difficulty: s0.config.difficulty,
      playerDriver: s0.config.playerDriver,
      startCompound: s0.config.playerStrategy.startCompound,
      realEvents: !!s0.config.realEvents,
    });
  }
}
