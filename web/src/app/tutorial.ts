import { Component, computed, input, output, signal } from '@angular/core';

type Compound = 'S' | 'M' | 'H';
type Choice = 'box' | 'push' | 'stay';
type Ers = 'attack' | 'defend' | 'harvest';
/** The one region that stays lit; everything else fades. */
type Focus = 'none' | 'tower' | 'laps' | 'radio' | 'box' | 'ers';

interface Row {
  pos: number;
  code: string;
  int: string;
  last: string;
  tyre: Compound;
  age: number;
  pit: boolean;
  me: boolean;
}

const TEAM: Record<string, string> = {
  VER: '#3671C6', NOR: '#FF8000', LEC: '#E8002D', YOU: '#ECEFF2', RUS: '#27F4D2', HAM: '#E8002D', ALO: '#229971', SAI: '#64C4FF',
};
type Cell = [int: string, last: string, tyre: Compound, age: number];
const BASE: Record<string, Cell> = {
  VER: ['Interval', '1:32.05', 'M', 16], NOR: ['+1.214', '1:32.18', 'M', 16], LEC: ['+2.402', '1:32.36', 'M', 16],
  YOU: ['+1.811', '1:32.41', 'M', 16], RUS: ['+0.904', '1:32.30', 'M', 15], HAM: ['+3.127', '1:32.62', 'H', 20],
  ALO: ['+1.436', '1:32.70', 'H', 22], SAI: ['+2.215', '1:32.88', 'M', 17],
};
const LAP_TIMES = [92.41, 92.55, 92.68, 92.97, 93.21];
const OPTIONS: { id: Choice; label: string; est: string }[] = [
  { id: 'box', label: 'Box this lap for Hards', est: 'exp. P3.9' },
  { id: 'push', label: 'Stay out, push 3 laps (overcut)', est: 'exp. P4.6' },
  { id: 'stay', label: 'Stick to the plan', est: 'exp. P5.0' },
];
const REPLIES: Record<Choice, string> = {
  box: "Copy, boxing. We'll come out ahead of Russell.",
  push: "Pushing. Careful, fresh tyres are worth a second a lap. We'll need to box next lap.",
  stay: 'Staying out. Russell will jump us, so we box next lap.',
};

/**
 * A scripted 5-lap mini race, one skill a lap: the tower, tyre wear, a radio call, a pit stop and
 * the battery. Everything but the thing to use fades; the engineer says what to do at the bottom.
 * Scripted (no engine), so it plays the same every time.
 */
