/**
 * All data access goes through here. Today it's static JSON under /public (built by
 * data/pitwall/build_jolpica.py). If a backend arrives (/server), swap these fetches for API
 * calls and nothing else changes.
 */
import { Injectable, signal } from '@angular/core';
import type { TrackData } from '@pit-wall/engine';

export interface TrackIndexEntry {
  trackId: string;
  round: number;
  eventName: string;
  circuitName: string;
  locality: string;
  country: string;
  date: string;
  laps: number;
  lengthM: number | null;
  trackTempC: number;
  airTempC: number;
  /** Nominated compounds only: a C-number, or the era's name for classics. */
  allocation: Partial<Record<'S' | 'M' | 'H', string>>;
  /** Wear severity vs baseline (1 = medium). Manual estimate. */
  wear: number;
  winner: string;
  file: string;
  /** Classics (2011–2025 strategy races) only. */
  classic?: boolean;
  season?: number;
  blurb?: string;
}

export interface Circuit {
  id: string;
  name: string | null;
  lengthM: number | null;
  points: [number, number][];
  source: string;
  sourceUrl: string;
}

export interface RealResult {
  results: { code: string; position: number; grid: number; status: string; time: string | null }[];
  pitLaps: Record<string, number[]>;
  source: string;
}

export interface MediaCredit {
  file: string;
  path: string;
  pageUrl: string;
  author: string;
  license: string;
  licenseUrl?: string | null;
}

export interface Credits {
  /** Keyed by full name (driver codes repeat across eras). */
  drivers: Record<string, MediaCredit>;
  teams: Record<string, MediaCredit>;
}

const cache = new Map<string, Promise<unknown>>();
function getJson<T>(url: string): Promise<T> {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(url) as Promise<T>;
}

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly credits = signal<Credits>({ drivers: {}, teams: {} });

  constructor() {
    getJson<Credits>('media/credits.json')
      .then((c) => this.credits.set(c))
      .catch(() => undefined); // media is optional
  }

  index(): Promise<TrackIndexEntry[]> {
    return getJson('tracks/index.json');
  }
  track(id: string): Promise<TrackData> {
    return getJson(`tracks/${id}.json`);
  }
  circuit(id: string): Promise<Circuit> {
    return getJson(`tracks/${id}.circuit.json`);
  }
  real(id: string): Promise<RealResult | null> {
    return getJson<RealResult>(`tracks/${id}.real.json`).catch(() => null);
  }

  /** Driver photo by full name. */
  photo(fullName: string | undefined): string | null {
    return fullName ? (this.credits().drivers[fullName]?.path ?? null) : null;
  }
  logo(teamId: string): string | null {
    return this.credits().teams[teamId]?.path ?? null;
  }
}
