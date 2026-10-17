import { Component, inject, signal } from '@angular/core';
import { CircuitPicker } from './circuit-picker';
import { Credits } from './credits';
import { DataService } from './data';
import { Home } from './home';
import { PreRace } from './pre-race';
import { RaceStore, type RaceSetup } from './race-store';
import { RaceView } from './race-view';
import { StartLights } from './start-lights';
import { Startup } from './startup';
import { Tutorial } from './tutorial';

type Screen = 'startup' | 'home' | 'tutorial' | 'circuits' | 'prerace' | 'race' | 'credits';

@Component({
  selector: 'app-root',
  imports: [Startup, Home, Tutorial, CircuitPicker, PreRace, RaceView, Credits, StartLights],
  template: `
    @switch (screen()) {
      @case ('startup') {
        <app-startup (start)="go('home')" (help)="go('tutorial')" />
      }
      @case ('home') {
        <app-home
          (season)="openPicker('season')"
          (classics)="openPicker('classics')"
          (tutorial)="go('tutorial')"
          (credits)="go('credits')"
          (openTrack)="openTrack($event)"
        />
      }
      @case ('tutorial') {
        <app-tutorial (exit)="go('home')" (goRacing)="openPicker('season')" />
      }
      @case ('circuits') {
        <app-circuit-picker [section]="pickerSection()" (pick)="openTrack($event)" (home)="go('home')" (credits)="go('credits')" />
      }
      @case ('prerace') {
        @if (loading()) {
          <main class="loading">Loading {{ loading() }}…</main>
        } @else {
          <app-pre-race (back)="go('circuits')" (go)="start($event)" />
        }
      }
      @case ('race') {
        <app-race-view (exit)="exitRace($event)" />
      }
      @case ('credits') {
        <app-credits (back)="go('home')" />
      }
    }
    @if (lights()) {
      <app-start-lights (done)="lightsOut()" />
    }
  `,
})
export class App {
  private readonly data = inject(DataService);
  private readonly store = inject(RaceStore);
  protected readonly screen = signal<Screen>('startup');
  protected readonly loading = signal<string | null>(null);
  protected readonly pickerSection = signal<'season' | 'classics'>('season');
  /** The start-lights loading screen plays over every page change. */
  protected readonly lights = signal(false);
  private afterLights: (() => void) | null = null;

  /** Change page behind the start lights; `then` runs when the lights go out. */
  protected go(to: Screen, then?: () => void): void {
    this.afterLights = then ?? null;
    this.lights.set(true);
    this.screen.set(to);
  }

  protected lightsOut(): void {
    this.lights.set(false);
    const then = this.afterLights;
    this.afterLights = null;
    then?.();
  }

  protected openPicker(section: 'season' | 'classics'): void {
    this.pickerSection.set(section);
    this.go('circuits');
  }

  protected async openTrack(id: string): Promise<void> {
    this.go('prerace');
    this.loading.set(id);
    const [track, circuit, real] = await Promise.all([this.data.track(id), this.data.circuit(id), this.data.real(id)]);
    this.store.load(track, circuit, real);
    this.loading.set(null);
  }

  protected start(setup: RaceSetup): void {
    // The race clock starts when the lights go out.
    this.go('race', () => this.store.start(setup));
  }

  protected exitRace(to: 'circuits' | 'prerace'): void {
    this.store.quit();
    this.go(to);
  }
}
