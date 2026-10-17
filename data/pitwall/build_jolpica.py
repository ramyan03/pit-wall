"""Build track JSONs + web assets from Jolpica (Ergast) when FastF1 live timing is unavailable.

FastF1's livetiming host returns 401 from here (2026-10), so this builder uses what Jolpica has:
entry list, grid, finishing order, lap times and pit stops. It CANNOT fit tyres (no compound
data), so tyres / temps / incidents / sector splits come from `PROFILES` below: documented
manual estimates (`fit.method: manual`), not fitted values.

Also writes, for the PRIVATE demo UI only (never deploy, see CLAUDE.md):
- circuit outlines from bacinger/f1-circuits (MIT)
- driver photos / team logos from Wikimedia Commons, with author + licence for the credits page
- the real result and pit laps, for the post-race comparison

Usage:
    python -m pitwall.build_jolpica                 # every completed round of 2026 + media
    python -m pitwall.build_jolpica --rounds 17     # just Singapore
    python -m pitwall.build_jolpica --no-media
    python -m pitwall.build_jolpica --classics      # the 2011–2025 classics (CLASSICS) + media
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from pitwall.paths import REPO_ROOT
from pitwall.schema import validate_track

JOLPICA = "https://api.jolpi.ca/ergast/f1"
CIRCUITS = "https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits"
WIKI = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
UA = "PitWallDemo/0.2 (https://github.com/ramyan03/pit-wall; personal project)"

WEB_PUBLIC = REPO_ROOT / "web" / "public"
DATA_OUT = REPO_ROOT / "data" / "out"

# Team ids, display names, colours and Wikipedia article (for a Commons logo), keyed by Jolpica
# constructor name. Hand-entered. Colours are the broadcast-graphics colour of the era; see
# TEAM_COLOUR_BY_SEASON for teams whose colour changed.
TEAMS = {
    "Red Bull": ("red-bull", "Red Bull Racing", "#3671C6", "Red Bull Racing"),
    "Ferrari": ("ferrari", "Ferrari", "#E8002D", "Scuderia Ferrari"),
    "Mercedes": ("mercedes", "Mercedes", "#27F4D2", "Mercedes-AMG Petronas F1 Team"),
    "McLaren": ("mclaren", "McLaren", "#FF8000", "McLaren"),
    "RB F1 Team": ("racing-bulls", "Racing Bulls", "#6692FF", "Racing Bulls"),
    "Audi": ("audi", "Audi", "#C0C0C0", "Audi in Formula One"),
    "Alpine F1 Team": ("alpine", "Alpine", "#0093CC", "Alpine F1 Team"),
    "Haas F1 Team": ("haas", "Haas", "#B6BABD", "Haas F1 Team"),
    "Williams": ("williams", "Williams", "#64C4FF", "Williams Racing"),
    "Aston Martin": ("aston-martin", "Aston Martin", "#229971", "Aston Martin in Formula One"),
    "Cadillac F1 Team": ("cadillac", "Cadillac", "#C9A227", "Cadillac Formula 1 Team"),
    # Historical (2011–2025 classics)
    "Renault": ("renault", "Renault", "#FFF500", "Renault in Formula One"),
    "Sauber": ("sauber", "Sauber", "#9B0000", "Sauber Motorsport"),
    "Force India": ("force-india", "Force India", "#F596C8", "Force India"),
    "Toro Rosso": ("toro-rosso", "Toro Rosso", "#469BFF", "Scuderia Toro Rosso"),
    "Lotus": ("team-lotus", "Team Lotus", "#006F3C", "Team Lotus (2010–11)"),
    "Lotus F1": ("lotus-f1", "Lotus", "#FFB800", "Lotus F1"),
    "Virgin": ("virgin", "Virgin", "#C40000", "Virgin Racing"),
    "HRT": ("hrt", "HRT", "#A6904F", "HRT Formula 1 Team"),
    "Caterham": ("caterham", "Caterham", "#0A7C2F", "Caterham F1"),
    "Marussia": ("marussia", "Marussia", "#6E0000", "Marussia F1"),
    "Manor Marussia": ("manor", "Manor", "#ED1C24", "Manor Racing"),
    "Alfa Romeo": ("alfa-romeo", "Alfa Romeo", "#900000", "Alfa Romeo in Formula One"),
    "Racing Point": ("racing-point", "Racing Point", "#F596C8", "Racing Point F1 Team"),
    "AlphaTauri": ("alphatauri", "AlphaTauri", "#4E7C9B", "Scuderia AlphaTauri"),
}

# (team id, first season, last season) → colour, where the era colour differs from TEAMS.
TEAM_COLOUR_BY_SEASON = [
    ("mercedes", 2011, 2013, "#B3B3B3"),  # silver before the turbo-hybrid era
    ("mercedes", 2014, 2025, "#00D2BE"),
    ("red-bull", 2011, 2025, "#1E41FF"),
    ("mclaren", 2011, 2016, "#8F8F8F"),  # chrome / grey years
    ("williams", 2011, 2013, "#00A0DE"),
    ("williams", 2014, 2025, "#005AFF"),
    ("renault", 2011, 2011, "#D4AF37"),  # Lotus Renault GP, black and gold
    ("force-india", 2011, 2016, "#FF5F0F"),
    ("sauber", 2011, 2017, "#9B9B9B"),
    ("sauber", 2024, 2025, "#52E252"),  # Kick Sauber
    ("alfa-romeo", 2022, 2023, "#C92D4B"),
    ("alpine", 2021, 2025, "#0090FF"),
    ("aston-martin", 2021, 2025, "#006F62"),
    ("alphatauri", 2023, 2023, "#5E8FAA"),
]


def team_colour(team_id: str, default: str, season: int) -> str:
    for tid, a, b, colour in TEAM_COLOUR_BY_SEASON:
        if tid == team_id and a <= season <= b:
            return colour
    return default

# Baseline tyre model (a mid-deg street/permanent track), scaled per circuit by `deg`.
BASE_TYRES = {
    "S": {"compoundOffset": -0.6, "degRate": 0.09, "cliffLap": 18, "cliffK": 0.03, "tempSens": 0.012},
    "M": {"compoundOffset": 0.0, "degRate": 0.055, "cliffLap": 30, "cliffK": 0.02, "tempSens": 0.01},
    "H": {"compoundOffset": 0.4, "degRate": 0.035, "cliffLap": 44, "cliffK": 0.012, "tempSens": 0.008},
}

# Per-circuit MANUAL ESTIMATES: bacinger id, Pirelli allocation (S, M, H), typical air/track °C,
# wear severity vs baseline, SC / VSC hazard per lap, sector shares. Not fitted: replace with
# FastF1 fits (PLAN.md D1/D2) once the timing host is reachable.
PROFILES: dict[str, dict] = {
    "albert_park": dict(circuit="au-1953", alloc=("C5", "C4", "C3"), air=22, track=34, deg=0.9, sc=0.025, vsc=0.012, sectors=(0.31, 0.35, 0.34)),
    "shanghai": dict(circuit="cn-2004", alloc=("C4", "C3", "C2"), air=20, track=30, deg=1.1, sc=0.012, vsc=0.01, sectors=(0.27, 0.38, 0.35)),
    "suzuka": dict(circuit="jp-1962", alloc=("C3", "C2", "C1"), air=20, track=30, deg=1.3, sc=0.015, vsc=0.012, sectors=(0.36, 0.36, 0.28)),
    "miami": dict(circuit="us-2022", alloc=("C5", "C4", "C3"), air=30, track=48, deg=1.0, sc=0.02, vsc=0.012, sectors=(0.33, 0.37, 0.30)),
    "villeneuve": dict(circuit="ca-1978", alloc=("C6", "C5", "C4"), air=22, track=35, deg=1.0, sc=0.03, vsc=0.012, sectors=(0.27, 0.38, 0.35)),
    "monaco": dict(circuit="mc-1929", alloc=("C6", "C5", "C4"), air=22, track=40, deg=0.5, sc=0.03, vsc=0.015, sectors=(0.27, 0.42, 0.31)),
    "catalunya": dict(circuit="es-1991", alloc=("C3", "C2", "C1"), air=26, track=42, deg=1.3, sc=0.01, vsc=0.01, sectors=(0.29, 0.40, 0.31)),
    "red_bull_ring": dict(circuit="at-1969", alloc=("C5", "C4", "C3"), air=25, track=40, deg=1.0, sc=0.012, vsc=0.012, sectors=(0.27, 0.37, 0.36)),
    "silverstone": dict(circuit="gb-1948", alloc=("C3", "C2", "C1"), air=21, track=32, deg=1.3, sc=0.015, vsc=0.012, sectors=(0.33, 0.40, 0.27)),
    "spa": dict(circuit="be-1925", alloc=("C3", "C2", "C1"), air=18, track=28, deg=1.1, sc=0.02, vsc=0.012, sectors=(0.30, 0.48, 0.22)),
    "hungaroring": dict(circuit="hu-1986", alloc=("C5", "C4", "C3"), air=30, track=48, deg=1.1, sc=0.01, vsc=0.012, sectors=(0.37, 0.35, 0.28)),
    "zandvoort": dict(circuit="nl-1948", alloc=("C3", "C2", "C1"), air=20, track=30, deg=1.1, sc=0.025, vsc=0.012, sectors=(0.31, 0.38, 0.31)),
    "monza": dict(circuit="it-1922", alloc=("C5", "C4", "C3"), air=27, track=42, deg=0.8, sc=0.015, vsc=0.012, sectors=(0.33, 0.36, 0.31)),
    "madring": dict(circuit="es-2026", alloc=("C5", "C4", "C3"), air=27, track=42, deg=1.0, sc=0.02, vsc=0.012, sectors=(0.33, 0.34, 0.33)),
    "baku": dict(circuit="az-2016", alloc=("C6", "C5", "C4"), air=24, track=38, deg=0.8, sc=0.03, vsc=0.015, sectors=(0.36, 0.37, 0.27)),
    "sepang": dict(circuit="my-1999", alloc=("C3", "C2", "C1"), air=32, track=52, deg=1.4, sc=0.012, vsc=0.012, sectors=(0.30, 0.40, 0.30)),
    "marina_bay": dict(circuit="sg-2008", alloc=("C5", "C4", "C3"), air=30, track=34, deg=1.0, sc=0.02, vsc=0.012, sectors=(0.31, 0.40, 0.29)),
    "bahrain": dict(circuit="bh-2002", alloc=("C3", "C2", "C1"), air=25, track=30, deg=1.2, sc=0.012, vsc=0.012, sectors=(0.31, 0.40, 0.29)),
}

# One strategy-decided race per season, 2011–2025 (owner's pick, 2026-10-17; reasons in PLAN.md).
# Each overrides the circuit PROFILE for its era. MANUAL ESTIMATES unless noted:
# - alloc: approximate C-scale equivalent of the era's compounds (pre-2019 names differ; `names`
#   is what the UI shows). 2011–2015 nominated two compounds: they sit in the S and H slots.
# - air/track °C: approximate race-day temperatures.
# - deg scales degRate, life scales cliffLap (2011–13 Pirellis wore fast and fell off early),
#   gap (s) = new-tyre gap between the softest and hardest slot when it differs from the baseline.
# - incidents: the real SC/VSC (lap deployed, laps under it), researched 2026-10-17 from race
#   reports. Retirements come from Jolpica.
CLASSICS: list[dict] = [
    dict(season=2011, round=3, alloc=("C3", "C2", "C1"), names={"S": "Soft", "H": "Hard"}, avail=("S", "H"), air=21, track=29, deg=1.8, life=0.55, gap=1.2, incidents=[],
         blurb="Hamilton's 3-stop beats Vettel's 2-stop late. Webber goes P18 → P3 on fresh tyres."),
    dict(season=2012, round=5, alloc=("C3", "C2", "C1"), names={"S": "Soft", "H": "Hard"}, avail=("S", "H"), air=23, track=38, deg=1.6, life=0.6, gap=1.0, incidents=[],
         blurb="Maldonado vs Alonso, decided by the undercut at both stops."),
    dict(season=2013, round=5, alloc=("C2", "C2", "C1"), names={"S": "Medium", "H": "Hard"}, avail=("S", "H"), air=22, track=37, deg=2.0, life=0.5, gap=0.6, incidents=[],
         blurb="Alonso wins from P5 on a 4-stop. Räikkönen's 3-stop is second. Peak high-deg Pirellis."),
    dict(season=2014, round=3, alloc=("C3", "C3", "C2"), names={"S": "Soft", "H": "Medium"}, avail=("S", "H"), air=23, track=29, deg=1.1, life=0.85, gap=0.7,
         incidents=[dict(lap=41, type="sc", laps=6)],
         blurb="Duel in the Desert: a late safety car puts Rosberg on softs against Hamilton on mediums."),
    dict(season=2015, round=2, alloc=("C2", "C2", "C1"), names={"S": "Medium", "H": "Hard"}, avail=("S", "H"), air=33, track=55, deg=1.5, life=0.5, gap=0.5,
         incidents=[dict(lap=4, type="sc", laps=3)],
         blurb="Mercedes pit under the early safety car. Vettel stays out and makes two stops beat three."),
    dict(season=2016, round=5, alloc=("C3", "C2", "C1"), names={"S": "Soft", "M": "Medium", "H": "Hard"}, air=22, track=40, deg=1.3, life=0.9,
         incidents=[dict(lap=1, type="sc", laps=3)],
         blurb="Both Mercedes out on lap 1. Verstappen's 2-stop holds off Räikkönen; Vettel's 3-stop fails."),
    dict(season=2017, round=5, alloc=("C3", "C2", "C1"), names={"S": "Soft", "M": "Medium", "H": "Hard"}, air=26, track=43, deg=1.0, life=1.0,
         incidents=[dict(lap=34, type="vsc", laps=2)],
         blurb="Hamilton vs Vettel: a VSC stop and offset tyres decide it."),
    dict(season=2018, round=3, alloc=("C4", "C3", "C2"), names={"S": "Ultrasoft", "M": "Soft", "H": "Medium"}, air=19, track=30, deg=1.1, life=1.0,
         incidents=[dict(lap=31, type="sc", laps=4)],
         blurb="Red Bull double-stack under the safety car. Ricciardo goes P6 → win on fresh softs."),
    dict(season=2019, round=12, alloc=("C4", "C3", "C2"), air=27, track=45, deg=1.1, life=1.0, incidents=[],
         blurb="Hamilton takes a second stop and hunts down Verstappen on old hards."),
    dict(season=2020, round=5, alloc=("C4", "C3", "C2"), air=28, track=43, deg=1.6, life=0.75, incidents=[],
         blurb="Verstappen on hards out-manages Mercedes as their tyres blister."),
    dict(season=2021, round=4, alloc=("C3", "C2", "C1"), air=24, track=40, deg=1.0, life=1.2,
         incidents=[dict(lap=8, type="sc", laps=3)],
         blurb="Hamilton's 2-stop reels in Verstappen's 1-stop."),
    dict(season=2022, round=13, alloc=("C4", "C3", "C2"), air=21, track=33, deg=1.1, life=1.0, incidents=[],
         blurb="Verstappen from P10 to the win, while Ferrari's hard-tyre call sinks Leclerc."),
    dict(season=2023, round=15, alloc=("C5", "C4", "C3"), air=30, track=36, deg=0.9, life=1.1,
         incidents=[dict(lap=20, type="sc", laps=3), dict(lap=44, type="vsc", laps=2)],
         blurb="Sainz manages the pack. Mercedes' late VSC stop and charge on mediums falls just short."),
    dict(season=2024, round=16, alloc=("C5", "C4", "C3"), air=28, track=42, deg=0.8, life=1.2, incidents=[],
         blurb="Leclerc's 1-stop beats McLaren's 2-stop."),
    dict(season=2025, round=14, alloc=("C5", "C4", "C3"), air=26, track=45, deg=1.0, life=1.1, incidents=[],
         blurb="Norris's 1-stop beats Piastri's 2-stop by 0.7 s."),
]
CLASSIC_KEYS = ("alloc", "air", "track", "deg")

FUEL_SEC_PER_LAP = 0.045
TRACK_EVO = 0.01
NOISE_SIGMA = 0.3
STATIONARY_MEAN = 2.4
# Ergast pit "duration" = pit-lane time incl. stationary. Loss vs racing ≈ lane time minus the
# same stretch at racing speed; that stretch is a guess (~4 s). Revisit with FastF1 data.
LANE_RACING_STRETCH = 4.0


def get_json(url: str, params: dict | None = None) -> dict:
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2.0 * (attempt + 1))  # Jolpica rate-limits bursts
    raise RuntimeError("unreachable")


def jolpica(season: int, rnd: int, what: str) -> dict | None:
    """Fetch a paged Ergast resource for one race and merge the pages."""
    key = {"laps": "Laps", "pitstops": "PitStops", "results": "Results"}[what]
    out: dict | None = None
    offset = 0
    while True:
        d = get_json(f"{JOLPICA}/{season}/{rnd}/{what}.json", {"limit": 100, "offset": offset})["MRData"]
        races = d["RaceTable"]["Races"]
        if races:
            if out is None:
                out = races[0]
            else:
                out[key].extend(races[0][key])
        offset += 100
        if offset >= int(d["total"]):
            break
        time.sleep(0.4)  # be polite to the free API
    return out


def parse_time(s: str) -> float:
    m, rest = s.split(":") if ":" in s else ("0", s)
    return int(m) * 60 + float(rest)


def base_paces(laps_doc: dict | None, pit_laps: dict[str, list[int]], total: int, deg_m: float) -> dict[str, float]:
    """Median clean lap, fuel- and tyre-age-corrected to the race model's basePace."""
    if not laps_doc:
        return {}
    per: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for lap in laps_doc["Laps"]:
        n = int(lap["number"])
        for t in lap["Timings"]:
            per[t["driverId"]].append((n, parse_time(t["time"])))
    out = {}
    for drv, rows in per.items():
        stops = pit_laps.get(drv, [])
        excluded = {1} | set(stops) | {s + 1 for s in stops}
        clean = [(n, t) for n, t in rows if n not in excluded]
        if len(clean) < 3:
            continue
        med = statistics.median(t for _, t in clean)
        clean = [(n, t) for n, t in clean if t < med * 1.04]  # drop SC/VSC/traffic laps
        corrected = []
        for n, t in clean:
            age = n - max([0] + [s for s in stops if s < n])
            corrected.append(t - FUEL_SEC_PER_LAP * (total - n + 1) - deg_m * age + TRACK_EVO * n)
        out[drv] = round(statistics.median(corrected), 3)
    return out


