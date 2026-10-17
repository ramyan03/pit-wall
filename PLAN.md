# Pit Wall: Plan

Status: **M0 done. M1 accepted. Playable private v1 of M2–M7** on 17 real 2026 circuits
(Jolpica data + manual tyre estimates; tunables marked `PLACEHOLDER` in `engine/src/race.ts`).
Each later milestone still needs its acceptance pass against fitted data. D1/D2 blocked
(FastF1 live timing returns 401). Not started: M8, M9.

## Progress log

- **2026-10-16 · a5d955b:** engine rough v1 (M1 accepted, M2–M5 roughed in), first demo UI.
- **2026-10-16 · 5dc1d6d:** schema v2 (sectors, fullName); per-lap/per-car RNG streams (CRN);
  one pass per lap; live sector timing at 1/10 real time with moving map; 17 circuits from
  Jolpica + bacinger outlines; pre-race briefing, simulated FP2 long runs, strategy sims;
  real names + Commons photos/logos with credits (private only, Vercel deploys off);
  fictional engineers + team radio; results vs the real race.
  Owner playtest: "very cool and working well".

## Next up (owner feedback, 2026-10-16)

1. **Speed control as a slider**, not just 1×/4×/16× presets.
2. **More agency than Push/Conserve.** The player should feel they can act every few laps.
3. **Pit-wall chatter that reads the race**, e.g. "Russell looks like he's going long on a
   1-stop, push now", "Antonelli just pitted for the undercut, stay out / cover".
4. **Undercut / overcut as a real mechanic:** out-lap tyre warm-up, fresh-tyre delta,
   pit-exit traffic, rivals reacting (cover the undercut).

**Agreed design (owner, 2026-10-16), build next session:**
- Time: a continuous **speed slider**, ¼×–30× on a log scale, plus pause (no replay scrubber).
- Undercut/overcut physics: out-lap warm-up penalty by compound (Hard slowest), pit-exit
  traffic (rejoin behind slower cars), AI covers an undercut when it's in range.
- Engineer chatter infers rivals' plans from tyre age + pace (not from hidden AI plans).
- New player agency, all four:
  - **Radio decisions:** engineer asks at key moments (rival boxed, SC, car closing) with
    2–3 answer buttons, plus a quick sim estimate per answer where hints are allowed.
  - **Attack / Defend / Harvest:** 2026-style battery. Spend charge to raise or resist pass
    chance, harvest to recharge, with a gauge.
  - **Push targets:** "push for N laps", then back to neutral automatically.
  - **Team orders:** teammate holds up a rival, or lets you by.
- Engine changes stay deterministic: new draws go on the per-car streams, commands keyed
  by lap.

## MVP track: Singapore 2026 (recommended), Monaco 2026 as fallback

**Pick: Singapore.** The game is about reading wear and timing stops, and Singapore stresses
every part of that. Monaco mostly doesn't.

| | Singapore | Monaco |
|---|---|---|
| Overtaking | Hard but possible, so undercut/overcut decide places | Almost impossible. Track position beats strategy, so 1-stop always wins |
| Tyre wear | High temps, long stints, real deg. Hidden wear in Hard mode matters | Very low deg (2026 tyres were low-wear anyway). Hard mode has little to hide |
| 1-stop vs 2-stop | Viable debate. The balance criterion is achievable | Balance criterion is close to impossible to meet honestly |
| SC rate | Historically about one SC per race. "Pit under SC?" is a live decision | High too, plus red flags |
| Red flag | Rare (exercised via tests + forced-seed scenarios) | Real 2026 red flag. Good showcase |
| Race length | ~62 laps, about 4 min at 16× | 78 laps of mostly processional racing |

**Caveats:** Singapore 2026 is very recent (Oct 2026), and I haven't checked its FastF1 data
from this environment because the network policy blocks the F1 timing hosts. Unlike the
six rounds in the brief, I have no seed facts for it. If its data turns out incomplete,
fall back to **Monaco** (seed facts are known) or **Japan** (high-deg C1–C3, SC-decided).
Monaco stays the best second track, for the red-flag showcase.

## Milestones (thin vertical slices)

Each milestone ends with green `npm run smoke` and its acceptance criteria met. Engine
milestones run against the synthetic fixture until D1 lands real data.

