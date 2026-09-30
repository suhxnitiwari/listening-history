"""
Listening History ETL: my Spotify extended streaming history -> a star schema in PostgreSQL.

    python etl/pipeline.py --input ~/Downloads/my_spotify_data.zip --out build/
    python etl/pipeline.py --input ~/Downloads/my_spotify_data.zip --out build/ --load   (needs DATABASE_URL)

Extract   read every Streaming_History_Audio_*.json file straight out of Spotify's zip
Transform keep songs only, drop private-session plays and the fields that aren't mine to publish
          (IP address, country, device), convert to Austin time, merge duplicate song IDs,
          and group plays into listening sessions
Load      write one CSV per table, and optionally COPY them into PostgreSQL using sql/schema.sql
"""

import argparse
import csv
import json
import os
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

AUSTIN = ZoneInfo("America/Chicago")
COUNTED_MS = 30_000                     # Spotify counts a stream at 30 seconds
SESSION_GAP = timedelta(minutes=30)     # a break longer than this starts a new session
# Known bad data, removed on purpose. Each entry: (Austin date, song title, why).
# March 21, 2023: "Party In The U.S.A." looped on its own overnight (145 plays, 12:41 to 10:32 AM,
# 144 of them started only because the last one ended). I was asleep, not obsessed.
# January 22, 2025: "Hate Me" did the same, 105 plays starting at 3:32 AM.
UNATTENDED_LOOPS = [
    (date(2023, 3, 21), "Party In The U.S.A.", "left on repeat overnight"),
    (date(2025, 1, 22), "Hate Me (with Juice WRLD)", "left on repeat overnight"),
]

SEASONS = {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring",
           6: "Summer", 7: "Summer", 8: "Summer", 9: "Fall", 10: "Fall", 11: "Fall"}


@dataclass
class Play:
    played_at: datetime          # Austin time, when the play ended (Spotify's ts)
    track_name: str
    artist_name: str
    album_name: str
    uri: str
    ms_played: int
    skipped: bool
    shuffle: bool
    reason_start: str
    reason_end: str


# ---------- Extract ----------

def extract(zip_path: Path) -> list:
    """Every audio record in the export, in whatever order Spotify wrote them."""
    if zip_path.suffix == ".json":                     # the made-up sample in sample/
        return json.loads(zip_path.read_text())
    records = []
    with zipfile.ZipFile(zip_path) as z:
        for name in sorted(z.namelist()):
            if re.search(r"Streaming_History_Audio_.*\.json$", name):
                records.extend(json.loads(z.read(name)))
    return records


# ---------- Transform ----------

