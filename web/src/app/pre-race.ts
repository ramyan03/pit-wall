import { Component, computed, effect, inject, output, signal } from '@angular/core';
import type { Compound, Difficulty } from '@pit-wall/engine';
import { CircuitMap } from './circuit-map';
import { DataService } from './data';
import { RaceStore, type RaceSetup } from './race-store';
import { ENGINEERS } from './radio';
import type { HintResponse } from './strategy.worker';
import { compoundNames, compoundsOf } from './tyres';
import { practiceFor } from './visibility';

@Component({
  selector: 'app-pre-race',
  imports: [CircuitMap],
  templateUrl: './pre-race.html',
})
export class PreRace {
  protected readonly store = inject(RaceStore);
  protected readonly data = inject(DataService);
  readonly back = output<void>();
  readonly go = output<RaceSetup>();

  /** Nominated compounds and their era names (classics differ). */
  protected get compounds(): Compound[] {
    return compoundsOf(this.track());
  }
  protected get name(): Record<Compound, string> {
    return compoundNames(this.track());
  }
  protected readonly engineers = ENGINEERS;
  protected readonly difficulties: { id: Difficulty; blurb: string }[] = [
    { id: 'easy', blurb: 'No incidents. Wear shown. Strategist on.' },
    { id: 'normal', blurb: 'SC / VSC / red flags. Wear shown. Strategist on.' },
    { id: 'hard', blurb: 'Hidden wear, no strategist. Read practice + lap times.' },
  ];

  protected readonly track = this.store.track;
  protected readonly circuit = this.store.circuit;
  protected readonly real = this.store.real;

  protected readonly driver = signal('');
  protected readonly difficulty = signal<Difficulty>('normal');
  protected readonly startCompound = signal<Compound>('M');
  /** Classics: replay the real safety cars and retirements (on by default). */
  protected readonly realEvents = signal(true);
  protected readonly hasRealEvents = computed(() => !!this.track()?.realEvents);
  protected readonly seed = signal(Math.floor(Math.random() * 1_000_000)); // UI-only randomness

  protected readonly grid = computed(() => [...(this.track()?.drivers ?? [])].sort((a, b) => a.gridPosition - b.gridPosition));
  protected readonly teams = computed(() => new Map((this.track()?.teams ?? []).map((t) => [t.id, t])));
  protected readonly setup = computed<RaceSetup>(() => ({
    seed: this.seed(),
    difficulty: this.difficulty(),
    playerDriver: this.driver(),
    startCompound: this.startCompound(),
    realEvents: this.realEvents() && this.hasRealEvents(),
  }));
  protected readonly preview = computed(() => (this.driver() ? this.store.preview(this.setup()) : null));
  protected readonly selected = computed(() => this.track()?.drivers.find((d) => d.code === this.driver()) ?? null);

  protected readonly practice = computed(() => {
    const t = this.track();
    const p = this.preview();
    return t && p ? practiceFor(t, p) : null;
  });

  /** Small-multiples geometry for the long-run chart, one panel per compound. */
  protected readonly practiceChart = computed(() => {
    const p = this.practice();
    const fuel = this.track()?.fuel.fuelSecPerLap ?? 0;
    if (!p) return null;
    // Plot fuel-corrected times (as the caption says), so the slope is tyre wear.
    const runs = p.session.runs.map((r) => ({ ...r, laps: r.laps.map((t, i) => t + fuel * i) }));
    const all = runs.flatMap((r) => r.laps.filter((_, i) => !r.traffic[i]));
    const lo = Math.floor(Math.min(...all) * 2) / 2;
    const hi = Math.ceil(Math.max(...all) * 2) / 2;
    const W = 200;
    const H = 120;
    const pad = { l: 40, r: 6, t: 8, b: 18 };
    const maxLaps = Math.max(...runs.map((r) => r.laps.length));
    const x = (i: number) => pad.l + (i / Math.max(1, maxLaps - 1)) * (W - pad.l - pad.r);
    const y = (t: number) => pad.t + (1 - (Math.min(t, hi) - lo) / (hi - lo)) * (H - pad.t - pad.b);
    return {
      W,
      H,
      lo,
      hi,
      yLo: y(lo),
      yHi: y(hi),
      left: pad.l,
      right: W - pad.r,
      bottom: H - pad.b,
      maxLaps,
      panels: this.compounds.map((c) => ({
        c,
        est: p.estimate[c],
        runs: runs
          .filter((r) => r.compound === c)
          .map((r) => ({
            driver: r.driver,
            d: r.laps.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(' '),
            pts: r.laps.map((t, i) => ({ x: x(i), y: y(t), traffic: r.traffic[i], t, lap: i + 1 })),
          })),
      })),
    };
  });
  protected readonly hover = signal<{ c: Compound; driver: string; lap: number; t: number; traffic: boolean } | null>(null);

  protected readonly recommendation = signal<HintResponse | null>(null);
  protected readonly recommending = signal(false);

  constructor() {
    // Default driver: mid-grid.
    effect(() => {
      const g = this.grid();
      if (g.length && !this.driver()) this.driver.set(g[Math.floor(g.length / 2)]!.code);
    });
    // Two-compound classics have no Medium: start on the softer nominated tyre.
    effect(() => {
      const avail = compoundsOf(this.track());
      if (!avail.includes(this.startCompound())) this.startCompound.set(avail[0]!);
    });
    // Strategy sims become stale when the setup changes.
    effect(() => {
      this.setup();
      this.recommendation.set(null);
    });
  }

  protected async runRecommend(): Promise<void> {
    const p = this.preview();
    if (!p || this.difficulty() === 'hard') return;
    this.recommending.set(true);
    const r = await this.store.recommend(p);
    this.recommending.set(false);
    this.recommendation.set(r);
  }

  protected planText(start: Compound | null, stops: { lap: number; compound: Compound }[]): string {
    const name = this.name;
    return [name[start ?? 'M'], ...stops.map((s) => `L${s.lap} ${name[s.compound]}`)].join(' → ');
  }

  protected expectedIncidents(): string {
    const t = this.track();
    if (!t) return '';
    if (this.setup().realEvents && t.realEvents) {
      const inc = t.realEvents.incidents;
      const label = { sc: 'Safety car', vsc: 'VSC', red: 'Red flag' };
      const out = t.realEvents.retirements.length;
      const what = inc.length ? inc.map((x) => `${label[x.type]} L${x.lap}`).join(', ') : 'No safety cars';
      return `Real race: ${what}. ${out} retirement${out === 1 ? '' : 's'}.`;
    }
    const sc = t.incidents.scHazardPerLap * t.meta.laps;
    const p = 1 - Math.pow(1 - t.incidents.scHazardPerLap, t.meta.laps - 2);
    return `${Math.round(p * 100)}% chance of a safety car (≈${sc.toFixed(1)} per race)`;
  }

  protected realPos(code: string): number | null {
    return this.real()?.results.find((r) => r.code === code)?.position ?? null;
  }

  protected surname(full: string): string {
    return full.split(' ').slice(1).join(' ') || full;
  }

  protected newSeed(): void {
    this.seed.set(Math.floor(Math.random() * 1_000_000));
  }
}