def stint_compounds(pit_laps: list[int], total: int, avail: tuple[str, ...]) -> list[str]:
    """Guess compounds for a stop pattern (Jolpica has no tyre data): longest stint on the hardest
    nominated compound, the shortest on the softest, the rest in between. Always uses two."""
    bounds = [0, *pit_laps, total]
    lengths = [b - a for a, b in zip(bounds, bounds[1:])]
    soft, hard = avail[0], avail[-1]
    mid = avail[1] if len(avail) == 3 else soft
    by_length = sorted(range(len(lengths)), key=lambda i: lengths[i])  # shortest first
    out = [mid] * len(lengths)
    out[by_length[-1]] = hard
    if len(lengths) > 2:
        out[by_length[0]] = soft
    return out


def strategies(pit_laps: dict[str, list[int]], total: int, avail: tuple[str, ...] = ("S", "M", "H")) -> list[dict]:
    """AI templates from the real stop patterns: one per stop count, at the median laps."""
    by_count: dict[int, list[list[int]]] = defaultdict(list)
    for laps in pit_laps.values():
        if 1 <= len(laps) <= 5:
            by_count[len(laps)].append(laps)
    out = []
    for k, rows in sorted(by_count.items()):
        laps, prev = [], 0
        for i in range(k):
            lap = max(prev + 3, round(statistics.median(r[i] for r in rows)))
            laps.append(min(total - 2 - (k - 1 - i) * 3, lap))
            prev = laps[-1]
        stints = stint_compounds(laps, total, avail)
        jitter = 4 if k == 1 else 3
        out.append({"id": f"{k}stop-{''.join(stints)}", "stints": stints, "pitLaps": laps, "pitLapJitter": jitter, "weight": len(rows)})
        if k == 1 and len(avail) == 3:
            # The reverse 1-stop (hard first), run longer, for variety.
            rev = [stints[1], stints[0]]
            out.append({"id": f"1stop-{''.join(rev)}", "stints": rev, "pitLaps": [min(total - 6, laps[0] + 6)], "pitLapJitter": jitter, "weight": round(len(rows) * 0.3, 2)})
    if not out:
        a, b = round(total * 0.3), round(total * 0.65)
        out.append({"id": "2stop-default", "stints": stint_compounds([a, b], total, avail), "pitLaps": [a, b], "pitLapJitter": 3, "weight": 1})
    return out


