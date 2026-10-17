import { Component, output } from '@angular/core';

type Compound = 'S' | 'M' | 'H';

/** Home: the two big buttons, the three modes, a featured classic and the difficulty levels. */
@Component({
  selector: 'app-home',
  template: `
    <div class="home">
      <header class="home-head">
        <div class="home-brand"><span class="brand-bar"></span><span class="wordmark">PIT WALL</span></div>
        <nav class="home-nav" aria-label="Main">
          <button class="nav-link on" (click)="season.emit()">Play</button>
          <button class="nav-link" (click)="season.emit()">2026 season</button>
          <button class="nav-link" (click)="classics.emit()">Classics</button>
          <button class="nav-link" (click)="tutorial.emit()">Tutorial</button>
          <button class="nav-link" (click)="credits.emit()">Credits</button>
        </nav>
        <span class="chip-private">Private build</span>
      </header>

      <main class="home-main">
        <section class="home-hero">
          <div class="hero-actions">
            <button class="hero-btn primary-hero" (click)="season.emit()">Quick race</button>
            <button class="hero-btn ghost-hero" (click)="tutorial.emit()">
              Learn in 5 laps
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
            </button>
          </div>

          <div class="demo-tower" role="img" aria-label="Example of the live timing screen">
            <div class="demo-head">
              <span>Singapore · L34 / 62</span>
              <span class="demo-flag"><span class="dot"></span>Green flag</span>
            </div>
            @for (r of tower; track r.code) {
              <div class="demo-row" [class.me]="r.me">
                <span class="num muted">{{ r.pos }}</span>
                <span class="teambar" [style.background]="r.team"></span>
                <span class="code">{{ r.code }}</span>
                <span class="num muted">{{ r.gap }}</span>
                <span class="demo-tyre"><span class="tyre sm" [attr.data-c]="r.tyre">{{ r.tyre }}</span><span class="age">{{ r.age }}</span></span>
              </div>
            }
            <div class="demo-radio">
              <span class="tag">RADIO</span>
              <span>Hamilton is still out on 31-lap mediums. Looks like he's going long, one stop. Undercut is on if we want it.</span>
            </div>
          </div>
        </section>

        <section class="mode-cards">
          <div class="mode-card">
            <div class="eyebrow">Season</div>
            <h2>2026 season</h2>
            <p>17 completed rounds with real grids, 22 cars and the new Cadillac team. Pick a circuit and a driver.</p>
            <button class="mode-btn" (click)="season.emit()">Pick a circuit</button>
          </div>
          <div class="mode-card">
            <div class="eyebrow">2011 – 2025</div>
            <h2>Classics</h2>
            <p>One race per season that strategy decided. Safety cars and retirements happen when they really did.</p>
            <button class="mode-btn" (click)="classics.emit()">Browse 15 classics</button>
          </div>
          <div class="mode-card accent">
            <div class="eyebrow">Start here</div>
            <h2>Tutorial</h2>
            <p>A 5-lap mini race. One skill a lap: the timing tower, tyre wear, a radio call, a pit stop and the battery.</p>
            <button class="mode-btn red" (click)="tutorial.emit()">Start the tutorial</button>
          </div>
        </section>

        <section class="home-bottom">
          <div class="featured">
            <div class="featured-text">
              <div class="eyebrow">Featured classic · 2015 · Round 2</div>
              <h2>Malaysian Grand Prix</h2>
              <p>Mercedes pit under the early safety car. Vettel stays out and makes two stops beat three. Do you stay out?</p>
              <div class="featured-facts">
                <span>Sepang · 56 laps</span>
                <span><span class="tyre xs" data-c="S"></span> Medium</span>
                <span><span class="tyre xs" data-c="H"></span> Hard</span>
                <span>SC lap 4</span>
              </div>
            </div>
            <button class="mode-btn ghost" (click)="openTrack.emit('2015-malaysian')">Redo this race</button>
          </div>
          <div class="difficulty-card">
            <div class="eyebrow">Difficulty</div>
            <dl>
              <dt>Easy</dt><dd>No incidents. Wear shown. Strategist on.</dd>
              <dt>Normal</dt><dd>Safety cars and red flags. Wear shown.</dd>
              <dt>Hard</dt><dd>Wear is never shown. Read it from lap times.</dd>
            </dl>
          </div>
        </section>
      </main>

      <footer class="home-foot">
        <span>Data: Jolpica (Ergast API) · circuit outlines: bacinger/f1-circuits (MIT) · photos: Wikimedia Commons</span>
        <span>Unofficial fan project · private use only</span>
      </footer>
    </div>
  `,
})
export class Home {
  readonly season = output<void>();
  readonly classics = output<void>();
  readonly tutorial = output<void>();
  readonly credits = output<void>();
  readonly openTrack = output<string>();

  protected readonly tower: { pos: number; code: string; team: string; gap: string; tyre: Compound; age: number; me?: boolean }[] = [
    { pos: 1, code: 'RUS', team: '#27F4D2', gap: 'Interval', tyre: 'H', age: 14 },
    { pos: 2, code: 'VER', team: '#3671C6', gap: '+2.418', tyre: 'H', age: 15 },
    { pos: 3, code: 'NOR', team: '#FF8000', gap: '+1.106', tyre: 'H', age: 13 },
    { pos: 4, code: 'HAM', team: '#E8002D', gap: '+3.874', tyre: 'M', age: 31 },
    { pos: 5, code: 'PIA', team: '#FF8000', gap: '+0.912', tyre: 'H', age: 13, me: true },
    { pos: 6, code: 'LEC', team: '#E8002D', gap: '+4.330', tyre: 'H', age: 16 },
  ];
}
