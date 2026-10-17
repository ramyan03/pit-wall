import { Component, computed, input } from '@angular/core';
import type { Circuit } from './data';

export interface MapDot {
  code: string;
  colour: string;
  /** 0–1 along the lap (distance). */
  fraction: number;
  player?: boolean;
  label?: boolean;
  pit?: boolean;
}

/** Real circuit outline (bacinger/f1-circuits) with optional sector marks and car dots. */
@Component({
  selector: 'app-circuit-map',
  template: `
    @if (geo(); as g) {
      <svg [attr.viewBox]="g.viewBox" class="circuit-map" [class.mini]="mini()" role="img" [attr.aria-label]="circuit()?.name + ' map'">
        <path class="track-casing" [attr.d]="g.d" />
        <path class="track-line" [attr.d]="g.d" />
        @if (!mini()) {
          @for (m of g.sectorMarks; track $index) {
            <circle class="sector-mark" [attr.cx]="m.x" [attr.cy]="m.y" [attr.r]="g.unit * 1.6" />
            <text class="sector-label" [attr.x]="m.x + g.unit * 3" [attr.y]="m.y - g.unit * 3" [attr.font-size]="g.unit * 5">S{{ $index + 2 }}</text>
          }
          <rect class="start-line" [attr.x]="g.start.x - g.unit * 2" [attr.y]="g.start.y - g.unit * 2" [attr.width]="g.unit * 4" [attr.height]="g.unit * 4" />
        }
        @for (d of placed(); track d.code) {
          <g class="dot" [class.player]="d.player" [attr.transform]="'translate(' + d.x + ',' + d.y + ')'">
            <circle [attr.r]="g.unit * (d.player ? 4.2 : 3.2)" [attr.fill]="d.colour" />
            @if (d.label) {
              <text [attr.y]="-g.unit * 5.5" [attr.font-size]="g.unit * 6" text-anchor="middle">{{ d.code }}{{ d.pit ? ' · PIT' : '' }}</text>
            }
          </g>
        }
      </svg>
    }
  `,
})
export class CircuitMap {
  readonly circuit = input<Circuit | null>(null);
  readonly sectorFractions = input<readonly number[] | null>(null);
  readonly dots = input<MapDot[]>([]);
  readonly mini = input(false);

  protected readonly geo = computed(() => {
    const c = this.circuit();
    if (!c || c.points.length < 2) return null;
    const pts = c.points;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(w, h) * 0.08;
    const unit = Math.max(w, h) / 220;
    // Cumulative distance for placing things by lap fraction.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    const len = cum.at(-1)!;
    const at = (f: number) => {
      const target = (((f % 1) + 1) % 1) * len;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= target) lo = mid;
        else hi = mid;
      }
      const seg = cum[hi]! - cum[lo]! || 1;
      const k = (target - cum[lo]!) / seg;
      return { x: pts[lo]![0] + (pts[hi]![0] - pts[lo]![0]) * k, y: pts[lo]![1] + (pts[hi]![1] - pts[lo]![1]) * k };
    };
    const sf = this.sectorFractions();
    const marks = sf ? [at(sf[0]!), at(sf[0]! + sf[1]!)] : [];
    return {
      viewBox: `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${w + 2 * pad} ${h + 2 * pad}`,
      d: 'M' + pts.map((p) => `${p[0]},${p[1]}`).join('L') + 'Z',
      unit,
      at,
      sectorMarks: marks,
      start: at(0),
    };
  });

  protected readonly placed = computed(() => {
    const g = this.geo();
    if (!g) return [];
    // Draw the player last so it sits on top.
    return [...this.dots()].sort((a, b) => Number(!!a.player) - Number(!!b.player)).map((d) => ({ ...d, ...g.at(d.fraction) }));
  });
}
