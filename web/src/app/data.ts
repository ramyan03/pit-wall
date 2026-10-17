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
  allocation: Record<'S' | 'M' | 'H', string>;
  /** Wear severity vs baseline (1 = medium). Manual estimate. */
  wear: number;
  winner: string;
  file: string;
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

  photo(code: string): string | null {
    return this.credits().drivers[code]?.path ?? null;
  }
  logo(teamId: string): string | null {
    return this.credits().teams[teamId]?.path ?? null;
  }
}
