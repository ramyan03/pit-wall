/**
 * Core engine types. `TrackData` mirrors `schema/track.schema.json`, which is
 * the contract between `/data` (producer) and `/engine` (consumer). Change the
 * schema and these types together, and bump `TRACK_SCHEMA_VERSION`.
 */

export const TRACK_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Dry compounds, relative to the weekend's allocation (Pirelli C1–C5 → H/M/S). */
export type Compound = 'S' | 'M' | 'H';
export type PirelliCompound = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

export type PaceMode = 'push' | 'neutral' | 'conserve';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type TrackStatus = 'green' | 'sc' | 'vsc' | 'red';
export type SimSpeed = 1 | 4 | 16;

/** Driver code, e.g. "RUS". Unique per race. */
export type DriverCode = string;
export type TeamId = string;

// ---------------------------------------------------------------------------
// TrackData — produced by /data, one JSON per track/race
// ---------------------------------------------------------------------------

export interface TrackData {
  schemaVersion: typeof TRACK_SCHEMA_VERSION;
  meta: TrackMeta;
  conditions: Conditions;
  /** Which Pirelli compounds were nominated as H/M/S this weekend. */
  compoundAllocation: Record<Compound, PirelliCompound>;
  /** This race's fitted tyre model: the hidden truth in Hard mode. */
  tyres: Record<Compound, CompoundModel>;
  /** The same track's previous-season fit. Shown to the player in Hard mode. Null if no prior race. */
  priorTyres: Record<Compound, CompoundModel> | null;
  fuel: { fuelSecPerLap: number };
  /** Seconds of lap time gained per lap number as the track rubbers in. */
  trackEvo: number;
  /** Per-lap Gaussian lap-time noise σ, in seconds. */
  noiseSigma: number;
  pit: PitModel;
  traffic: TrafficModel;
  incidents: IncidentModel;
  teams: Team[];
  drivers: DriverEntry[];
  /** Realistic strategy set for AI cars, weighted by historical frequency. */
  strategies: StrategyTemplate[];
}

export interface TrackMeta {
  season: number;
  round: number;
  /** Plain event name, e.g. "Singapore". */
  eventName: string;
  /** Stable id used for file names, e.g. "2026-singapore". */
  trackId: string;
  laps: number;
  /** True for hand-made fixtures. Never ship a synthetic track. */
  synthetic: boolean;
  source: {
    fastf1Version: string | null;
    generatedAt: string;
    /** Seasons used for the incident-rate fit, e.g. [2018, ..., 2026]. */
    incidentSeasons: number[];
  };
}

export interface Conditions {
  airTempC: number;
  trackTempC: number;
  /** Track temp the tyre fit is referenced to (tempMult = 1 at refTempC). */
  refTempC: number;
}

export interface CompoundModel {
  /** Seconds added versus base pace on new tyres (softs are the most negative). */
  compoundOffset: number;
  /** Seconds lost per lap of tyre age, before temp and pace multipliers. */
  degRate: number;
  /** Tyre age (laps) where the quadratic cliff starts. */
  cliffLap: number;
  /** Cliff coefficient: + cliffK × max(0, age − cliffLap)². */
  cliffK: number;
  /** tempMult = 1 + tempSens × (trackTemp − refTemp). */
  tempSens: number;
  fit: FitQuality;
}

export interface FitQuality {
  nLaps: number;
  r2: number | null;
  /** How the value was obtained. 'prior' = borrowed from another compound or season. */
  method: 'regression' | 'prior' | 'manual';
}

export interface PitModel {
  /** Pit-lane time minus the same stretch at racing speed, excluding stationary time. */
  pitLoss: number;
  stationaryMean: number;
  slowStopProb: number;
  /** [min, max] extra seconds on a slow stop. */
  slowStopExtra: [number, number];
}

export interface TrafficModel {
  /** Gap (s) under which a car counts as following. ~1.0 */
  followGap: number;
  /** Pace advantage (s/lap) needed to get past without being held up. */
  overtakeDelta: number;
  /** Per-lap pass probability while held up. */
  overtakeProb: number;
}

export interface IncidentModel {
  scHazardPerLap: number;
  vscHazardPerLap: number;
  redHazardPerLap: number;
  /** [min, max] SC duration in laps. */
  scDurationLaps: [number, number];
  /** [min, max] VSC duration in laps. */
  vscDurationLaps: [number, number];
  /** Gap (s) cars are bunched to behind the SC. ~0.8 */
  scCompressedGap: number;
  /** Lap-time multipliers under each status, e.g. 1.40 for SC. */
  lapTimeMult: { sc: number; vsc: number };
  /** Pit-loss multipliers under each status, e.g. 0.5 for SC. */
  pitLossMult: { sc: number; vsc: number };
}