def circuit_outline(circuit_id: str) -> dict:
    gj = get_json(f"{CIRCUITS}/{circuit_id}.geojson")
    feat = gj["features"][0]
    coords = feat["geometry"]["coordinates"]
    lat0 = math.radians(sum(c[1] for c in coords) / len(coords))
    # Equirectangular projection to metres, y flipped for SVG.
    pts = [(c[0] * 111_320 * math.cos(lat0), -c[1] * 110_540) for c in coords]
    minx = min(p[0] for p in pts)
    miny = min(p[1] for p in pts)
    return {
        "id": circuit_id,
        "name": feat["properties"].get("Name"),
        "lengthM": feat["properties"].get("length"),
        "points": [(round(x - minx, 1), round(y - miny, 1)) for x, y in pts],
        "source": "bacinger/f1-circuits (MIT)",
        "sourceUrl": f"https://github.com/bacinger/f1-circuits/blob/master/circuits/{circuit_id}.geojson",
    }


# Jolpica statuses for cars that never took the start: left out of the field.
NON_STARTERS = {"Withdrew", "Did not start", "Did not qualify", "Did not prequalify"}


def is_retirement(status: str) -> bool:
    return not (status == "Finished" or status == "Lapped" or re.fullmatch(r"\+\d+ Laps?", status) or status == "Disqualified")