### M0: Scaffold ✅
- Monorepo, CLAUDE.md, PLAN.md, schema + types, RNG, stubs, smoke tests in Python and TS.

### M1: Lap loop
- `createRace` / `stepLap`: base pace + fuel + track evo + noise. Order by cumulative time.
  Gaps and intervals. Grid start offsets. Race ends at `meta.laps`. Traffic (follow /
  held-up / overtake chance) with `overtake` events.
- **Accept:** determinism test (same seed → deep-equal `RaceState` every lap; different seed
  → differs). No car's lap is faster than `basePace − compoundOffset` bounds. A faster car
  stuck behind a slower one passes within an expected number of laps (statistical test,
  fixed seed). `simulateRace` runs 22 cars × 62 laps in < 5 ms.

### M2: Tyre wear + pace modes
- Compound offset, linear deg × tempMult × paceMult, quadratic cliff. Push/Neutral/Conserve.
- **Accept:** lap time is non-decreasing in tyre age, net of noise (test with σ=0). Past
  `cliffLap` the delta grows quadratically. Push is faster per lap but crosses the cliff
  earlier than Conserve.

### D1: Data: tyre fit for the MVP track *(parallel with M2)*
- Fuel correction, lap filtering (lap 1, in/out, SC/VSC/red, traffic < 1.5 s, outliers),
  per-compound regression → `degRate`, `compoundOffset`, cliff. `priorTyres` from 2025.
  Base pace per driver, temps, allocation.
- **Accept:** `data/out/2026-singapore.json` validates against the schema. r² and `nLaps`
  are recorded per compound. A compound with < 30 clean laps falls back to `method: prior`.
  A fit-diagnostics plot is saved (not committed).

### M3: Pit stops + player commands
- `applyCommand` (box/cancel/set_pace), end-of-lap pit execution, pit loss + stationary +
  slow stop, two-compound rule (finishing on one dry compound = DSQ, which the UI warns about).
- **Accept:** a pit costs `pitLoss + stationary` ± noise. Slow-stop frequency ≈ 5% over 10k
  stops. Undercut test: on fresh tyres vs worn ones, the undercut works when deg is high
  and fails when deg ≈ 0.

### D2: Data: pit loss, hazards, strategies
- Pit loss from pit-lane vs racing-speed stretches. SC/VSC/red hazard per lap from 2018+
  track status at this circuit. Strategy templates + weights from the 2026 race (blended
  with 2024–25).
- **Accept:** fitted pit loss within ±1.5 s of published/known values. Hazard × laps gives
  expected incidents per race close to the historical count.

### M4: SC / VSC / red flag
- Hazard draw each lap. SC compression, VSC multipliers, discounted pit loss. Red flag:
  free tyre change, restart in order. Events emitted.
- **Accept:** over 10k races, incident frequency matches hazards (±10%). Gaps after an SC are
  ≈ `scCompressedGap`. A pit under SC costs ≈ 50% of a green pit. A red flag lets a 0-stop
  car satisfy the two-compound rule.

### M5: AI strategies + balance
- AI picks weighted templates, jitters pit laps, opportunistic SC/VSC stops. `npm run balance`.
- **Accept:** see *Balance* below. AI strategy mix over 1k races matches the template weights.

### M6: Timing tower UI
- Angular: timing tower (position, code, team colour, gap, interval, last lap, tyre +
  age, stops), gap chart, tyre panel, controls (BOX + compound, pace, 1×/4×/16×/pause),
  auto-slow, team radio text feed ("Box, box", "Tyres are gone").
- **Accept:** a full race is playable at all speeds without dropped laps. 16× keeps up
  (engine step < 1 ms). The two-compound warning shows. Works at 375 px width.

### M7: Difficulty modes + pit-window hints
- Web Worker Monte Carlo: from the current `RaceState`, sim N continuations per candidate
  (lap × compound) and show "Box L18–24 for Hards". Hard mode: `priorTyres` + temp only,
  hidden lognormal truth, no hints.
- **Accept:** the hint returns in < 300 ms at N=200. With the hint followed, the player
  beats their median result. A grep/test confirms Hard mode never reads `effectiveTyres`.