export interface Team {
  id: TeamId;
  name: string;
  /** Hex colour, e.g. "#00D2BE". */
  colour: string;
}

export interface DriverEntry {
  code: DriverCode;
  number: number;
  teamId: TeamId;
  /** Fuel-corrected clean-air lap time on new tyres at refTemp (s), before compound offset. */
  basePace: number;
  /** Grid slot, 1-based. */
  gridPosition: number;
}

export interface StrategyTemplate {
  id: string;
  /** Compounds in stint order, e.g. ['M', 'H']. */
  stints: Compound[];
  /** Nominal pit laps, one fewer than stints. */
  pitLaps: number[];
  /** ± laps an AI varies each pit lap by. */
  pitLapJitter: number;
  /** Historical frequency weight (doesn't need to sum to 1). */
  weight: number;
}

// ---------------------------------------------------------------------------
// Strategy and runtime state
// ---------------------------------------------------------------------------

export interface PlannedStop {
  lap: number;
  compound: Compound;
}

/** A concrete plan for one car. AI cars build one from a StrategyTemplate. */
export interface Strategy {
  startCompound: Compound;
  stops: PlannedStop[];
  /** Pit opportunistically under SC/VSC if within this many laps of a planned stop. */
  neutralisedPitWindow: number;
}

export interface StintRecord {
  compound: Compound;
  startLap: number;
  endLap: number | null;
}

/** 'disqualified': finished on one dry compound (two-compound rule, open question #7 proposal: DSQ). */
export type CarStatus = 'running' | 'in_pit' | 'retired' | 'finished' | 'disqualified';

export interface CarState {
  driver: DriverCode;
  teamId: TeamId;
  isPlayer: boolean;
  status: CarStatus;
  position: number;
  /** Cumulative race time (s). */
  totalTime: number;
  lastLapTime: number | null;
  bestLapTime: number | null;
  gapToLeader: number;
  /** Gap to the car directly ahead. */
  interval: number;
  compound: Compound;
  /** Laps on the current set. */
  tyreAge: number;
  stints: StintRecord[];
  /** Dry compounds used so far, for the two-compound rule. */
  compoundsUsed: Compound[];
  paceMode: PaceMode;
  strategy: Strategy;
  pitStops: number;
  /** Set for the player when BOX is pressed. Executed at the end of the lap. */
  pendingBox: Compound | null;
}

export interface NeutralisationState {
  status: TrackStatus;
  /** Laps until the current SC/VSC ends; 0 when green. */
  lapsRemaining: number;
}

export interface RaceConfig {
  seed: number;
  difficulty: Difficulty;
  playerDriver: DriverCode;
  playerStrategy: Strategy;
}

export interface RaceState {
  config: RaceConfig;
  trackId: string;
  /** Laps completed by the leader (0 before the start). */
  lap: number;
  totalLaps: number;
  neutralisation: NeutralisationState;
  /** Race-day tyre model after Hard-mode perturbation. Never shown in Hard mode. */
  effectiveTyres: Record<Compound, CompoundModel>;
  /** Cars sorted by position. */
  cars: CarState[];
  events: RaceEvent[];
  /** Serialised RNG state so a race can resume deterministically. */
  rngState: number;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// Events and commands
// ---------------------------------------------------------------------------

interface EventBase {
  lap: number;
}

export type RaceEvent =
  | (EventBase & { type: 'race_start' })
  | (EventBase & { type: 'pit_stop'; driver: DriverCode; from: Compound; to: Compound; stationary: number; slow: boolean })
  | (EventBase & { type: 'overtake'; driver: DriverCode; passed: DriverCode })
  | (EventBase & { type: 'sc_deployed'; laps: number })
  | (EventBase & { type: 'vsc_deployed'; laps: number })
  | (EventBase & { type: 'sc_ending' })
  | (EventBase & { type: 'vsc_ending' })
  | (EventBase & { type: 'red_flag' })
  | (EventBase & { type: 'restart' })
  | (EventBase & { type: 'fastest_lap'; driver: DriverCode; time: number })
  | (EventBase & { type: 'radio'; driver: DriverCode; message: string })
  | (EventBase & { type: 'race_finish'; winner: DriverCode });

export type RaceEventType = RaceEvent['type'];

export type PlayerCommand =
  | { type: 'box'; compound: Compound }
  | { type: 'cancel_box' }
  | { type: 'set_pace'; mode: PaceMode };
