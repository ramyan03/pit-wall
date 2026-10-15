import type { TrackData } from '../../src/types';
import raw from './track.synthetic.json';

/** Hand-made 4-car track for unit tests. Not real data. */
export const syntheticTrack = raw as unknown as TrackData;
export const syntheticTrackJson: unknown = raw;
