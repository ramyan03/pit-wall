# Pit Wall

A browser-based motorsport **race-strategy** game. Watch the timing tower, read tyre
wear from lap times, and call the pit stops. Track parameters are fitted from real 2026
races with [FastF1](https://github.com/theOehrly/Fast-F1).

> Status: scaffold only. See [`PLAN.md`](PLAN.md) for milestones and [`CLAUDE.md`](CLAUDE.md)
> for the race model and conventions.

```
data/    Python + FastF1 pipeline -> data/out/<track>.json
engine/  pure TypeScript race sim (seeded, DOM-free) + track JSON Schema
web/     Angular app (static; deploys to Vercel)
server/  reserved for later (leaderboards); not in the MVP
```

## Quick start

```bash
npm install          # Node >= 22.22.3
npm run smoke        # needs: npm run data:setup (once)
npm run dev
```

Not affiliated with Formula 1. No official logos or trademarks are used.
