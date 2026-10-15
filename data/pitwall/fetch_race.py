"""Stub: load one FastF1 session and print lap, stint and track-status counts.

    python -m pitwall.fetch_race --season 2026 --event Singapore --session R

The real fitting (deg, pit loss, hazards, base pace, strategies) comes in PLAN.md M2+.
"""

from __future__ import annotations

import argparse
from collections import Counter

from .cache import enable_cache

# FastF1 TrackStatus codes
TRACK_STATUS = {
    "1": "green",
    "2": "yellow",
    "4": "sc",
    "5": "red",
    "6": "vsc",
    "7": "vsc_ending",
}


def summarise(season: int, event: str | int, session_name: str) -> dict:
    import fastf1

    enable_cache()
    session = fastf1.get_session(season, event, session_name)
    session.load(laps=True, telemetry=False, weather=True, messages=True)

    try:
        laps = session.laps
    except fastf1.exceptions.DataNotLoadedError as e:
        raise SystemExit(
            f"No lap data for {season} {event} {session_name}. FastF1 needs network access to "
            "livetiming.formula1.com and api.jolpi.ca (Ergast), or a warm data/cache/."
        ) from e
    stints = laps[["Driver", "Stint"]].dropna().drop_duplicates()
    status = Counter(
        TRACK_STATUS.get(str(s), f"code_{s}") for s in session.track_status["Status"]
    )
    # Laps run under each status (a lap's TrackStatus string can hold several codes)
    lap_status = Counter()
    for codes in laps["TrackStatus"].dropna().astype(str):
        for c in set(codes):
            lap_status[TRACK_STATUS.get(c, f"code_{c}")] += 1

    weather = session.weather_data
    return {
        "event": session.event["EventName"],
        "date": str(session.date),
        "total_laps_scheduled": int(laps["LapNumber"].max()) if len(laps) else 0,
        "lap_rows": len(laps),
        "drivers": int(laps["Driver"].nunique()),
        "stints": len(stints),
        "compounds": dict(Counter(laps["Compound"].dropna())),
        "track_status_changes": dict(status),
        "laps_touching_status": dict(lap_status),
        "air_temp_start": float(weather["AirTemp"].iloc[0]) if len(weather) else None,
        "track_temp_start": float(weather["TrackTemp"].iloc[0]) if len(weather) else None,
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--season", type=int, default=2026)
    p.add_argument("--event", default="Singapore")
    p.add_argument("--session", default="R")
    args = p.parse_args(argv)
    event: str | int = int(args.event) if args.event.isdigit() else args.event

    for k, v in summarise(args.season, event, args.session).items():
        print(f"{k:>22}: {v}")


if __name__ == "__main__":
    main()
