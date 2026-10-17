/** Compound names and availability per track (2011–2015 classics had two compounds and era names). */
import { availableCompounds, type Compound, type TrackData } from '@pit-wall/engine';

const DEFAULT_NAMES: Record<Compound, string> = { S: 'Soft', M: 'Medium', H: 'Hard' };

/** Display name per slot, e.g. { S: 'Ultrasoft', M: 'Soft', H: 'Medium' } for 2018. */
export function compoundNames(track: TrackData | null): Record<Compound, string> {
  return { ...DEFAULT_NAMES, ...(track?.compoundNames ?? {}) };
}

/** The nominated compounds, softest first. */
export function compoundsOf(track: TrackData | null): Compound[] {
  return track ? availableCompounds(track) : ['S', 'M', 'H'];
}
