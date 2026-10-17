import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';

/** Milliseconds between lights; all five hold for one more step plus a beat before going out. */
const STEP_MS = 420;

/**
 * The loading screen between pages: five red lights come on one at a time, hold, then go out.
 * With `overlay` false it's the static, unlit gantry on the startup screen.
 */
@Component({
  selector: 'app-start-lights',
  template: `
    <div class="gantry" [class.big]="!overlay()" aria-hidden="true">
      @for (i of pods; track i) {
        <div class="pod">
          <span class="lamp"></span>
          <span class="lamp" [class.on]="i < lit()"></span>
        </div>
      }
    </div>
  `,
  host: {
    '[class.lights-overlay]': 'overlay()',
    role: 'status',
    '[attr.aria-label]': 'overlay() ? "Loading" : null',
  },
})
export class StartLights implements OnInit {
  /** Run the sequence as a full-screen overlay and emit `done` when the lights go out. */
  readonly overlay = input(true);
  readonly done = output<void>();

  protected readonly pods = [0, 1, 2, 3, 4];
  protected readonly lit = signal(0);
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timers.forEach(clearTimeout));
  }

  ngOnInit(): void {
    if (!this.overlay()) return;
    for (let i = 1; i <= 5; i++) this.timers.push(setTimeout(() => this.lit.set(i), i * STEP_MS));
    this.timers.push(setTimeout(() => this.lit.set(0), 6 * STEP_MS + 250));
    this.timers.push(setTimeout(() => this.done.emit(), 6 * STEP_MS + 450));
  }
}
