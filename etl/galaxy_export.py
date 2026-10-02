"""
Galaxy export: the warehouse tables -> one JSON that the Listening Galaxy draws.

    python etl/galaxy_export.py --input ~/Downloads/my_spotify_data.zip --out ../listening-galaxy/data/galaxy.json

Runs the same extract and transform as pipeline.py, then answers the galaxy's questions from fact_play,
dim_track, dim_artist and dim_session: every song's life (first, peak, last), every artist's orbit, which
songs I play back-to-back, and the story chapters. Only summaries are written: no timestamps of single plays.
"""

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from pipeline import build_tables, check, extract, to_plays

MIN_TOGETHER = 3      # two songs are linked once I've played them back-to-back this often
LINKS_PER_SONG = 3    # each song keeps its strongest few links


def month_of(day: str) -> str:
    return day[:7]


def longest_streak(days: set) -> tuple:
    """Gaps and islands, the same idea as v_song_streaks: the longest run of consecutive days."""
    best, run, start, prev = (0, None), 0, None, None
    for d in sorted(days):
        run, start = (run + 1, start) if prev and d - prev == timedelta(days=1) else (1, d)
        if run > best[0]:
            best = (run, start)
        prev = d
    return best


def export(tables: dict, records: int, song_records: int, private: int) -> dict:
    artist_name = {a["artist_key"]: a["artist_name"] for a in tables["dim_artist"]}
    desi = {a["artist_key"] for a in tables["dim_artist"] if a["desi"]}
    track = {t["track_key"]: t for t in tables["dim_track"]}
    plays = tables["fact_play"]
    listens = [p for p in plays if p["counted"]]

    # ---- songs: every track with at least one real listen
    per_song = defaultdict(list)
    for p in listens:
        per_song[p["track_key"]].append(p)
    skipped, total = Counter(), Counter()
    for p in plays:
        total[p["track_key"]] += 1
        skipped[p["track_key"]] += p["skipped"]

    by_artist = defaultdict(list)
    for p in listens:
        by_artist[track[p["track_key"]]["artist_key"]].append(p)
    artist_order = sorted(by_artist, key=lambda k: (-sum(p["ms_played"] for p in by_artist[k]), artist_name[k]))
    artist_index = {k: i for i, k in enumerate(artist_order)}

    song_order = sorted(per_song, key=lambda k: (-len(per_song[k]), track[k]["track_name"].lower()))
    song_index = {k: i for i, k in enumerate(song_order)}
    songs = []
    for k in song_order:
        ps = per_song[k]
        days = Counter(p["played_at"][:10] for p in ps)
        months = Counter(month_of(p["played_at"]) for p in ps)
        hours = Counter(p["hour"] for p in ps)
        best_day, best_day_n = max(days.items(), key=lambda d: (d[1], d[0]))
        streak, _ = longest_streak({date.fromisoformat(d) for d in days})
        songs.append([
            track[k]["track_name"],
            artist_index[track[k]["artist_key"]],
            len(ps),                                                  # listens
            round(sum(p["ms_played"] for p in ps) / 60_000),          # minutes
            ps[0]["played_at"][:10],                                  # first listen
            ps[-1]["played_at"][:10],                                 # last listen
            max(months.items(), key=lambda m: (m[1], m[0]))[0],       # peak month
            hours.most_common(1)[0][0],                               # usual hour
            round(skipped[k] / total[k], 2),                          # skip rate, over every play
            best_day_n, best_day,                                     # biggest single day
            streak,                                                   # most days in a row
            track[k]["mood"],
        ])

    # ---- artists: each constellation's orbit
    artists = []
    for k in artist_order:
        ps = by_artist[k]
        months = Counter(month_of(p["played_at"]) for p in ps)
        weeks = Counter((date.fromisoformat(p["played_at"][:10]) - timedelta(days=date.fromisoformat(p["played_at"][:10]).weekday())).isoformat() for p in ps)
        week, week_n = max(weeks.items(), key=lambda w: (w[1], w[0]))
        artists.append({
            "name": artist_name[k], "desi": k in desi,
            "listens": len(ps), "hours": round(sum(p["ms_played"] for p in ps) / 3.6e6, 1),
            "songs": len({p["track_key"] for p in ps}),
            "first": ps[0]["played_at"][:10], "last": ps[-1]["played_at"][:10],
            "peak_month": max(months.items(), key=lambda m: (m[1], m[0]))[0],
            "peak_week": week, "peak_week_listens": week_n,
        })

    # ---- months: how much, who owned it (by minutes, like v_monthly_eras), and how many songs were new
    month_minutes, month_listens, owner = Counter(), Counter(), defaultdict(Counter)
    for p in listens:
        m = month_of(p["played_at"])
        month_minutes[m] += p["ms_played"] / 60_000
        month_listens[m] += 1
        owner[m][track[p["track_key"]]["artist_key"]] += p["ms_played"]
    new_songs = Counter(month_of(s[4]) for s in songs)
    months = [{"month": m, "listens": month_listens[m], "hours": round(month_minutes[m] / 60, 1),
               "owner": artist_index[owner[m].most_common(1)[0][0]], "new_songs": new_songs[m]}
              for m in sorted(month_listens)]

    # ---- links: songs I play back-to-back inside one listening session (dim_session, 30-minute gaps).
    # Raw counts would link Ariana to everything, so each pair is scored by cosine similarity:
    # together / sqrt(listens of A * listens of B).
    together = Counter()
    for a, b in zip(listens, listens[1:]):
        if a["session_key"] == b["session_key"] and a["track_key"] != b["track_key"]:
            together[tuple(sorted((song_index[a["track_key"]], song_index[b["track_key"]])))] += 1
    n = [s[2] for s in songs]
    strength = {p: c / math.sqrt(n[p[0]] * n[p[1]]) for p, c in together.items() if c >= MIN_TOGETHER}
    mine = defaultdict(list)
    for p, v in strength.items():
        mine[p[0]].append((v, p))
        mine[p[1]].append((v, p))
    keep = {p for l in mine.values() for _, p in sorted(l, reverse=True)[:LINKS_PER_SONG]}
    links = sorted([a, b, together[(a, b)]] for a, b in keep)

    # ---- moods for untagged songs, inferred from the songs I play them with (label propagation).
    # A song takes the mood that wins at least 60% of its link weight to songs that already have one;
    # each later round can lean on inferred moods too, at half the weight of the round before.
    neighbours = defaultdict(list)
    for a, b, c in links:
        neighbours[a].append((b, c))
        neighbours[b].append((a, c))
    tagged = {i: s[12] for i, s in enumerate(songs) if s[12]}
    inferred = {}
    for weight in (1.0, 0.5, 0.25):
        found = {}
        for i in range(len(songs)):
            if i in tagged or i in inferred:
                continue
            votes = Counter()
            for j, c in neighbours[i]:
                if j in tagged:
                    votes[tagged[j]] += c
                elif j in inferred:
                    votes[inferred[j]] += c * weight
            if votes:
                mood, v = votes.most_common(1)[0]
                if v / sum(votes.values()) >= 0.6:
                    found[i] = mood
        inferred.update(found)
    for i, s in enumerate(songs):
        s.append(inferred.get(i, ""))

    # ---- story: chapters found in the data, in date order
    story = []
    period_end = listens[-1]["played_at"][:10]
    first = listens[0]
    story.append({"date": first["played_at"][:10], "kind": "start", "song": song_index[first["track_key"]],
                  "title": "The galaxy begins", "text": "The first song I listened to past 30 seconds."})
    # my top artists were all there from the first week; the arrivals worth telling are the big ones who came later
    late = [i for i, a in enumerate(artists[:40]) if a["first"] >= "2022-09-01"][:4]
    for i in late:
        a = artists[i]
        story.append({"date": a["first"], "kind": "arrival", "artist": i,
                      "title": f"{a['name']} arrives", "text": f"{a['songs']} songs and {a['hours']:,} hours later, my #{i + 1} artist."})
    # each year's song of the year, by listens
    for year in sorted({s[4][:4] for s in songs}):
        year_counts = Counter(p["track_key"] for p in listens if p["played_at"].startswith(year))
        k, c = year_counts.most_common(1)[0]
        story.append({"date": f"{year}-12-31" if year != period_end[:4] else period_end, "kind": "year", "song": song_index[k],
                      "title": f"{year}'s song", "text": f"{c} listens that year. {sum(month_of(s[4]).startswith(year) for s in songs):,} songs found."})
    # the rival: whoever took the most months from my #1, told on the first month they won
    stolen = [m for m in months if m["owner"] != 0]
    if stolen:
        rival, wins = Counter(m["owner"] for m in stolen).most_common(1)[0]
        story.append({"date": next(m["month"] for m in stolen if m["owner"] == rival) + "-01", "kind": "rival", "artist": rival,
                      "title": f"{artists[rival]['name']} takes the crown",
                      "text": f"The first of {wins} months {artists[rival]['name']} beat {artists[0]['name']}. Nobody else did it more than twice."
                              if sorted(Counter(m["owner"] for m in stolen).values())[-2:-1] <= [2] else
                              f"The first of {wins} months {artists[rival]['name']} beat {artists[0]['name']}."})
    busiest = max(months, key=lambda m: m["listens"])
    story.append({"date": busiest["month"] + "-15", "kind": "month", "artist": busiest["owner"],
                  "title": "My busiest month", "text": f"{busiest['listens']:,} listens, {busiest['hours']:,} hours, {busiest['new_songs']} new songs."})
    newest = max(months, key=lambda m: m["new_songs"])
    if newest is not busiest:
        story.append({"date": newest["month"] + "-15", "kind": "month",
                      "title": "The most new stars", "text": f"{newest['new_songs']} songs I'd never played before, in one month."})
    day_song = max(range(len(songs)), key=lambda i: songs[i][9])
    story.append({"date": songs[day_song][10], "kind": "day", "song": day_song,
                  "title": "One song, one day", "text": f"{songs[day_song][9]} plays in a single day."})
    streak_song = max(range(len(songs)), key=lambda i: songs[i][11])
    streak_days = {date.fromisoformat(p["played_at"][:10]) for p in per_song[song_order[streak_song]]}
    streak_len, streak_start = longest_streak(streak_days)
    story.append({"date": streak_start.isoformat(), "kind": "streak", "song": streak_song,
                  "title": "The longest streak", "text": f"Every day for {streak_len} days in a row."})
    top = 0
    owned = sum(m["owner"] == top for m in months)
    story.append({"date": listens[-1]["played_at"][:10], "kind": "now", "artist": top,
                  "title": "Now", "text": f"{artists[top]['name']} owned {owned} of my {len(months)} months."})
    story.sort(key=lambda c: (c["date"], c["kind"] == "now"))

    period = (listens[0]["played_at"][:10], listens[-1]["played_at"][:10])
    return {
        "generated": datetime.now().strftime("%Y-%m-%d"),
        "period": period,
        "totals": {
            "records": records, "song_records": song_records, "private": private,
            "plays": len(plays), "listens": len(listens), "songs": len(songs), "artists": len(artists),
            "sessions": len(tables["dim_session"]), "hours": round(sum(p["ms_played"] for p in listens) / 3.6e6),
            "skipped": sum(p["skipped"] for p in plays), "links": len(links),
            "moods_tagged": len(tagged), "moods_inferred": len(inferred),
        },
        "song_fields": ["title", "artist", "listens", "minutes", "first", "last", "peak_month", "hour",
                        "skip_rate", "best_day_listens", "best_day", "streak", "mood", "mood_inferred"],
        "songs": songs, "artists": artists, "months": months, "links": links, "story": story,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path, help="Spotify's my_spotify_data.zip, or sample/sample_history.json")
    ap.add_argument("--out", required=True, type=Path, help="where galaxy.json goes")
    args = ap.parse_args()

    records = extract(args.input.expanduser())
    song_records = [r for r in records if r.get("master_metadata_track_name")]
    tables = build_tables(to_plays(records))
    problems = check(tables)
    if problems:
        raise SystemExit("Integrity check failed:\n  " + "\n  ".join(problems))
    data = export(tables, len(records), len(song_records), sum(bool(r.get("incognito_mode")) for r in song_records))
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    t = data["totals"]
    print(f"{t['listens']:,} listens -> {t['songs']:,} stars in {t['artists']:,} constellations, "
          f"{t['links']:,} links, {len(data['story'])} story chapters ({args.out.stat().st_size / 1024:,.0f} KB)")


if __name__ == "__main__":
    main()
