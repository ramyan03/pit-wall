# Pit Wall

A browser-based F1 **race-strategy** game. No driving and no animation. A race runs
lap by lap (1×/4×/16×, pausable). The player watches a timing tower, lap times, gaps
and tyre ages, and decides **when to pit, which compound to fit, and the pace mode**.
Every track's parameters are fitted from real 2026 races with FastF1.

**What makes it different:** in Hard mode tyre wear % is never shown. You read wear from
lap times, like a real strategist.

See `PLAN.md` for milestones, open questions and risks. **Ask before changing the
stack or adding scope.**

## Repo layout

| Path | What | Tech |
|---|---|---|
| `/data` | Offline FastF1 pipeline that writes one JSON per track to `data/out/` | Python ≥3.11, FastF1, jsonschema, pytest |
| `/engine` | Race sim: pure TS, seeded, no DOM | TypeScript, Vitest |
| `/engine/schema/track.schema.json` | **The contract** between `/data` and `/engine` | JSON Schema 2020-12 |
| `/web` | UI that imports `@pit-wall/engine`. Strategy search runs in a Web Worker | Angular 22 (zoneless, standalone, signals) |
| `/server` | **Reserved. Not in the MVP.** Later: Express + Postgres leaderboards | — |

npm workspaces: `engine`, `web`. `/data` is Python and sits outside npm. The MVP
deploys to Vercel as a static site (`vercel.json`).

## Commands

```bash
npm install                 # Node >= 22.22.3 (Angular CLI requirement); .nvmrc pins 24
npm test                    # engine Vitest suite
npm run typecheck -w @pit-wall/engine
npm run smoke               # Python smoke tests + engine tests + typecheck
npm run balance             # 1,000 races per strategy, prints mean finish (stub until M5)
npm run dev                 # Angular dev server
npm run build               # static build -> web/dist/web/browser
cd web && npx ng test --watch=false   # web unit tests

npm run data:setup          # python venv in data/.venv
npm run data:fetch -- --season 2026 --event Singapore --session R
npm run test:data           # offline pytest
```

## Conventions (non-negotiable)

1. **The engine is pure.** `engine/src` has no DOM, no Node APIs, no I/O, no timers and
   no global state. `engine/tsconfig.json` sets `lib: ES2022, types: []` so the compiler
   enforces this. Functions take state and return new state.
2. **All randomness goes through the seeded `Rng`** (`engine/src/rng.ts`). `Math.random()`
   is banned in `/engine`. RNG state is stored in `RaceState.rngState`, so
   **same seed + same commands = identical race**, and a race can resume from a snapshot.
   Draw order is part of determinism. If you change it, update the golden tests on purpose.
3. **The data schema is the contract.** `engine/schema/track.schema.json` is the only
   definition. `engine/src/types.ts` mirrors it by hand. `/data` validates every output
   against the same file (never copy it). Change schema + types + pipeline in the same
   commit and bump `schemaVersion` / `TRACK_SCHEMA_VERSION`.
4. **No hidden-info leaks.** In Hard mode the UI never reads `RaceState.effectiveTyres`
   or `TrackData.tyres`. It only reads `priorTyres`, track temp and observed lap times.
   Keep this behind a single selector.
5. **No F1 logos or trademarks.** Use driver codes and numbers, team names and hex colours only.
6. Strategy search / Monte Carlo runs in the Web Worker (`web/src/app/*.worker.ts`), never on the UI thread.
7. The engine has no acceptance tests until the PLAN.md validation passes (replay, balance, determinism).

## Race model v1 (source of truth)

Per car, per lap:

```
lapTime = basePace[driver]
        + compoundOffset[c]                       // softs faster
        + degRate[c] × tempMult × paceMult × age
        + cliffK[c] × max(0, age − cliffLap[c])²   // tyre falls off
        + fuelSecPerLap × lapsRemaining            // ~0.03–0.06 s
        − trackEvo × lapNumber                     // rubbering in
        + N(0, σ≈0.25)

tempMult = 1 + tempSens × (trackTemp − refTemp)
```

