from pathlib import Path

from .paths import CACHE_DIR


def enable_cache(cache_dir: Path = CACHE_DIR) -> Path:
    """Turn on the FastF1 on-disk cache. Call this before loading any session."""
    import fastf1

    cache_dir.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(str(cache_dir))
    return cache_dir
