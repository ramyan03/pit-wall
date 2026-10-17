import { Component, computed, inject, output } from '@angular/core';
import { DataService } from './data';

@Component({
  selector: 'app-credits',
  template: `
    <main class="credits">
      <header class="prerace-head">
        <button class="ghost" (click)="back.emit()">← Back</button>
        <h1>Credits & sources</h1>
      </header>
      <section class="card">
        <h2>Data</h2>
        <ul class="sources">
          <li>Results, grid, lap times and pit stops: <a href="https://jolpi.ca" target="_blank" rel="noopener">Jolpica</a> (Ergast-compatible F1 API).</li>
          <li>Circuit outlines: <a href="https://github.com/bacinger/f1-circuits" target="_blank" rel="noopener">bacinger/f1-circuits</a>, MIT licence, © Tomislav Bacinger.</li>
          <li>Tyre wear, temperatures, sector splits and incident rates are <strong>manual estimates</strong>, not fitted data, until the FastF1 pipeline can reach F1 live timing.</li>
          <li>Classics (2011–2025): safety-car and VSC laps come from contemporary race reports; retirements from Jolpica. Era tyre models are estimates.</li>
          <li>Race engineers and their radio lines are fictional.</li>
          <li>Unofficial fan project. Not associated with Formula 1, the FIA or any team. Names, logos and marks belong to their owners. Private use only.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Driver photos (Wikimedia Commons)</h2>
        <ul class="credit-list">
          @for (c of drivers(); track c.key) {
            <li>
              <img [src]="c.path" alt="" class="face sm" loading="lazy" />
              <div>
                <strong>{{ c.key }}</strong> · <a [href]="c.pageUrl" target="_blank" rel="noopener">{{ c.file }}</a><br />
                <span class="muted small">by {{ c.author }} · {{ c.license }}</span>
              </div>
            </li>
          }
        </ul>
      </section>
      <section class="card">
        <h2>Team logos (Wikimedia Commons)</h2>
        <ul class="credit-list">
          @for (c of teams(); track c.key) {
            <li>
              <img [src]="c.path" alt="" class="logo" loading="lazy" />
              <div>
                <strong>{{ c.key }}</strong> · <a [href]="c.pageUrl" target="_blank" rel="noopener">{{ c.file }}</a><br />
                <span class="muted small">by {{ c.author }} · {{ c.license }}</span>
              </div>
            </li>
          }
        </ul>
        <p class="muted small">Teams without a freely licensed logo on Commons are shown as colour monograms.</p>
      </section>
    </main>
  `,
})
export class Credits {
  private readonly data = inject(DataService);
  readonly back = output<void>();
  protected readonly drivers = computed(() => Object.entries(this.data.credits().drivers).map(([key, v]) => ({ key, ...v })));
  protected readonly teams = computed(() => Object.entries(this.data.credits().teams).map(([key, v]) => ({ key, ...v })));
}
