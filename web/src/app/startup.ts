import { Component, output, signal } from '@angular/core';
import { StartLights } from './start-lights';

/** First screen: the wordmark, the (unlit) start gantry and Start the session. */
@Component({
  selector: 'app-startup',
  imports: [StartLights],
  template: `
    <main class="startup">
      <div class="startup-bar"></div>
      <div class="startup-body">
        <h1 class="wordmark xl">PIT WALL</h1>
        <app-start-lights [overlay]="false" />
        <div class="startup-actions">
          <button class="session-btn" (click)="start.emit()">Start the session</button>
          <div class="startup-small">
            <button class="small-btn" disabled title="Coming soon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>
              Settings
            </button>
            <button class="small-btn" (click)="help.emit()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
              Help
            </button>
            <button class="small-btn" (click)="exit()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
              Exit
            </button>
          </div>
          @if (exitNote()) {
            <p class="muted small">The browser only lets a page close tabs it opened. Close this tab to exit.</p>
          }
        </div>
      </div>
    </main>
  `,
})
export class Startup {
  readonly start = output<void>();
  readonly help = output<void>();
  protected readonly exitNote = signal(false);

  protected exit(): void {
    window.close();
    // Still here: this tab wasn't opened by script, so the browser refused.
    setTimeout(() => this.exitNote.set(true), 150);
  }
}
