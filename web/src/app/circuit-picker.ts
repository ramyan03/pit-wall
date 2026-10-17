import { NgTemplateOutlet } from '@angular/common';
import { afterNextRender, Component, computed, ElementRef, inject, Injector, input, OnInit, output, signal } from '@angular/core';
import { CircuitMap } from './circuit-map';
import { DataService, type Circuit, type TrackIndexEntry } from './data';

@Component({
  selector: 'app-circuit-picker',
  imports: [CircuitMap, NgTemplateOutlet],
  template: `
    <main class="picker">
      <header class="picker-head">
        <div>
          <h1>Pit Wall</h1>
          <p class="tagline">Pick a Grand Prix and call the strategy: the 2026 season, or redo a classic.</p>
        </div>
        <div class="picker-actions">
          <button class="ghost" (click)="home.emit()">← Home</button>
          <button class="ghost" (click)="credits.emit()">Credits & sources</button>
        </div>
      </header>
      @if (error()) {
        <p class="bad">{{ error() }}</p>
      }
      <h2 class="picker-section">2026 season</h2>
      <div class="circuit-grid">
        @for (t of season(); track t.trackId) {
          <ng-container *ngTemplateOutlet="card; context: { $implicit: t }" />
        }
      </div>
      @if (classics().length) {
        <h2 class="picker-section" id="classics">Classics <span class="muted small">· one strategy race per season, 2011–2025 · real safety cars and retirements</span></h2>
        <div class="circuit-grid">
          @for (t of classics(); track t.trackId) {
            <ng-container *ngTemplateOutlet="card; context: { $implicit: t }" />
          }
        </div>
      }

      <ng-template #card let-t>
          <button class="circuit-card" [class.classic]="t.classic" (click)="pick.emit(t.trackId)">
            <div class="cc-map">
              <app-circuit-map [circuit]="maps()[t.trackId] ?? null" [mini]="true" />
            </div>
            <div class="cc-body">
              @if (t.classic) {
                <div class="eyebrow">{{ t.season }} · Round {{ t.round }}</div>
              } @else {
                <div class="eyebrow">Round {{ t.round }} · {{ date(t.date) }}</div>
              }
              <div class="cc-name">{{ t.eventName }}</div>
              <div class="muted small">{{ t.circuitName }}, {{ t.country }}</div>
              <div class="cc-stats">
                <span>{{ t.laps }} laps</span>
                @if (t.lengthM) {
                  <span>{{ (t.lengthM / 1000).toFixed(3) }} km</span>
                }
                <span title="Typical track temperature (estimate)">🌡 {{ t.trackTempC }}°C</span>
              </div>
              <div class="cc-tyres">
                @for (c of compounds; track c) {
                  @if (t.allocation[c]; as a) {
                    <span class="tyre xs" [attr.data-c]="c">{{ c }}</span><span class="cnum">{{ a }}</span>
                  }
                }
                <span class="wear" [attr.data-level]="wearLevel(t.wear)">{{ wearLevel(t.wear) }} wear</span>
              </div>
              @if (t.blurb) {
                <div class="small cc-blurb">{{ t.blurb }}</div>
              }
              <div class="muted small">Won by {{ t.winner }}</div>
            </div>
          </button>
      </ng-template>
    </main>
  `,
})
export class CircuitPicker implements OnInit {
  private readonly data = inject(DataService);
  private readonly injector = inject(Injector);
  /** Which section to show first: Home's Classics buttons open the picker scrolled to it. */
  readonly section = input<'season' | 'classics'>('season');
  readonly pick = output<string>();
  readonly home = output<void>();
  readonly credits = output<void>();
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly tracks = signal<TrackIndexEntry[]>([]);
  protected readonly season = computed(() => this.tracks().filter((t) => !t.classic));
  protected readonly classics = computed(() => this.tracks().filter((t) => t.classic));
  protected readonly maps = signal<Record<string, Circuit>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly compounds = ['S', 'M', 'H'] as const;

  async ngOnInit(): Promise<void> {
    try {
      const idx = await this.data.index();
      this.tracks.set(idx);
      if (this.section() === 'classics') {
        afterNextRender(() => this.host.nativeElement.querySelector('#classics')?.scrollIntoView({ block: 'start' }), { injector: this.injector });
      }
      for (const t of idx) {
        this.data.circuit(t.trackId).then((c) => this.maps.update((m) => ({ ...m, [t.trackId]: c })));
      }
    } catch (e) {
      this.error.set(`Couldn't load tracks: ${e}`);
    }
  }

  protected date(iso: string): string {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected wearLevel(w: number): string {
    return w >= 1.2 ? 'High' : w <= 0.85 ? 'Low' : 'Medium';
  }
}
