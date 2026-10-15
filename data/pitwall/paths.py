from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = DATA_DIR.parent
CACHE_DIR = DATA_DIR / "cache"  # gitignored
OUT_DIR = DATA_DIR / "out"
# The schema lives in /engine and is the contract. Never copy it into /data.
TRACK_SCHEMA = REPO_ROOT / "engine" / "schema" / "track.schema.json"
