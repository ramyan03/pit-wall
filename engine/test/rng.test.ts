import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';

const draw = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.next());

describe('Rng', () => {
  it('is deterministic: same seed gives same sequence', () => {
    expect(draw(new Rng(42), 1000)).toEqual(draw(new Rng(42), 1000));
  });

  it('different seeds diverge', () => {
    expect(draw(new Rng(1), 10)).not.toEqual(draw(new Rng(2), 10));
  });

  it('resumes exactly from serialised state', () => {
    const a = new Rng(7);
    draw(a, 123);
    const b = Rng.fromState(a.state);
    expect(draw(a, 50)).toEqual(draw(b, 50));
  });

  it('next() stays in [0, 1)', () => {
    for (const x of draw(new Rng(3), 10_000)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('normal() has roughly the requested moments', () => {
    const rng = new Rng(11);
    const xs = Array.from({ length: 20_000 }, () => rng.normal(0, 0.25));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(mean).toBeCloseTo(0, 2);
    expect(sd).toBeCloseTo(0.25, 2);
  });

  it('weightedIndex follows the weights', () => {
    const rng = new Rng(5);
    const counts = [0, 0];
    for (let i = 0; i < 10_000; i++) counts[rng.weightedIndex([0.75, 0.25])]!++;
    expect(counts[0]! / 10_000).toBeCloseTo(0.75, 1);
  });
});