@Component({
  selector: 'app-tutorial',
  template: `
    <div class="tut" [style.--dim]="dim()">
      <header class="tut-head" [class.dim-head]="step() > 0 && step() < 6">
        <div class="tut-head-left">
          <button class="ghost-btn" (click)="exit.emit()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg>
            Home
          </button>
          <span class="tut-title">Tutorial</span>
        </div>
        <div class="tut-flag" [class.cheq]="step() === 6">{{ step() === 6 ? 'Chequered flag' : 'Green flag' }}</div>
        <div class="tut-lap">L{{ lapShown() }} <span>/ 5</span></div>
      </header>

      <div class="tut-grid">
        <section class="tut-card tut-tower" aria-label="Timing tower" [class.lit]="focus() === 'tower'" [class.faded]="isFaded('tower')">
          <div class="tut-tower-head">
            <span class="r">P</span><span></span><span>Driver</span><span class="r" [class.hi]="step() === 1">Int</span><span class="r">Last lap</span><span class="r">Tyre</span>
          </div>
          @for (r of rows(); track r.code) {
            <div class="tut-row" [class.me]="r.me">
              <span class="r muted">{{ r.pos }}</span>
              <span class="teambar" [style.background]="team[r.code]"></span>
              <span class="code">{{ r.code }}@if (r.pit) {<span class="pit-tag">PIT</span>}</span>
              <span class="r int" [class.ring]="step() === 1 && r.me">{{ r.pos === 1 ? 'Interval' : r.int }}</span>
              <span class="r last">{{ r.last }}</span>
              <span class="r tyre-cell"><span class="tyre sm" [attr.data-c]="r.tyre">{{ r.tyre }}</span><span class="age">{{ r.age }}</span></span>
            </div>
          }
        </section>

        <section class="tut-centre">
          <div class="tut-card tut-laps" [class.lit]="focus() === 'laps'" [class.faded]="isFaded('laps')">
            <span class="eyebrow">Your lap times</span>
            <div class="tut-bars" role="img" aria-label="Your last five lap times, rising from 1:32.41 to 1:33.21">
              @for (b of bars; track $index) {
                <div class="tut-bar"><span>{{ b.label }}</span><div [style.height.px]="b.h"></div></div>
              }
            </div>
          </div>

          <div class="tut-card tut-radio" [class.lit]="focus() === 'radio'" [class.faded]="isFaded('radio')">
            @if (step() === 3) {
              <div class="tut-radio-q"><span class="tag">RADIO</span><span>Russell has boxed behind us. Cover?</span></div>
              @for (o of options; track o.id) {
                <button class="tut-opt" [class.chosen]="choice() === o.id" [class.other]="!!choice() && choice() !== o.id" (click)="pick(o.id)">
                  <span>{{ o.label }}</span><span class="est">{{ o.est }}</span>
                </button>
              }
            } @else if (step() === 6) {
              <div class="tut-finish">
                <span class="tut-pos">P{{ finish() }}</span>
                <ul>
                  @for (s of skills; track s) {
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>{{ s }}</li>
                  }
                </ul>
              </div>
            }
          </div>
        </section>

        <section class="tut-controls" aria-label="Controls">
          <div class="tut-card tut-ctl" [class.lit]="focus() === 'box'" [class.faded]="isFaded('box')">
            <button class="tut-box" [class.armed]="boxActive()" [disabled]="!boxActive()" (click)="box()">{{ covered() || boxed() ? 'BOXED' : 'BOX THIS LAP' }}</button>
            <div class="tut-tyres">
              <span><span class="tyre sm" data-c="S"></span></span>
              <span><span class="tyre sm" data-c="M"></span></span>
              <span class="sel"><span class="tyre sm" data-c="H"></span></span>
            </div>
          </div>
          <div class="tut-card tut-ctl" [class.faded]="isFaded('pace')">
            <span class="eyebrow">Pace</span>
            <div class="tut-seg"><span>Push</span><span class="on">Neutral</span><span>Conserve</span></div>
          </div>
          <div class="tut-card tut-ctl" [class.lit]="focus() === 'ers'" [class.faded]="isFaded('ers')">
            <span class="eyebrow">Battery</span>
            <div class="battery" [class.low]="battery() < 40">
              <div class="battery-fill" [style.width.%]="battery()"></div>
              <span>{{ battery() }}%</span>
            </div>
            <div class="tut-ers">
              @for (m of ersModes; track m.id) {
                <button [attr.data-ers]="m.id" [class.on]="ers() === m.id" [disabled]="step() !== 5 || !!ers()" (click)="setErs(m.id)">{{ m.label }}</button>
              }
            </div>
          </div>
        </section>
      </div>

      <footer class="tut-engineer" aria-label="Race engineer" aria-live="polite">
        <div class="eng-face" aria-hidden="true">SA</div>
        <div class="eng-text">
          <div class="eng-who">
            <strong>Sam Ashworth</strong><span class="eyebrow">Race engineer</span>
            <span class="eng-progress">
              @for (i of [1, 2, 3, 4, 5]; track i) {
                <span [class.done]="step() > i || step() === 6" [class.now]="step() === i"></span>
              }
            </span>
          </div>
          <p>{{ message() }}</p>
        </div>
        <div class="eng-actions">
          @if (step() < 6 && canNext()) {
            <button class="eng-btn" (click)="next()">{{ step() === 0 ? 'Lights out' : step() === 5 ? 'Take the flag' : 'Next lap' }}</button>
          }
          @if (step() === 6) {
            <button class="eng-btn ghost" (click)="restart()">Run it again</button>
            <button class="eng-btn" (click)="goRacing.emit()">Go racing</button>
          }
        </div>
      </footer>
    </div>
  `,
})
export class Tutorial {
  /** Opacity of faded regions. */
  readonly dim = input(0.14);
  readonly exit = output<void>();
  readonly goRacing = output<void>();

  protected readonly step = signal(0);
  protected readonly choice = signal<Choice | null>(null);
  protected readonly boxed = signal(false);
  protected readonly ers = signal<Ers | null>(null);

  protected readonly team = TEAM;
  protected readonly options = OPTIONS;
  protected readonly skills = ['Read the tower', 'Spot tyre wear', 'Answer the radio', 'Make a stop', 'Use the battery'];
  protected readonly ersModes: { id: Ers; label: string }[] = [
    { id: 'attack', label: 'Attack' },
    { id: 'defend', label: 'Defend' },
    { id: 'harvest', label: 'Harvest' },
  ];
  protected readonly bars = LAP_TIMES.map((t) => ({ label: '1:' + (t - 60).toFixed(2), h: Math.round(20 + (t - 92.3) * 100) }));

  protected readonly covered = computed(() => this.choice() === 'box');
  protected readonly lapShown = computed(() => Math.max(1, Math.min(5, this.step())));
  protected readonly boxActive = computed(() => this.step() === 4 && !this.covered() && !this.boxed());
  protected readonly battery = computed(() => (this.ers() === 'attack' ? 37 : this.ers() === 'harvest' ? 82 : 62));

