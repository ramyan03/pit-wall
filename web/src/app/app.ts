import { Component, inject, signal } from '@angular/core';
import { CircuitPicker } from './circuit-picker';
import { Credits } from './credits';
import { DataService } from './data';
import { PreRace } from './pre-race';
import { RaceStore, type RaceSetup } from './race-store';
import { RaceView } from './race-view';

type Screen = 'circuits' | 'prerace' | 'race' | 'credits';

@Component({
  selector: 'app-root',
  imports: [CircuitPicker, PreRace, RaceView, Credits],
  template: `
    @switch (screen()) {
      @case ('circuits') {
        <app-circuit-picker (pick)="openTrack($event)" (credits)="screen.set('credits')" />
      }
      @case ('prerace') {
        @if (loading()) {
          <main class="loading">Loading {{ loading() }}…</main>
        } @else {
          <app-pre-race (back)="screen.set('circuits')" (go)="start($event)" />
        }
      }
      @case ('race') {
        <app-race-view (exit)="exitRace($event)" />
      }
      @case ('credits') {
        <app-credits (back)="screen.set('circuits')" />
      }
    }
  `,
})
export class App {
  private readonly data = inject(DataService);
  private readonly store = inject(RaceStore);
  protected readonly screen = signal<Screen>('circuits');
  protected readonly loading = signal<string | null>(null);

  protected async openTrack(id: string): Promise<void> {
    this.screen.set('prerace');
    this.loading.set(id);
    const [track, circuit, real] = await Promise.all([this.data.track(id), this.data.circuit(id), this.data.real(id)]);
    this.store.load(track, circuit, real);
    this.loading.set(null);
  }

  protected start(setup: RaceSetup): void {
    this.store.start(setup);
    this.screen.set('race');
  }

  protected exitRace(to: 'circuits' | 'prerace'): void {
    this.store.quit();
    this.screen.set(to);
  }
}