def driver_code(d: dict, taken: set[str]) -> str:
    """Jolpica's code, or the first three letters of the surname; unique within the race."""
    base = (d.get("code") or re.sub(r"[^A-Za-z]", "", d["familyName"])[:3]).upper()
    code, i = base, 2
    while code in taken:
        code, i = f"{base[:2]}{i}", i + 1
    taken.add(code)
    return code


def build_round(season: int, race_meta: dict, classic: dict | None = None) -> tuple[dict, dict] | None:
    rnd = int(race_meta["round"])
    cid = race_meta["Circuit"]["circuitId"]
    prof = PROFILES.get(cid)
    if prof is None:
        print(f"  round {rnd}: no profile for {cid}, skipped")
        return None
    if classic:
        prof = {**prof, **{k: classic[k] for k in CLASSIC_KEYS}}
    avail: tuple[str, ...] = tuple(classic.get("avail", ("S", "M", "H"))) if classic else ("S", "M", "H")
    race = jolpica(season, rnd, "results")
    if not race or not race.get("Results"):
        print(f"  round {rnd}: no results yet, skipped")
        return None
    race["Results"] = [r for r in race["Results"] if r["status"] not in NON_STARTERS]
    stops_doc = jolpica(season, rnd, "pitstops")
    laps_doc = jolpica(season, rnd, "laps")
    total = max(int(r["laps"]) for r in race["Results"])

    pit_laps: dict[str, list[int]] = defaultdict(list)
    # Racing stops only, for strategy templates: red-flag tyre changes show up as very long
    # (or unparseable "m:ss") durations, and lap-1/2 stops are damage or wet-start stops.
    racing_pits: dict[str, list[int]] = defaultdict(list)
    lane_times = []
    for p in (stops_doc or {}).get("PitStops", []):
        lap = int(p["lap"])
        pit_laps[p["driverId"]].append(lap)
        try:
            d = float(p["duration"])
        except ValueError:
            continue
        if d < 60 and lap > 2:
            lane_times.append(d)
            racing_pits[p["driverId"]].append(lap)
    for v in pit_laps.values():
        v.sort()

    tyres = {c: {**v, "degRate": round(v["degRate"] * prof["deg"], 4)} for c, v in BASE_TYRES.items()}
    if classic:
        # Era tyres: earlier cliff (life) and, for two-compound races, the real slot gap.
        for v in tyres.values():
            v["cliffLap"] = max(6, round(v["cliffLap"] * classic["life"]))
        if "gap" in classic:
            tyres["S"]["compoundOffset"] = round(-classic["gap"] * 0.6, 2)
            tyres["H"]["compoundOffset"] = round(classic["gap"] * 0.4, 2)
    pace = base_paces(laps_doc, pit_laps, total, tyres["M"]["degRate"])
    # Fallback for drivers without clean laps (early retirements): back of the field.
    fallback = (max(pace.values()) + 0.3) if pace else 90.0

    teams, team_articles, drivers, wiki = [], {}, [], {}
    taken: set[str] = set()
    codes: dict[str, str] = {}  # Jolpica driverId -> code in this race
    for r in race["Results"]:
        tid, tname, colour, article = TEAMS[r["Constructor"]["name"]]
        if tid not in team_articles:
            teams.append({"id": tid, "name": tname, "colour": team_colour(tid, colour, season)})
            team_articles[tid] = article
        d = r["Driver"]
        code = codes[d["driverId"]] = driver_code(d, taken)
        full = f"{d['givenName']} {d['familyName']}"
        drivers.append(
            {
                "code": code,
                "number": int(d.get("permanentNumber") or r["number"]),
                "teamId": tid,
                "fullName": full,
                "basePace": pace.get(d["driverId"], fallback),
                "gridPosition": int(r["grid"]) or 99,  # 0 = pit-lane start
            }
        )
        # Media is keyed by full name: codes repeat across eras (VER, MSC, HAR).
        wiki[full] = urllib.parse.unquote(d["url"].rsplit("/", 1)[-1]).replace("_", " ")
    for i, d in enumerate(sorted(drivers, key=lambda x: (x["gridPosition"], x["code"]))):
        d["gridPosition"] = i + 1

    fit = {"nLaps": 0, "r2": None, "method": "manual"}
    lane = statistics.median(lane_times) if lane_times else 24.0
    slug = re.sub(r"[^a-z0-9]+", "-", race["raceName"].lower().replace(" grand prix", "")).strip("-")
    s1, s2, s3 = prof["sectors"]
    track = {
        "schemaVersion": 3,
        "meta": {
            "season": season,
            "round": rnd,
            "eventName": race["raceName"],
            "trackId": f"{season}-{slug}",
            "laps": total,
            "synthetic": False,
            "source": {
                "fastf1Version": None,
                "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "incidentSeasons": [],
            },
        },
        "conditions": {"airTempC": prof["air"], "trackTempC": prof["track"], "refTempC": prof["track"]},
        "compoundAllocation": dict(zip(("S", "M", "H"), prof["alloc"])),
        "tyres": {c: {**v, "fit": fit} for c, v in tyres.items()},
        "priorTyres": None,
        "fuel": {"fuelSecPerLap": FUEL_SEC_PER_LAP},
        "trackEvo": TRACK_EVO,
        "noiseSigma": NOISE_SIGMA,
        "sectorFractions": [s1, s2, s3],
        "pit": {
            "pitLoss": round(max(10.0, lane - LANE_RACING_STRETCH - STATIONARY_MEAN), 2),
            "stationaryMean": STATIONARY_MEAN,
            "slowStopProb": 0.05,
            "slowStopExtra": [1.0, 3.0],
        },
        "traffic": {"followGap": 1.0, "overtakeDelta": 0.9, "overtakeProb": 0.1 if prof["deg"] > 0.6 else 0.03},
        "incidents": {
            "scHazardPerLap": prof["sc"],
            "vscHazardPerLap": prof["vsc"],
            "redHazardPerLap": 0.002,
            "scDurationLaps": [3, 6],
            "vscDurationLaps": [1, 3],
            "scCompressedGap": 0.8,
            "lapTimeMult": {"sc": 1.4, "vsc": 1.35},
            "pitLossMult": {"sc": 0.5, "vsc": 0.6},
        },
        "teams": teams,
        "drivers": drivers,
        "strategies": strategies(racing_pits, total, avail),
    }
    if classic:
        track["availableCompounds"] = list(avail)
        if "names" in classic:
            track["compoundNames"] = classic["names"]
        track["realEvents"] = {
            "incidents": classic["incidents"],
            "retirements": [
                {"driver": codes[r["Driver"]["driverId"]], "lap": int(r["laps"]) + 1}
                for r in race["Results"]
                if is_retirement(r["status"]) and int(r["laps"]) < total
            ],
        }
    validate_track(track)

    tid = track["meta"]["trackId"]
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps(track, indent=2, ensure_ascii=False) + "\n"
    (DATA_OUT / f"{tid}.json").write_text(text, encoding="utf-8")
    tracks_dir = WEB_PUBLIC / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    (tracks_dir / f"{tid}.json").write_text(text, encoding="utf-8")
    circuit = circuit_outline(prof["circuit"])
    (tracks_dir / f"{tid}.circuit.json").write_text(json.dumps(circuit) + "\n", encoding="utf-8")

    id_to_code = codes
    real = {
        "results": [
            {"code": codes[r["Driver"]["driverId"]], "position": int(r["position"]), "grid": int(r["grid"]), "status": r["status"], "time": r.get("Time", {}).get("time")}
            for r in race["Results"]
        ],
        "pitLaps": {id_to_code[k]: v for k, v in pit_laps.items() if k in id_to_code},
        "source": "Jolpica (Ergast API)",
    }
    (tracks_dir / f"{tid}.real.json").write_text(json.dumps(real, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    winner = race["Results"][0]["Driver"]
    entry = {
        "trackId": tid,
        "round": rnd,
        "eventName": race["raceName"],
        "circuitName": race_meta["Circuit"]["circuitName"],
        "locality": race_meta["Circuit"]["Location"]["locality"],
        "country": race_meta["Circuit"]["Location"]["country"],
        "date": race_meta["date"],
        "laps": total,
        "lengthM": circuit["lengthM"],
        "trackTempC": prof["track"],
        "airTempC": prof["air"],
        "allocation": {c: (classic or {}).get("names", {}).get(c) or track["compoundAllocation"][c] for c in avail},
        "wear": prof["deg"],
        "winner": f"{winner['givenName']} {winner['familyName']}",
        "file": f"tracks/{tid}.json",
    }
    if classic:
        entry.update({"season": season, "classic": True, "blurb": classic["blurb"]})
    print(f"  round {rnd}: {race['raceName']} → {tid} ({len(drivers)} drivers, {len(pace)} paced, {sum(map(len, pit_laps.values()))} stops)")
    return entry, {"drivers": drivers, "teams": teams, "wiki": wiki, "teamArticles": team_articles}


# ---------------------------------------------------------------------------
# Wikimedia Commons media (photos + logos) with credits
# ---------------------------------------------------------------------------


def commons_image_for_article(title: str) -> dict | None:
    """The article's lead image, only if it lives on Commons (non-free en.wiki logos are skipped)."""
    d = get_json(WIKI, {"action": "query", "format": "json", "prop": "pageimages", "piprop": "name", "titles": title, "redirects": 1})
    page = next(iter(d["query"]["pages"].values()))
    name = page.get("pageimage")
    if not name:
        return None
    info = get_json(
        COMMONS,
        {"action": "query", "format": "json", "prop": "imageinfo", "titles": f"File:{name}", "iiprop": "url|extmetadata", "iiurlwidth": 240},
    )
    p = next(iter(info["query"]["pages"].values()))
    if "imageinfo" not in p:
        return None  # not on Commons
    ii = p["imageinfo"][0]
    meta = ii.get("extmetadata", {})

    def plain(key: str) -> str:
        return re.sub(r"<[^>]+>", "", meta.get(key, {}).get("value", "")).strip()

    return {
        "file": name,
        "thumbUrl": ii.get("thumburl") or ii["url"],
        "pageUrl": ii.get("descriptionurl"),
        "author": plain("Artist") or "Unknown",
        "license": plain("LicenseShortName") or "see file page",
        "licenseUrl": meta.get("LicenseUrl", {}).get("value"),
    }


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        dest.write_bytes(r.read())


def fetch_media(people: dict[str, str], team_articles: dict[str, str], manifest: dict) -> dict:
    """Add Commons media for drivers (keyed by full name) and teams (by id) to `manifest`.
    Entries already in it are kept and not fetched again."""
    media_dir = WEB_PUBLIC / "media"
    (media_dir / "drivers").mkdir(parents=True, exist_ok=True)
    (media_dir / "teams").mkdir(parents=True, exist_ok=True)
    for kind, items, folder in (("drivers", people, "drivers"), ("teams", team_articles, "teams")):
        for key, title in items.items():
            have = manifest[kind].get(key)
            if have and (WEB_PUBLIC / have["path"]).exists():
                continue
            img = commons_image_for_article(title)
            time.sleep(0.4)
            if not img:
                print(f"  no Commons image for {key} ({title})")
                continue
            ext = Path(urllib.parse.urlparse(img["thumbUrl"]).path).suffix.lower() or ".png"
            slug = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")
            rel = f"media/{folder}/{slug}{ext}"
            download(img["thumbUrl"], WEB_PUBLIC / rel)
            manifest[kind][key] = {**img, "path": rel}
            print(f"  {key}: {img['license']}")
            time.sleep(0.4)
    return manifest


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--rounds", type=int, nargs="*", help="default: every round before today")
    ap.add_argument("--no-media", action="store_true", help="skip Wikimedia downloads")
    ap.add_argument("--classics", action="store_true", help="build CLASSICS instead of a season")
    args = ap.parse_args(argv)

    todo: list[tuple[int, dict, dict | None]] = []
    if args.classics:
        for c in CLASSICS:
            if args.rounds and c["season"] not in args.rounds:
                continue  # --classics --rounds 2013 2015 = just those seasons
            meta = get_json(f"{JOLPICA}/{c['season']}/{c['round']}.json")["MRData"]["RaceTable"]["Races"][0]
            todo.append((c["season"], meta, c))
            time.sleep(0.4)
    else:
        schedule = get_json(f"{JOLPICA}/{args.season}.json")["MRData"]["RaceTable"]["Races"]
        if args.rounds:
            races = [r for r in schedule if int(r["round"]) in args.rounds]
        else:
            races = [r for r in schedule if date.fromisoformat(r["date"]) < date.today()]
        todo = [(args.season, r, None) for r in races]

    index_path = WEB_PUBLIC / "tracks" / "index.json"
    index = {e["trackId"]: e for e in (json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else [])}
    people: dict[str, str] = {}
    team_articles: dict[str, str] = {}
    for season, r, classic in todo:
        built = build_round(season, r, classic)
        if not built:
            continue
        entry, extra = built
        index[entry["trackId"]] = entry
        people.update(extra["wiki"])
        team_articles.update(extra["teamArticles"])
    index.pop("2026-synthetic-22", None)
    order = sorted(index.values(), key=lambda e: (e.get("classic", False), e.get("season", 2026), e["round"]))
    index_path.write_text(json.dumps(order, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"index: {len(index)} tracks")

    if not args.no_media:
        print("Wikimedia Commons media…")
        credits_path = WEB_PUBLIC / "media" / "credits.json"
        old = json.loads(credits_path.read_text(encoding="utf-8")) if credits_path.exists() else {"drivers": {}, "teams": {}}
        manifest = fetch_media(people, team_articles, old)
        credits_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