### M8: Post-race breakdown + real-race replay validation
- Breakdown: your strategy vs the best one found **with hindsight, using the same seed**
  (common random numbers, so incidents line up), and seconds gained/lost per decision
  (counterfactual: re-sim with only that decision swapped for the optimal one).
- **Accept:** see *Replay test*. Per-decision deltas sum to within ±10% of the total delta
  (interactions are reported as a residual).

### M9: Ship
- Vercel deploy, perf pass, About page with data attribution (FastF1), no trademarks.

## Validation (required: the engine isn't done without it)

**Determinism** (from M1): same seed + same command log → identical `RaceState` (deep-equal)
on every lap. Snapshot/restore from `rngState` mid-race gives the same finish. Golden-race
snapshot test catches any accidental change to draw order.

**Real-race replay** (M8): give each real top-5 finisher their real strategy (compounds +
real pit laps) and force incidents to the real laps. Sim 500 seeds. Pass if:
- the real gap-to-winner of ≥ 4 of the 5 drivers falls inside the simulated 10th–90th percentile band;
- median absolute gap error across the 5 drivers is ≤ 8 s;
- simulated winner's race time is within ±1% of the real one;
- real winner finishes in the sim top 3 in ≥ 50% of seeds.

**Balance** (M5): `npm run balance` sims 1,000 races per strategy (player car = mid-field
driver, all else AI) and prints mean/median finishing position and time ± sd. Pass if
the best 1-stop and best 2-stop are within 5 s of mean race time and each beats the
other in ≥ 30% of paired seeds. No strategy family wins > 70% of paired seeds.

## Later (don't build yet)

- Practice session: limited runs reveal noisy wear clues; sets used cost race sets.
- Rival strategist AI that covers your undercut.
- Beat-the-real-strategist mode.
- Weather / radar, intermediate and wet tyres.
- Daily seeded challenge + leaderboard (`/server`: Express + Postgres).
- Season mode, all tracks.

## Open questions

1. **MVP track:** OK with Singapore (with Monaco/Japan as fallback), or do you want Monaco
   because its data is already confirmed?
2. **Wear visibility in Easy/Normal:** do these show exact wear %, or just tyre age plus the
   pit-window hint? (The brief only says Hard hides it.)
3. **Pace mode numbers:** proposal: Push = −0.25 s/lap and wear ×1.35, Conserve = +0.30 s/lap
   and wear ×0.75. Tune in M5.
4. **Hard-mode `tempMultiplier`:** I read it as `1 + tempSens × (raceTrackTemp − lastYearTrackTemp)`.
   Right?
5. **Player car:** any of the 22, or a fixed mid-field car? Does the AI ignore the player
   until the "rival strategist" feature arrives?
6. **Not in the v1 model:** start/lap-1 shuffle, DNFs/retirements, blue flags/lapped cars,
   damage. Proposal: small seeded lap-1 position noise in M1. The rest stays out of the MVP.
7. **Two-compound rule edge cases:** penalty or DSQ for violators? (Real rule: DSQ.)
   Wet races are out of scope.
8. **Hindsight "best strategy":** best with perfect knowledge of incidents (same seed), or
   best ex-ante (expected value)? The proposal is hindsight with an expected-value line next to it.

## Risks

- **Data access / freshness:** 2026 FastF1 data for recent rounds may be partial. Sandboxed
  sessions can't reach the F1 timing hosts, so the pipeline runs locally and the curated
  JSON is committed.
- **Weak deg signal:** early-2026 wear was low, so regressions may have low r² and noisy
  cliffs. Mitigations: pool across drivers, priors from other compounds or seasons, flag
  `fit.method`.
- **Realism vs balance:** the real data may say 1-stop dominates. The balance target may
  need explicit tuning knobs (documented, not hidden).
- **Cross-browser determinism:** `Math.log/cos/exp` aren't bit-identical across JS engines.
  Same-browser determinism is fine for the MVP. The daily challenge/leaderboard will need
  an integer-only normal sampler (e.g. table-based inverse CDF).
- **Monte Carlo cost:** pit-window hints recompute often. Budget it in the worker, cache
  per lap, cancel stale requests.
- **Toolchain:** Angular 22 needs Node ≥ 22.22.3 (this sandbox had 22.22.0, so Node 24 via npx was used).
- **Trademarks:** keep names generic (team names, codes, colours). No logos, no "F1" branding in the product name/UI.
