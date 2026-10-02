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


# My life's turning points, the same boundaries app/main.py uses for eras.
GRADUATED = date(2024, 6, 1)        # finished high school in May 2024
MOVED_TO_AUSTIN = date(2024, 8, 15)  # moved from my parents' house in Dallas to Austin


# Trips home to India, found as days of long offline listening (flights) and confirmed by me.
TRIPS = [(date(2024, 3, 7), date(2024, 3, 18)), (date(2024, 12, 21), date(2025, 1, 7))]


def era_of(d: date) -> str:
    if d < GRADUATED:
        return "high_school"
    if d < MOVED_TO_AUSTIN:
        return "summer"
    return "austin" if d.year < 2026 else "y2026"


def clean_title(t: str) -> str:
    """A song's title without the version: '(with Em Beihold) - Em Beihold Version' and '- Piano Version' are the same song."""
    return t.split(" (")[0].split(" - ")[0].strip().lower()


def facts(tables: dict, listens: list, song_index: dict, artist_index: dict, track: dict, artist_name: dict, desi: set, months: list, offline: dict, song_rows: list) -> dict:
    """The evidence for the tour: every number a chapter quotes, computed here so none is typed by hand."""
    plays = tables["fact_play"]
    at = lambda p: datetime.fromisoformat(p["played_at"])
    art = lambda p: track[p["track_key"]]["artist_key"]
    F = {}

    # who runs this galaxy, and who took the crown
    ms = Counter()
    for p in listens:
        ms[art(p)] += p["ms_played"]
    top = ms.most_common(1)[0][0]
    owners = [m["owner"] for m in months]
    F["top"] = {"artist": artist_index[top], "share": round(100 * ms[top] / sum(ms.values()), 1),
                "owned": owners.count(0), "months": len(months)}
    rivals = Counter(o for o in owners if o != 0)
    rival, wins = rivals.most_common(1)[0]
    first_win = next(i for i, o in enumerate(owners) if o == rival)
    run = 0
    for o in reversed(owners[:first_win]):
        if o != 0:
            break
        run += 1
    m0 = months[first_win]["month"]
    in_month = Counter(p["track_key"] for p in listens if p["played_at"].startswith(m0) and art(p) == next(k for k, v in artist_index.items() if v == rival))
    F["rival"] = {"artist": rival, "months": [m["month"] for m, o in zip(months, owners) if o == rival], "first": m0,
                  "reign_before": run, "song": song_index[in_month.most_common(1)[0][0]], "runner_up_max": max([c for a, c in rivals.items() if a != rival] or [0]),
                  "others": [[a, c, [m["month"] for m, o in zip(months, owners) if o == a]] for a, c in rivals.most_common() if a != rival]}

    # one song, one day
    per_day = Counter((p["played_at"][:10], p["track_key"]) for p in listens)
    (d, k), n = per_day.most_common(1)[0]
    F_day_key = k
    those = [p for p in listens if p["played_at"].startswith(d) and p["track_key"] == k]
    F["day"] = {"song": song_index[k], "date": d, "count": n, "from": those[0]["played_at"][11:16], "to": those[-1]["played_at"][11:16],
                "hours": round(sum(p["ms_played"] for p in those) / 3.6e6, 1), "autoplayed": sum(p["reason_start"] == "trackdone" for p in those),
                "else": sum(1 for p in listens if p["played_at"].startswith(d)) - n}

    # night and day: which artists over-index after midnight (lift), and which in the daytime
    count = Counter(art(p) for p in listens)
    def lift(hours):
        sel = [p for p in listens if at(p).hour in hours]
        c = Counter(art(p) for p in sel)
        return sorted(((c[a] / len(sel)) / (count[a] / len(listens)), a) for a in count if count[a] >= 300)[::-1]
    F["night"] = [[artist_index[a], round(l, 1)] for l, a in lift({0, 1, 2, 3})[:3]]
    F["day_artist"] = [[artist_index[a], round(l, 1)] for l, a in lift(set(range(9, 17)))[:1]]

    # all-nighters: music in every hour from midnight to 6 AM, the same rule as /api/nights
    hours, nights = defaultdict(set), defaultdict(list)
    for p in listens:
        t = at(p)
        if t.hour <= 5:
            hours[t.date()].add(t.hour)
            nights[t.date()].append(p)
    alln = sorted(d for d, h in hours.items() if len(h) == 6)
    def night(d):
        ps = nights[d]
        k, c = Counter(p["track_key"] for p in ps).most_common(1)[0]
        return {"date": d.isoformat(), "weekday": d.strftime("%A"), "song": song_index[k], "times": c, "songs": sorted({song_index[p["track_key"]] for p in ps}),
                "five_am": song_index[[p for p in ps if at(p).hour == 5][-1]["track_key"]]}
    F["allnighters"] = {"count": len(alln), "by_era": Counter(era_of(d) for d in alln), "first": night(alln[0]), "latest": night(alln[-1]),
                        "top_month": Counter(d.strftime("%Y-%m") for d in alln).most_common(1)[0], "top_weekday": Counter(d.strftime("%A") for d in alln).most_common(1)[0]}
    # when the music usually stops: the last play before a quiet stretch of 3 to 20 hours that starts at night
    stops = Counter()
    for a, b in zip(listens, listens[1:]):
        gap = (at(b) - at(a)).total_seconds() / 3600
        if 3 <= gap <= 20 and (at(a).hour >= 21 or at(a).hour <= 4):
            stops[at(a).hour] += 1
    F["sleep"] = {"hours": [h for h, _ in stops.most_common(4)]}
    night_song = lambda sel: song_index[Counter(p["track_key"] for p in listens if at(p).hour <= 4 and sel(at(p).date())).most_common(1)[0][0]]
    F["night_song"] = {"high_school": night_song(lambda d: d < GRADUATED), "austin": night_song(lambda d: d >= MOVED_TO_AUSTIN),
                       "five_am": song_index[Counter(p["track_key"] for p in listens if at(p).hour in (4, 5)).most_common(1)[0][0]],
                       "five_am_times": Counter(p["track_key"] for p in listens if at(p).hour in (4, 5)).most_common(1)[0][1]}

    # the longest session
    sess = max(tables["dim_session"], key=lambda r: r["minutes"])
    sp = [p for p in listens if p["session_key"] == sess["session_key"]]
    sk, sc = Counter(p["track_key"] for p in sp).most_common(1)[0]
    sa, sac = Counter(art(p) for p in sp).most_common(1)[0]
    F["longest_session"] = {"start": sess["started_at"][:16], "end": sess["ended_at"][:16], "hours": round(sess["minutes"] / 60, 1), "listens": len(sp),
                            "song": song_index[sk], "song_times": sc, "artist": artist_index[sa], "artist_listens": sac}

    # eras: how college changed me, and how 2026 is changing me again
    first_heard = {}
    for p in listens:
        first_heard.setdefault(p["track_key"], at(p))
    eras = {}
    for e in ("high_school", "summer", "austin", "y2026"):
        ps = [p for p in listens if era_of(at(p).date()) == e]
        allp = [p for p in plays if era_of(at(p).date()) == e]
        moods_e = Counter(track[p["track_key"]]["mood"] for p in ps if track[p["track_key"]]["mood"])
        mt = sum(moods_e.values()) or 1
        ac = Counter(art(p) for p in ps)
        eras[e] = {"late": round(100 * sum(at(p).hour <= 4 for p in ps) / len(ps), 1), "desi": round(100 * sum(art(p) in desi for p in ps) / len(ps), 1),
                   "top_share": round(100 * ac[top] / len(ps), 1), "top5": [artist_index[a] for a, _ in ac.most_common(5)],
                   "upbeat": round(100 * (moods_e["party"] + moods_e["confident"]) / mt), "skip": round(100 * sum(p["skipped"] for p in allp) / len(allp), 1),
                   "per_day": round(len(ps) / len({at(p).date() for p in ps}), 1)}
    first_artist = {}
    for p in listens:
        first_artist.setdefault(art(p), at(p).date())
    newcomers = lambda e: [[artist_index[a], c] for a, c in Counter(art(p) for p in listens if era_of(at(p).date()) == e and era_of(first_artist[art(p)]) == e).most_common(3)]
    austin_first = next(p for p in listens if at(p).date() >= MOVED_TO_AUSTIN)
    F["eras"] = {"graduated": GRADUATED.isoformat(), "moved": MOVED_TO_AUSTIN.isoformat(), "stats": eras,
                 "austin_new": newcomers("austin"), "new_2026": newcomers("y2026"),
                 "austin_first": {"song": song_index[austin_first["track_key"]], "at": austin_first["played_at"][:16]},
                 "top_every_era": all(eras[e]["top5"][0] == artist_index[top] for e in eras)}
    years = sorted({at(p).year for p in listens})
    in_hours = lambda hs: [p for p in listens if at(p).hour in hs]
    F["desi_by_hour"] = {k: round(100 * sum(art(p) in desi for p in ps) / len(ps), 1) for k, ps in (("night", in_hours({0, 1, 2, 3})), ("day", in_hours(set(range(9, 17)))))}
    F["peak_hour"] = Counter(at(p).hour for p in listens).most_common(1)[0][0]
    F["desi_by_year"] = {y: round(100 * sum(art(p) in desi for p in listens if at(p).year == y) / sum(1 for p in listens if at(p).year == y), 1) for y in years}

    # the saddest month: the highest share of my heartbreak-tagged songs
    mm = defaultdict(Counter)
    for p in listens:
        if track[p["track_key"]]["mood"]:
            mm[p["played_at"][:7]][track[p["track_key"]]["mood"]] += 1
    share, month = max((c["heartbreak"] / sum(c.values()), m) for m, c in mm.items() if sum(c.values()) >= 200)
    F["heartbreak"] = {"month": month, "share": round(100 * share, 1)}

    # loyalty: songs I played every single year, and the one I played most
    years_of = defaultdict(set)
    for p in listens:
        years_of[p["track_key"]].add(at(p).year)
    loyal = [k for k, ys in years_of.items() if len(ys) == len(years)]
    lk = max(loyal, key=lambda k: sum(1 for p in listens if p["track_key"] == k))
    lm = Counter(p["played_at"][:7] for p in listens if p["track_key"] == lk).most_common(1)[0]
    F["loyal"] = {"count": len(loyal), "song": song_index[lk], "peak": lm[0], "peak_times": lm[1], "songs": sorted(song_index[k] for k in loyal)}

    # the comeback: the longest silence a song came back from, with at least 20 listens after
    times = defaultdict(list)
    for p in listens:
        times[p["track_key"]].append(at(p))
    best = max(((ts[i] - ts[i - 1]).days, k, i) for k, ts in times.items() for i in range(1, len(ts)) if len(ts) - i >= 20)
    gap, k, i = best
    F["comeback"] = {"song": song_index[k], "gap_days": gap, "back": times[k][i].date().isoformat(), "after": len(times[k]) - i}

    # skip, but can't quit: the most-skipped artist I still played 150+ times
    tot, sk_ = Counter(), Counter()
    for p in plays:
        tot[art(p)] += 1
        sk_[art(p)] += p["skipped"]
    skr = max((sk_[a] / tot[a], a) for a in count if count[a] >= 150)[1]
    sp = [p for p in plays if art(p) == skr]
    skipped_ms = sorted(p["ms_played"] for p in sp if p["skipped"])
    by_song = Counter(p["track_key"] for p in sp)
    F["skip"] = {"artist": artist_index[skr], "plays": len(sp), "listens": count[skr], "rate": round(100 * sk_[skr] / tot[skr]),
                 "median_seconds": round(skipped_ms[len(skipped_ms) // 2] / 1000, 1), "arrived_by_skip": sum(p["reason_start"] == "fwdbtn" for p in sp),
                 "songs": [[song_index[k] if k in song_index else None, n, round(100 * sum(p["skipped"] for p in sp if p["track_key"] == k) / n)] for k, n in by_song.most_common(3)]}

    # explorer or loyalist: new artists per year, and how much of each year went to songs from earlier years
    F["discovery"] = {y: {"new_artists": sum(1 for d in first_artist.values() if d.year == y),
                          "comfort": round(100 * sum(first_heard[p["track_key"]].year < y for p in listens if at(p).year == y) / sum(1 for p in listens if at(p).year == y), 1),
                          "hours": round(sum(p["ms_played"] for p in listens if at(p).year == y) / 3.6e6)} for y in years}
    # when she listens: the share of listens in each hour, mornings, and how mornings feel
    by_hour = Counter(at(p).hour for p in listens)
    F["hours"] = [round(100 * by_hour[h] / len(listens), 1) for h in range(24)]
    F["before_9"] = round(100 * sum(by_hour[h] for h in range(0, 9) if h >= 5) / len(listens), 1)
    def heartbreak_share(sel):
        tagged = [p for p in listens if sel(at(p).hour) and track[p["track_key"]]["mood"]]
        return round(100 * sum(track[p["track_key"]]["mood"] == "heartbreak" for p in tagged) / len(tagged), 1)
    F["morning_heartbreak"] = {"morning": heartbreak_share(lambda h: 5 <= h <= 11), "rest": heartbreak_share(lambda h: not 5 <= h <= 11)}

    # homework hour: the busiest weekday hour, and how much of weekday listening lands there, by era
    def weekday_peak(e):
        ps = [p for p in listens if at(p).weekday() < 5 and era_of(at(p).date()) == e]
        h, n = Counter(at(p).hour for p in ps).most_common(1)[0]
        return {"hour": h, "share": round(100 * n / len(ps), 1), "three_to_eight": round(100 * sum(15 <= at(p).hour <= 19 for p in ps) / len(ps), 1)}
    F["weekday_peak"] = {e: weekday_peak(e) for e in ("high_school", "austin", "y2026")}
    F["weekend_peak"] = Counter(at(p).hour for p in listens if at(p).weekday() >= 5).most_common(1)[0][0]

    # album days: the first time she heard most of an album in a single day (catalog deep-dives and release nights)
    album_of = {t["track_key"]: t["album_key"] for t in tables["dim_track"]}
    album_name = {a["album_key"]: a["album_name"] for a in tables["dim_album"]}
    firsts = {}
    for p in listens:
        firsts.setdefault(p["track_key"], p)
    days = Counter((p["played_at"][:10], album_of[k], art(p)) for k, p in firsts.items())
    def album_day(d, al, a):
        new = sorted((firsts[k] for k in firsts if album_of[k] == al and firsts[k]["played_at"][:10] == d), key=lambda p: p["played_at"])
        return {"date": d, "album": album_name[al], "artist": artist_index[a], "new_songs": len(new), "first_at": new[0]["played_at"][11:16], "song": song_index[new[0]["track_key"]]}
    F["album_days"] = [album_day(d, al, a) for (d, al, a), n in sorted(days.items()) if n >= 6 and a in (top, next(k for k, v in artist_index.items() if v == rival))]

    # the rival's reign: the albums and the song she played most while writing college essays (June to December 2023)
    rival_key = next(k for k, v in artist_index.items() if v == rival)
    reign = [p for p in listens if "2023-06" <= p["played_at"][:7] <= "2023-12" and art(p) == rival_key]
    F["taylor_favs"] = [[album_name[a], n] for a, n in Counter(album_of[p["track_key"]] for p in reign).most_common(2)]
    F["taylor_song"] = song_index[Counter(p["track_key"] for p in reign).most_common(1)[0][0]]

    # the homework soundtrack: what played most on high-school weekdays between 3 and 8 PM
    F["homework"] = [song_index[k] for k, _ in Counter(p["track_key"] for p in listens if at(p).date() < GRADUATED and at(p).weekday() < 5 and 15 <= at(p).hour <= 19).most_common(4)]

    # first semester in Austin: the new party and confident songs, and the new song played most (whatever it was)
    first_day = {}
    for p in listens:
        first_day.setdefault(p["track_key"], at(p).date())
    sem = Counter(p["track_key"] for p in listens if MOVED_TO_AUSTIN <= at(p).date() <= date(2024, 12, 31) and first_day[p["track_key"]] >= MOVED_TO_AUSTIN)
    feel = lambda k: song_rows[song_index[k]][12] or song_rows[song_index[k]][13]
    F["fall2024"] = {"party": [song_index[k] for k, _ in sem.most_common() if feel(k) in ("party", "confident")][:4], "top_new": song_index[sem.most_common(1)[0][0]]}

    # favorites: the songs she hits back on, the song that opens her sessions, the songs that close her nights
    F["rewound"] = [[song_index[k], n] for k, n in Counter(p["track_key"] for p in plays if p["reason_start"] == "backbtn" and p["track_key"] in song_index).most_common(3)]
    sessions = defaultdict(list)
    for p in listens:
        sessions[p["session_key"]].append(p)
    F["opener"] = [[song_index[k], n] for k, n in Counter(v[0]["track_key"] for v in sessions.values() if len(v) >= 5).most_common(1)][0]
    F["closers"] = [[song_index[k], n] for k, n in Counter(v[-1]["track_key"] for v in sessions.values() if len(v) >= 5 and (at(v[-1]).hour >= 21 or at(v[-1]).hour <= 4)).most_common(2)]

    # phone down: instrumentals of my #1 artist, played start to finish
    inst = [p for p in listens if "instrumental" in track[p["track_key"]]["track_name"].lower() and art(p) == top]
    F["instrumentals"] = {"count": len(inst), "by_year": Counter(at(p).year for p in inst), "songs": sorted({song_index[p["track_key"]] for p in inst})}

    # trips home: offline hours on the flight days, and how much South Asian music she played while there
    F["trips"] = []
    for a, b in TRIPS:
        ps = [p for p in listens if a <= at(p).date() <= b]
        F["trips"].append({"from": a.isoformat(), "to": b.isoformat(), "listens": len(ps), "desi": round(100 * sum(art(p) in desi for p in ps) / len(ps), 1),
                           "flight_hours": [round(max(offline.get((a + timedelta(days=i)).isoformat(), 0) for i in (-1, 0, 1)) / 3.6e6, 1), round(max(offline.get((b + timedelta(days=i)).isoformat(), 0) for i in (-1, 0, 1)) / 3.6e6, 1)],
                           "songs": [song_index[k] for k, _ in Counter(p["track_key"] for p in ps).most_common(3)], "all": sorted({song_index[p["track_key"]] for p in ps})})
    F["desi_overall"] = round(100 * sum(art(p) in desi for p in listens) / len(listens), 1)

    # albums in order: the most predictable "next song", and whether it came from the album's own track order
    album = {t["track_key"]: t["album_key"] for t in tables["dim_track"]}
    nxt, how = defaultdict(Counter), defaultdict(Counter)
    for a, b in zip(listens, listens[1:]):
        if a["session_key"] == b["session_key"] and a["track_key"] != b["track_key"]:
            nxt[a["track_key"]][b["track_key"]] += 1
            how[(a["track_key"], b["track_key"])][(b["reason_start"] == "trackdone", b["shuffle"])] += 1
    n_of = Counter(p["track_key"] for p in listens)
    rows = sorted(((c.most_common(1)[0][1] / n_of[a], a, c.most_common(1)[0][0], c.most_common(1)[0][1]) for a, c in nxt.items() if n_of[a] >= 40), reverse=True)
    F["in_order"] = [{"a": song_index[a], "b": song_index[b], "pct": round(100 * r), "times": k, "same_album": album[a] == album[b],
                      "auto": round(100 * sum(v for (auto, _), v in how[(a, b)].items() if auto) / k), "shuffled": sum(v for (_, sh), v in how[(a, b)].items() if sh)} for r, a, b, k in rows[:12]]

    # moods by month: saddest, happiest and most in love (my hand tags), and the saddest month of the calendar
    mm = defaultdict(Counter)
    for p in listens:
        if track[p["track_key"]]["mood"]:
            mm[p["played_at"][:7]][track[p["track_key"]]["mood"]] += 1
    big = {m: c for m, c in mm.items() if sum(c.values()) >= 200}
    pct = lambda c, ks: round(100 * sum(c[k] for k in ks) / sum(c.values()))
    SAD, HAPPY = ("heartbreak", "dark", "bittersweet"), ("party", "confident")
    F["moods"] = {"saddest": sorted(([m, pct(c, SAD)] for m, c in big.items()), key=lambda x: -x[1])[:3],
                  "happiest": sorted(([m, pct(c, HAPPY)] for m, c in big.items()), key=lambda x: -x[1])[:4],
                  "in_love": sorted(([m, pct(c, ("love",))] for m, c in big.items()), key=lambda x: -x[1])[:2],
                  "typical_sad": sorted(pct(c, SAD) for c in big.values())[len(big) // 2]}
    cal = defaultdict(list)
    for m, c in big.items():
        cal[m[5:]].append(pct(c, SAD))
    F["moods"]["sad_calendar"] = max(((round(sum(v) / len(v)), k) for k, v in cal.items()))[::-1]
    F["moods"]["octobers"] = [[m, pct(c, SAD)] for m, c in sorted(big.items()) if m.endswith("-10")]

    # how she finds music: half the songs she ever heard, she reached by skipping the one before
    first_play = {}
    for p in plays:
        first_play.setdefault(p["track_key"], p)
    F["discover"] = {"by_skip": round(100 * sum(p["reason_start"] == "fwdbtn" for p in first_play.values()) / len(first_play)),
                     "chosen": round(100 * sum(p["reason_start"] == "clickrow" for p in first_play.values()) / len(first_play)),
                     "chose_by_era": {e: round(100 * sum(p["reason_start"] == "clickrow" for p in plays if era_of(at(p).date()) == e) / sum(1 for p in plays if era_of(at(p).date()) == e), 1) for e in ("high_school", "summer", "austin", "y2026")},
                     "shuffle_by_era": {e: round(100 * sum(p["shuffle"] for p in plays if era_of(at(p).date()) == e) / sum(1 for p in plays if era_of(at(p).date()) == e), 1) for e in ("high_school", "summer", "austin", "y2026")}}

    # holiday songs far from the holidays
    xmas = [p for p in listens if any(w in track[p["track_key"]]["track_name"].lower() for w in ("christmas", "santa", "mistletoe", "jingle", "sleigh")) and at(p).month in (3, 4, 5, 6, 7, 8)]
    if xmas:
        (k, m), n = Counter((p["track_key"], p["played_at"][:7]) for p in xmas).most_common(1)[0]
        F["off_season"] = {"song": song_index[k], "month": m, "times": n}
    # the loop year: how often the next listen is the same song again
    F["loops"] = {y: round(100 * sum(a["track_key"] == b["track_key"] for a, b in zip(ys, ys[1:])) / len(ys), 1) for y in sorted({at(p).year for p in listens}) for ys in [[p for p in listens if at(p).year == y]]}
    # extra detail for the tour, so every sentence can name real songs
    top_ps = [p for p in listens if art(p) == top]
    active = {at(p).date() for p in listens}
    F["top_detail"] = {"days_nonstop": round(sum(p["ms_played"] for p in top_ps) / 8.64e7, 1), "songs": len({p["track_key"] for p in top_ps}),
                       "days_share": round(100 * len({at(p).date() for p in top_ps}) / len(active)), "per_day": round(len(top_ps) / len({at(p).date() for p in top_ps})),
                       "albums": [[album_name[a], n] for a, n in Counter(album_of[p["track_key"]] for p in top_ps).most_common(3)]}
    F["taylor_album_songs"] = {album_name[a]: [song_index[k] for k, _ in Counter(p["track_key"] for p in listens if album_of[p["track_key"]] == a and art(p) == rival_key).most_common(2)]
                               for a, _ in Counter(album_of[p["track_key"]] for p in reign).most_common(2)}
    day_title = clean_title(track[F_day_key]["track_name"])
    versions = [p for p in listens if clean_title(track[p["track_key"]]["track_name"]) == day_title and art(p) == art(next(q for q in listens if q["track_key"] == F_day_key))]
    F["day"]["all_versions"] = len(versions)
    F["day"]["since"] = sum(1 for p in versions if p["played_at"][:10] > F["day"]["date"])
    night_artist = next(k for k, v in artist_index.items() if v == F["night"][0][0])
    na = Counter(p["track_key"] for p in listens if art(p) == night_artist)
    F["night_artist"] = {"first": min(p["played_at"][:10] for p in listens if art(p) == night_artist), "listens": sum(na.values()), "song": song_index[na.most_common(1)[0][0]], "song_times": na.most_common(1)[0][1]}
    for t in F["trips"]:
        a0, b0 = date.fromisoformat(t["from"]), date.fromisoformat(t["to"])
        ps = [p for p in listens if a0 <= at(p).date() <= b0]
        t["artists"] = [artist_index[a] for a, _ in Counter(art(p) for p in ps).most_common(8)]
        al, n = Counter(album_of[p["track_key"]] for p in ps).most_common(1)[0]
        t["album"] = [album_name[al], n]
    F["fall2024"]["newcomers"] = [[artist_index[a], song_index[Counter(p["track_key"] for p in listens if art(p) == a).most_common(1)[0][0]]] for a in
                                  [next(k for k, v in artist_index.items() if v == x[0]) for x in F["eras"]["austin_new"]]]
    F["heartbreak"]["songs"] = [song_index[k] for k, _ in Counter(p["track_key"] for p in listens if p["played_at"].startswith(F["heartbreak"]["month"])).most_common(2)]
    y_last = max(at(p).year for p in listens)
    F["year_now"] = {"songs": [song_index[k] for k, _ in Counter(p["track_key"] for p in listens if at(p).year == y_last).most_common(5)]}
    newbie = next(k for k, v in artist_index.items() if v == F["eras"]["new_2026"][0][0])
    F["eras"]["new_2026_first"] = min(p["played_at"][:10] for p in listens if art(p) == newbie)

    # the quirks file: holidays, loops, versions, skips and naps
    def day_top(d):
        ps = [p for p in listens if at(p).date() == d]
        if not ps:
            return None
        c = Counter(p["track_key"] for p in ps)
        k, n = c.most_common(1)[0]
        return {"date": d.isoformat(), "song": song_index[k], "times": n, "of": len(ps), "tied": [song_index[t] for t, m in c.items() if m == n and t != k]}
    years = sorted({at(p).year for p in listens})
    Q = {"halloween": max(filter(None, (day_top(date(y, 10, 31)) for y in years)), key=lambda x: x["times"] / x["of"] + x["times"] / 100),
         "valentines": max(filter(None, (day_top(date(y, 2, 14)) for y in years)), key=lambda x: x["times"])}
    ny = [p for p in listens if at(p).month == 1 and at(p).day == 1 and at(p).hour == 0 and at(p).minute < 5]
    if ny:
        Q["new_year"] = {"song": song_index[ny[0]["track_key"]], "at": ny[0]["played_at"][:16]}
    runs, run = [], 1
    for a, b in zip(listens, listens[1:]):
        if a["track_key"] == b["track_key"] and (at(b) - at(a)).total_seconds() < 3600:
            run += 1
        else:
            runs.append((run, a["track_key"], a["played_at"][:10]))
            run = 1
    Q["loops"] = [[song_index[k], n, d] for n, k, d in sorted(runs, reverse=True)[1:3]]
    hour_runs = Counter((p["played_at"][:13], p["track_key"]) for p in listens)
    (h, k), n = hour_runs.most_common(1)[0]
    Q["one_hour"] = {"song": song_index[k], "times": n, "date": h[:10]}
    starts, skips = Counter(), Counter()
    for p in plays:
        starts[p["track_key"]] += 1
        skips[p["track_key"]] += p["skipped"]
    r, n, k = max((skips[k] / starts[k], starts[k], k) for k in starts if starts[k] >= 100 and k in song_index)
    Q["never_finished"] = {"song": song_index[k], "starts": n, "rate": round(100 * r)}
    Q["naps"] = sum(p["reason_end"] == "unexpected-exit-while-paused" for p in plays)
    Q["summer_xmas"] = sum(1 for p in listens if at(p).month in (6, 7, 8) and any(w in track[p["track_key"]]["track_name"].lower() for w in ("christmas", "santa", "mistletoe", "jingle", "sleigh")))
    per_artist = Counter(art(p) for p in listens)
    Q["one_listen_artists"] = sum(1 for n in per_artist.values() if n == 1)
    name = lambda p: track[p["track_key"]]["track_name"].lower()
    sped = Counter(p["track_key"] for p in listens if "sped up" in name(p))
    Q["sped_up"] = [song_index[sped.most_common(1)[0][0]], sped.most_common(1)[0][1]] if sped else None
    Q["karaoke"] = sorted({song_index[p["track_key"]] for p in listens if "karaoke" in name(p)})
    hsm = Counter(p["track_key"] for p in listens if "high school musical" in name(p))
    Q["hsm"] = [song_index[hsm.most_common(1)[0][0]], sum(hsm.values())] if hsm else None
    Q["valentines_by_year"] = [{"year": y, **(day_top(date(y, 2, 14)) or {"song": None, "times": 0, "of": 0}),
                                "songs": sorted({song_index[p["track_key"]] for p in listens if at(p).date() == date(y, 2, 14)})}
                               for y in years if date(y, 2, 14) >= at(listens[0]).date()]
    F["quirks"] = Q

    per_song_days = defaultdict(set)
    for p in listens:
        per_song_days[p["track_key"]].add(at(p).date())
    # the longest daily streak of any song (gaps and islands, as in v_song_streaks)
    best = (0, None, None)
    for k, ps in per_song_days.items():
        n, start = longest_streak(ps)
        if n > best[0]:
            best = (n, k, start)
    F["streak"] = {"days": best[0], "song": song_index[best[1]], "from": best[2].isoformat(), "to": (best[2] + timedelta(days=best[0] - 1)).isoformat()}

    # her day as a playlist: the song that owns each hour, leaving out my #1 artist so everyone else gets a turn
    F["clock"] = [[h, [song_index[k] for k, _ in Counter(p["track_key"] for p in listens if at(p).hour == h and art(p) != top).most_common(10)]] for h in range(24)]

    # mood swings: a heartbreak or dark song straight into a party or confident one (or back), inside one session,
    # using my hand tags and the inferred moods
    feel_of = lambda k: song_rows[song_index[k]][12] or song_rows[song_index[k]][13]
    SAD, UP = ("heartbreak", "dark"), ("party", "confident")
    ups, downs = Counter(), Counter()
    for a, b in zip(listens, listens[1:]):
        if a["session_key"] != b["session_key"] or a["track_key"] == b["track_key"]:
            continue
        fa, fb = feel_of(a["track_key"]), feel_of(b["track_key"])
        if fa in SAD and fb in UP:
            ups[(song_index[a["track_key"]], song_index[b["track_key"]])] += 1
        elif fa in UP and fb in SAD:
            downs[(song_index[a["track_key"]], song_index[b["track_key"]])] += 1
    swing_days = len({at(p).date() for p in listens})
    F["mood_swings"] = {"total": sum(ups.values()) + sum(downs.values()), "comebacks": sum(ups.values()), "crashes": sum(downs.values()),
                        "per_day": round((sum(ups.values()) + sum(downs.values())) / swing_days, 1),
                        "up": [[a, b, n] for (a, b), n in ups.most_common(150) if n >= 3], "down": [[a, b, n] for (a, b), n in downs.most_common(150) if n >= 3]}
    return F


def export(tables: dict, records: int, song_records: int, private: int, offline: dict) -> dict:
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

    tour_facts = facts(tables, listens, song_index, artist_index, track, artist_name, desi, months, offline, songs)
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
        "facts": tour_facts,
    }


def offline_by_day(records: list) -> dict:
    """Milliseconds listened offline per Austin day, dated by when the song actually played (long offline days are flights)."""
    from pipeline import AUSTIN
    days = Counter()
    for r in records:
        if r.get("offline") and r.get("offline_timestamp") and not r.get("incognito_mode") and r["ms_played"] >= 30000:
            ts = r["offline_timestamp"] / 1000 if r["offline_timestamp"] > 1e11 else r["offline_timestamp"]
            days[datetime.fromtimestamp(ts, AUSTIN).date().isoformat()] += r["ms_played"]
    return days


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
    data = export(tables, len(records), len(song_records), sum(bool(r.get("incognito_mode")) for r in song_records), offline_by_day(song_records))
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    t = data["totals"]
    print(f"{t['listens']:,} listens -> {t['songs']:,} stars in {t['artists']:,} constellations, "
          f"{t['links']:,} links, {len(data['story'])} story chapters ({args.out.stat().st_size / 1024:,.0f} KB)")


if __name__ == "__main__":
    main()
