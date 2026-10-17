import type { TrackData } from '../../src/types';
import raw from './track.synthetic.json';
import raw22 from './track.synthetic22.json';

/** Hand-made 4-car track for unit tests. Not real data. */
export const syntheticTrack = raw as unknown as TrackData;
export const syntheticTrackJson: unknown = raw;

/** Hand-made 22-car, 62-lap track (generic codes, no real drivers). Not real data. */
export const synthetic22 = raw22 as unknown as TrackData;
export const synthetic22Json: unknown = raw22;
