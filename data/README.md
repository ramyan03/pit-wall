# /data: FastF1 pipeline

Runs offline. Fits race-model parameters from FastF1 and writes one JSON per
track to `out/`, validated against `../engine/schema/track.schema.json`.

```bash
npm run data:setup                       # creates .venv, installs fastf1 + jsonschema + pytest
npm run data:fetch -- --season 2026 --event Singapore --session R
npm run test:data                        # offline smoke tests
```

The FastF1 cache lives in `data/cache/` (gitignored).
