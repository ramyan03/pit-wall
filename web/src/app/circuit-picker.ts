import { Component, inject, OnInit, output, signal } from '@angular/core';
import { CircuitMap } from './circuit-map';
import { DataService, type Circuit, type TrackIndexEntry } from './data';

@Component({
  selector: 'app-circuit-picker',
  imports: [CircuitMap],
  template: `
    <main class="picker">
      <header class="picker-head">
        <div>
          <h1>Pit Wall</h1>
          <p class="tagline">2026 season · pick a Grand Prix and call the strategy.</p>
        </div>
        <button class="ghost" (click)="credits.emit()">Credits & sources</button>
      </header>
      @if (error()) {
        <p class="bad">{{ error() }}</p>
      }
      <div class="circuit-grid">
        @for (t of tracks(); track t.trackId) {
          <button class="circuit-card" (click)="pick.emit(t.trackId)">
            <div class="cc-map">
              <app-circuit-map [circuit]="maps()[t.trackId] ?? null" [mini]="true" />
            </div>
            <div class="cc-body">
              <div class="eyebrow">Round {{ t.round }} · {{ date(t.date) }}</div>
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
                  <span class="tyre xs" [attr.data-c]="c">{{ c }}</span><span class="cnum">{{ t.allocation[c] }}</span>
                }
                <span class="wear" [attr.data-level]="wearLevel(t.wear)">{{ wearLevel(t.wear) }} wear</span>
              </div>
              <div class="muted small">Won by {{ t.winner }}</div>
            </div>
          </button>
        }
      </div>
    </main>
  `,
})
export class CircuitPicker implements OnInit {
  private readonly data = inject(DataService);
  readonly pick = output<string>();
  readonly credits = output<void>();
  protected readonly tracks = signal<TrackIndexEntry[]>([]);
  protected readonly maps = signal<Record<string, Circuit>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly compounds = ['S', 'M', 'H'] as const;

  async ngOnInit(): Promise<void> {
    try {
      const idx = await this.data.index();
      this.tracks.set(idx);
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
