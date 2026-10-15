/**
 * Seeded PRNG (mulberry32). ALL engine randomness must go through an Rng
 * instance. Never use Math.random() in /engine.
 *
 * State is a single uint32, so it fits in RaceState and survives a JSON round trip.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Current state, to store in RaceState.rngState. */
  get state(): number {
    return this.s;
  }

  static fromState(state: number): Rng {
    return new Rng(state);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box–Muller (uses two draws per call, no caching, so it stays deterministic). */
  normal(mean = 0, sigma = 1): number {
    const u1 = 1 - this.next(); // (0, 1]
    const u2 = this.next();
    return mean + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** exp(N(mu, sigma)). Hard mode uses lognormal(0, 0.15) for race-day wear. */
  lognormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /** Index picked with probability proportional to its weight. */
  weightedIndex(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new Error('weightedIndex: weights must sum to > 0');
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}
