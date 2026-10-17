# Pit Wall

A browser-based F1 **race-strategy** game. No driving. A race plays at 1/10 real time
(~10 s a lap, sector-by-sector live timing, car dots moving on the real circuit outline;
½×/1×/4×/16×, pausable). The player watches a timing tower, sector and lap times, gaps
and tyre ages, and decides **when to pit, which compound to fit, and the pace mode**.
Tracks are built from real 2026 races. Today that's Jolpica data plus manual tyre
estimates (FastF1 live timing returns 401). The FastF1 fit is the goal (PLAN.md D1/D2).

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
   is banned in `/engine`. `RaceState.rngState` is the race KEY: every lap draws from
   independent streams hashed from (key, lap, driver, purpose), so **same seed + same
   commands = identical race**, a race resumes from any snapshot, and one car's decision
   never shifts another car's draws (common random numbers). Stream layout and draw order
   are documented at the top of `race.ts`. If you change them, update tests on purpose.
3. **The data schema is the contract.** `engine/schema/track.schema.json` is the only
   definition. `engine/src/types.ts` mirrors it by hand. `/data` validates every output
   against the same file (never copy it). Change schema + types + pipeline in the same
   commit and bump `schemaVersion` / `TRACK_SCHEMA_VERSION`.
4. **No hidden-info leaks.** In Hard mode the UI never reads `RaceState.effectiveTyres`
   or `TrackData.tyres`. It only reads `priorTyres`, track temp and observed lap times.
   Keep this behind a single selector.
5. **Real names and branding are PRIVATE ONLY (owner's decision, 2026-10-16).** Real driver
   names, teams, photos and logos are allowed for local/private play. **Never deploy this
   build publicly** (`vercel.json` has git deployments disabled for this reason). Photos and logos come
   only from Wikimedia Commons, with author + licence on the Credits screen
   (`web/public/media/credits.json`). Teams without a free logo get a colour monogram.
   Race engineers are fictional.
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

1× = 1/10 real time (`TIME_SCALE` in `race-store.ts`), plus ½×, 4×, 16× and pause. Auto-drop
to 1× on SC/VSC/red or when a car within ±2 positions of the player pits. The engine still
steps whole laps. The UI plays each lap out in race time. A BOX call before pit entry
(90% of the lap) re-simulates that lap. Later, it applies to the next lap.

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
- Network: FastF1 needs `livetiming.formula1.com` and `api.jolpi.ca`. As of 2026-10 the
  livetiming host returns **401** even locally, so FastF1 loads fail.
- **Current builder:** `python -m pitwall.build_jolpica` (Jolpica only). It writes every
  completed round to `data/out/` + `web/public/tracks/` (track JSON, `.circuit.json` outline
  from bacinger/f1-circuits (MIT), `.real.json` real result, `index.json`) and fetches
  Commons media. Tyres, temps, sector splits and SC rates come from its `PROFILES` table:
  **manual estimates** (`fit.method: manual`). Red-flag tyre changes are filtered out of
  the strategy templates.
- The dev server reloads every open tab when `web/public` changes, so don't run the builder mid-race.

## Key files

- `engine/src/types.ts`: `TrackData`, `RaceState`, `CarState`, `Strategy`, `RaceEvent`, `PlayerCommand`
- `engine/src/rng.ts`: seeded mulberry32 RNG
- `engine/src/race.ts`: `createRace` / `stepLap` / `applyCommand` / `simulateRace` (rough v1 of the whole model; RNG draw order documented at the top)
- `engine/test/fixtures/track.synthetic.json`: hand-made 4-car fixture (`meta.synthetic: true`)
- `engine/src/practice.ts`: simulated Friday long runs + the strategist's regression on them
- `engine/test/fixtures/track.synthetic22.json`: hand-made 22-car, 62-lap fixture (tests only)
- `web/src/app/data.ts`: ALL data loading (swap for an API here if a backend arrives)
- `web/src/app/race-store.ts`: live playback (race clock, sector timing, BOX re-sim, radio)
- `web/src/app/visibility.ts`: the single Hard-mode hidden-info selector (convention #4)
- `web/src/app/radio.ts`: fictional engineers + radio lines
- `data/pitwall/build_jolpica.py`: season builder (see Data pipeline)
- `data/pitwall/fetch_race.py`: loads one session and prints lap/stint/status counts