def clean_key(text: str) -> str:
    """How two song titles are compared: no accents, no case, no punctuation or extra spaces."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def to_plays(records: list) -> list:
    plays = []
    for r in records:
        if not r.get("master_metadata_track_name"):      # podcasts and audiobooks
            continue
        if r.get("incognito_mode"):                       # private sessions stay private
            continue
        ended = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).astimezone(AUSTIN).replace(tzinfo=None)
        plays.append(Play(
            played_at=ended,
            track_name=r["master_metadata_track_name"].strip(),
            artist_name=r["master_metadata_album_artist_name"].strip(),
            album_name=(r.get("master_metadata_album_album_name") or "Unknown album").strip(),
            uri=r["spotify_track_uri"],
            ms_played=int(r["ms_played"]),
            skipped=bool(r.get("skipped")) or r.get("reason_end") == "fwdbtn",
            shuffle=bool(r.get("shuffle")),
            reason_start=r.get("reason_start") or "",
            reason_end=r.get("reason_end") or "",
        ))
    # drop the known overnight loops (see UNATTENDED_LOOPS)
    loops = {(d, clean_key(title)) for d, title, _ in UNATTENDED_LOOPS}
    plays = [p for p in plays if (p.played_at.date(), clean_key(p.track_name)) not in loops]
    # the same play can appear twice across export files; keep one
    unique = {(p.played_at, p.uri, p.ms_played): p for p in plays}
    return sorted(unique.values(), key=lambda p: p.played_at)


def build_tables(plays: list) -> dict:
    # artists
    artists = sorted({p.artist_name for p in plays}, key=str.lower)
    artist_key = {name: i + 1 for i, name in enumerate(artists)}

    # songs: merge every ID that shares a title and artist; keep the album and ID I played most
    song_of = lambda p: (clean_key(p.track_name), p.artist_name)
    uri_counts, album_counts, title_counts = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)
    first_day = {}
    for p in plays:
        s = song_of(p)
        uri_counts[s][p.uri] += 1
        album_counts[s][p.album_name] += 1
        title_counts[s][p.track_name] += 1
        first_day[s] = min(first_day.get(s, p.played_at.date()), p.played_at.date())

    albums = sorted({(album_counts[s].most_common(1)[0][0], s[1]) for s in uri_counts}, key=lambda a: (a[1].lower(), a[0].lower()))
    album_key = {a: i + 1 for i, a in enumerate(albums)}

    songs = sorted(uri_counts, key=lambda s: (s[1].lower(), s[0]))
    track_key = {s: i + 1 for i, s in enumerate(songs)}
    dim_track = [{
        "track_key": track_key[s],
        "track_name": title_counts[s].most_common(1)[0][0],
        "artist_key": artist_key[s[1]],
        "album_key": album_key[(album_counts[s].most_common(1)[0][0], s[1])],
        "spotify_uri": uri_counts[s].most_common(1)[0][0],
        "first_played": first_day[s].isoformat(),
    } for s in songs]

    # sessions: a new one starts after a gap of more than 30 minutes
    sessions, current = [], None
    session_of = []
    for p in plays:
        started = p.played_at - timedelta(milliseconds=p.ms_played)
        if current is None or started - current["ended_at"] > SESSION_GAP:
            current = {"session_key": len(sessions) + 1, "started_at": started, "ended_at": p.played_at, "play_count": 0, "ms": 0}
            sessions.append(current)
        current["ended_at"] = max(current["ended_at"], p.played_at)
        current["play_count"] += 1
        current["ms"] += p.ms_played
        session_of.append(current["session_key"])
    dim_session = [{
        "session_key": s["session_key"],
        "started_at": s["started_at"].isoformat(sep=" ", timespec="seconds"),
        "ended_at": s["ended_at"].isoformat(sep=" ", timespec="seconds"),
        "play_count": s["play_count"],
        "minutes": round(s["ms"] / 60_000, 1),
    } for s in sessions]

    # calendar: every day from the first play to the last, even the quiet ones
    first, last = plays[0].played_at.date(), plays[-1].played_at.date()
    dim_date, d = [], first
    while d <= last:
        dim_date.append({
            "date_key": int(d.strftime("%Y%m%d")), "full_date": d.isoformat(), "year": d.year, "month": d.month,
            "month_name": d.strftime("%B"), "day": d.day, "weekday": d.strftime("%A"),
            "is_weekend": d.weekday() >= 5, "season": SEASONS[d.month],
        })
        d += timedelta(days=1)

    fact_play = [{
        "play_key": i + 1,
        "track_key": track_key[song_of(p)],
        "date_key": int(p.played_at.strftime("%Y%m%d")),
        "session_key": session_of[i],
        "played_at": p.played_at.isoformat(sep=" ", timespec="seconds"),
        "hour": p.played_at.hour,
        "ms_played": p.ms_played,
        "counted": p.ms_played >= COUNTED_MS,
        "skipped": p.skipped,
        "shuffle": p.shuffle,
        "reason_start": p.reason_start,
        "reason_end": p.reason_end,
    } for i, p in enumerate(plays)]

    dim_artist = [{"artist_key": artist_key[a], "artist_name": a} for a in artists]
    dim_album = [{"album_key": album_key[a], "album_name": a[0], "artist_key": artist_key[a[1]]} for a in albums]
    return {"dim_artist": dim_artist, "dim_album": dim_album, "dim_track": dim_track,
            "dim_date": dim_date, "dim_session": dim_session, "fact_play": fact_play}


def check(tables: dict) -> list:
    """Integrity checks a database would enforce, run before anything is loaded."""
    problems = []
    keys = {t: {row[f"{t.split('_')[1]}_key"] for row in rows} for t, rows in tables.items() if t.startswith("dim_")}
    for row in tables["fact_play"]:
        for dim in ("track", "date", "session"):
            if row[f"{dim}_key"] not in keys[f"dim_{dim}"]:
                problems.append(f"play {row['play_key']} points to a missing {dim}")
                break
    for row in tables["dim_track"]:
        if row["album_key"] not in keys["dim_album"] or row["artist_key"] not in keys["dim_artist"]:
            problems.append(f"track {row['track_key']} points to a missing album or artist")
    return problems[:20]


# ---------- Load ----------

def write_csvs(tables: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, rows in tables.items():
        with open(out / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)


def load_postgres(out: Path, schema: Path, url: str) -> None:
    import psycopg  # pip install "psycopg[binary]"; only needed for --load
    order = ["dim_artist", "dim_album", "dim_track", "dim_date", "dim_session", "fact_play"]
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(schema.read_text())
        for name in order:
            with open(out / f"{name}.csv", encoding="utf-8") as f, cur.copy(f"COPY {name} FROM STDIN WITH (FORMAT csv, HEADER true)") as copy:
                copy.write(f.read())
        cur.execute((schema.parent / "insights.sql").read_text())   # the views are rebuilt on every load
        conn.commit()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path, help="Spotify's my_spotify_data.zip, or sample/sample_history.json")
    ap.add_argument("--out", default=Path("build"), type=Path, help="where the CSVs go")
    ap.add_argument("--load", action="store_true", help="also load into PostgreSQL at $DATABASE_URL")
    args = ap.parse_args()

    records = extract(args.input.expanduser())
    plays = to_plays(records)
    tables = build_tables(plays)
    problems = check(tables)
    if problems:
        raise SystemExit("Integrity check failed:\n  " + "\n  ".join(problems))
    write_csvs(tables, args.out)

    counted = sum(r["counted"] for r in tables["fact_play"])
    print(f"extracted {len(records):,} records -> {len(plays):,} song plays ({counted:,} counted, 30s+)")
    for name, rows in tables.items():
        print(f"  {name:<12} {len(rows):>8,} rows")
    if args.load:
        load_postgres(args.out, Path(__file__).resolve().parent.parent / "sql" / "schema.sql", os.environ["DATABASE_URL"])
        print("loaded into PostgreSQL")


if __name__ == "__main__":
    main()