- **Pace mode:** Push / Neutral / Conserve sets `paceMult` on wear plus a lap-time delta
  (values decided in M2, see PLAN.md open questions).
- **Traffic:** a car within `traffic.followGap` (~1.0 s) of the car ahead that isn't faster
  by more than `traffic.overtakeDelta` is held to the car ahead's pace, with a per-lap
  pass chance of `traffic.overtakeProb`.
- **Pit:** `pit.pitLoss` + stationary time (`stationaryMean` ≈ 2.4 s). With probability
  `slowStopProb` (~5%) the stop is slow and costs an extra `slowStopExtra` (1–3 s).
  The player's BOX is executed at the end of the current lap.
- **Rules:** a dry race must use at least two different dry compounds. Starting tyre is free.
- **SC:** per-lap hazard `incidents.scHazardPerLap`. Lasts `scDurationLaps` (3–6). Gaps
  compress to `scCompressedGap` (~0.8 s), lap times ×`lapTimeMult.sc` (~1.40),
  pit loss ×`pitLossMult.sc` (~0.5).
- **VSC:** hazard `vscHazardPerLap`, lap times ×~1.35, gaps preserved, pit loss ×~0.6.
- **Red flag:** hazard `redHazardPerLap`. Everyone gets a free tyre change (it counts toward
  the two-compound rule), then a restart in race order.
- **AI cars:** each picks a `StrategyTemplate`, weighted by historical `weight`, and jitters
  each pit lap by ±`pitLapJitter`. It pits under SC/VSC if within `neutralisedPitWindow`
  laps of a planned stop.
- **Grid:** 2026: 22 cars, 11 teams (Cadillac joined).

### Difficulty

| | Pit-window hint | SC/VSC/red | Wear info before race |
|---|---|---|---|
| Easy | Yes ("Box L18–24 for Hards"), Monte Carlo from current state | Off | Full |
| Normal | Yes | On | Full |
| Hard | No | On, at track's historical rate | Track temp + **last year's** fit (`priorTyres`) only |

Hard mode's hidden truth: `trueDeg = lastYearDeg × lognormal(0, 0.15) × tempMultiplier`,
drawn once per race from the seeded RNG and stored in `RaceState.effectiveTyres`.

### Sim speed

1×/4×/16× and pause. Auto-drop to 1× on SC/VSC/red or when a car within ±2 positions of
the player pits.

## Data pipeline (/data)

For each race, fit from FastF1 laps:

- **degRate / compoundOffset / cliff** per compound: fuel-correct lap times, then exclude
  lap 1, in/out laps, SC/VSC/red laps, laps in traffic (gap < 1.5 s) and outliers. Regress
  lap time on tyre age per compound.
- **pitLoss:** pit-lane time minus the same stretch at racing speed.
- **Hazard rates** from track status across 2018+ seasons at that circuit.
- **basePace** per driver, air/track temp at the start, compound allocation (C1–C5 → H/M/S),
  strategy frequency distribution.
- Output `data/out/<season>-<event>.json`, validated against `engine/schema/track.schema.json`.
- **Always call `pitwall.cache.enable_cache()`** before loading a session. The cache
  (`data/cache/`) is gitignored.
- Network: FastF1 needs `livetiming.formula1.com` and `api.jolpi.ca`. Some sandboxes block
  these, so run the pipeline locally and commit the curated JSON.

## Key files

- `engine/src/types.ts`: `TrackData`, `RaceState`, `CarState`, `Strategy`, `RaceEvent`, `PlayerCommand`
- `engine/src/rng.ts`: seeded mulberry32 RNG
- `engine/src/race.ts`: `createRace` / `stepLap` / `applyCommand` / `simulateRace` (stubs)
- `engine/test/fixtures/track.synthetic.json`: hand-made 4-car fixture (`meta.synthetic: true`)
- `data/pitwall/fetch_race.py`: loads one session and prints lap/stint/status counts