  protected readonly focus = computed<Focus>(() => {
    const s = this.step();
    if (s === 1) return 'tower';
    if (s === 2) return 'laps';
    if (s === 3 || s === 6) return 'radio';
    if (s === 4) return this.covered() || this.boxed() ? 'tower' : 'box';
    if (s === 5) return this.ers() ? 'tower' : 'ers';
    return 'none';
  });
  protected isFaded(region: string): boolean {
    return this.focus() !== 'none' && this.focus() !== region;
  }

  protected readonly rows = computed<Row[]>(() => {
    const s = this.step();
    const covered = this.covered();
    const boxed = this.boxed();
    let order = ['VER', 'NOR', 'LEC', 'YOU', 'RUS', 'HAM', 'ALO', 'SAI'];
    let data = BASE;
    let pit: Record<string, boolean> = {};
    if (s === 2) {
      data = { ...BASE, YOU: ['+1.902', '1:33.21', 'M', 18], LEC: ['+2.388', '1:32.71', 'M', 18], RUS: ['+0.872', '1:32.95', 'M', 17] };
    } else if (s === 3) {
      order = ['VER', 'NOR', 'LEC', 'YOU', 'HAM', 'ALO', 'SAI', 'RUS'];
      data = { ...BASE, YOU: ['+1.95', '1:33.30', 'M', 19], HAM: ['+6.84', '1:32.90', 'H', 23], ALO: ['+1.52', '1:32.95', 'H', 25], SAI: ['+2.31', '1:33.12', 'M', 20], RUS: ['+14.20', '1:54.66', 'H', 0] };
      pit = { RUS: true, YOU: covered };
    } else if (s >= 4) {
      const fresh = covered || boxed;
      order = covered ? ['VER', 'NOR', 'LEC', 'YOU', 'RUS', 'HAM', 'ALO', 'SAI'] : ['VER', 'NOR', 'LEC', 'RUS', 'YOU', 'HAM', 'ALO', 'SAI'];
      data = {
        ...BASE,
        YOU: [covered ? '+0.62' : '+0.71', fresh ? '1:31.40' : '1:33.52', fresh ? 'H' : 'M', fresh ? (s === 4 ? 0 : 1) : 21],
        RUS: [covered ? '+0.88' : '+1.94', '1:31.62', 'H', 2],
        LEC: ['+2.31', '1:33.60', 'M', 20],
      };
      pit = { YOU: s === 4 && boxed && !covered };
      if (s >= 6 && this.ers() === 'attack') {
        const i = order.indexOf('YOU');
        order = [...order];
        [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
        data = { ...data, YOU: ['+1.02', '1:30.98', 'H', 2] };
      }
    }
    return order.map((code, i) => {
      const [int, last, tyre, age] = data[code]!;
      return { pos: i + 1, code, int, last, tyre, age, pit: !!pit[code], me: code === 'YOU' };
    });
  });
  protected readonly finish = computed(() => this.rows().findIndex((r) => r.me) + 1);

  protected readonly message = computed(() => {
    const s = this.step();
    const target = this.covered() ? 'Leclerc' : 'Russell';
    const choice = this.choice();
    const ers = this.ers();
    switch (s) {
      case 0:
        return "Radio check. Five laps, one job each lap. Hit Lights out when you're ready.";
      case 1:
        return "This is the tower. Int is the gap to the car ahead. We're P4, 1.8 behind Leclerc.";
      case 2:
        return "Watch your lap times. They're climbing, so the Mediums are wearing. About two tenths a lap.";
      case 3:
        return choice ? REPLIES[choice] : "Russell's boxed behind us. Pick an answer on the radio.";
      case 4:
        if (this.covered()) return 'We covered him. The out-lap on cold Hards is slow, but Russell is behind us.';
        return this.boxed() ? "Good stop, 2.4. Russell's ahead now, but our tyres are fresher." : 'Box, box. Hit BOX THIS LAP.';
      case 5:
        if (ers === 'attack') return `Great move! Past ${target}.`;
        if (ers === 'defend') return "Defend won't get you past. That's for holding position.";
        if (ers === 'harvest') return 'Harvest recharges, but costs lap time. We stay behind.';
        return `${target}'s 0.6 ahead. Pick a battery mode.`;
      default:
        return `Chequered flag. P${this.finish()}. That's the basics. Time to go racing.`;
    }
  });

  protected readonly canNext = computed(() => {
    const s = this.step();
    return s <= 2 || (s === 3 && !!this.choice()) || (s === 4 && (this.covered() || this.boxed())) || (s === 5 && !!this.ers());
  });

  protected next(): void {
    this.step.update((s) => Math.min(6, s + 1));
  }
  protected pick(c: Choice): void {
    if (!this.choice()) this.choice.set(c);
  }
  protected box(): void {
    if (this.boxActive()) this.boxed.set(true);
  }
  protected setErs(m: Ers): void {
    if (this.step() === 5 && !this.ers()) this.ers.set(m);
  }
  protected restart(): void {
    this.step.set(0);
    this.choice.set(null);
    this.boxed.set(false);
    this.ers.set(null);
  }
}
