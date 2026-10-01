"""
Listening History: the web app.

A small FastAPI server over the star schema. Every endpoint is one SQL question (see sql/insights.sql),
answered once and cached: the history only changes when the pipeline reloads it.

    uvicorn app.main:app --reload        (needs DATABASE_URL)
"""

import asyncio
from collections import Counter
import os
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

STATIC = Path(__file__).parent / "static"
pool: ConnectionPool = None
_cache: dict = {}


@asynccontextmanager
async def lifespan(_app):
    global pool
    pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, kwargs={"row_factory": dict_row})
    yield
    pool.close()


app = FastAPI(title="Listening History", lifespan=lifespan, docs_url="/api/docs", redoc_url=None)


def plain(value):
    """JSON-friendly values: dates as ISO strings, Decimals as numbers."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def query(key: str, sql: str, params: tuple = ()) -> list:
    if key not in _cache:
        with pool.connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        _cache[key] = [{k: plain(v) for k, v in r.items()} for r in rows]
    return _cache[key]


@app.get("/api/summary")
def summary():
    totals = query("summary", """
        SELECT ROUND(SUM(minutes) / 60) AS hours, COUNT(*) AS listens,
               COUNT(DISTINCT track_key) AS songs, COUNT(DISTINCT artist_key) AS artists,
               MIN(full_date) AS first_day, MAX(full_date) AS last_day,
               (SELECT COUNT(*) FROM dim_session) AS sessions
        FROM v_listen""")[0]
    top = query("top-song", """
        SELECT track_name, artist_name, COUNT(*) AS listens FROM v_listen
        GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 1""")[0]
    top_artist = query("top-artist", """
        SELECT artist_name, ROUND(SUM(minutes) / 60) AS hours FROM v_listen
        GROUP BY artist_name ORDER BY hours DESC LIMIT 1""")[0]
    return {**totals, "top_song": top, "top_artist": top_artist}


@app.get("/api/months")
def months():
    """Every month: who owned it, their share, total hours, and the song of the month."""
    return query("months", """
        WITH hours AS (
            SELECT date_trunc('month', full_date)::date AS month, SUM(minutes) / 60 AS hours
            FROM v_listen GROUP BY 1
        ), song AS (
            SELECT DISTINCT ON (month) month, track_name, artist_name, listens FROM (
                SELECT date_trunc('month', full_date)::date AS month, track_name, artist_name, COUNT(*) AS listens
                FROM v_listen GROUP BY 1, track_key, track_name, artist_name) s
            ORDER BY month, listens DESC
        ), era AS (
            SELECT DISTINCT ON (month) month, artist_name, share_pct FROM v_monthly_eras ORDER BY month, minutes DESC
        )
        SELECT e.month, e.artist_name AS era_artist, e.share_pct, ROUND(h.hours, 1) AS hours,
               s.track_name AS song, s.artist_name AS song_artist, s.listens AS song_listens
        FROM era e JOIN hours h USING (month) JOIN song s USING (month)
        ORDER BY e.month""")


@app.get("/api/month/{month}")
def month_top(month: str):
    """The five songs I played most in one month (month = YYYY-MM)."""
    if not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", month):
        raise HTTPException(400, "month must look like 2024-04")
    return query(f"month:{month}", """
        SELECT track_name, artist_name, COUNT(*) AS listens
        FROM v_listen WHERE date_trunc('month', full_date) = %s::date
        GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 5""", (f"{month}-01",))


@app.get("/api/clock")
def clock():
    return query("clock", "SELECT year, hour, share_pct FROM v_listening_clock ORDER BY year, hour")


@app.get("/api/streaks")
def streaks():
    return query("streaks", """
        SELECT track_name, artist_name, days_in_a_row, started, ended FROM v_song_streaks
        ORDER BY days_in_a_row DESC, started LIMIT 8""")


@app.get("/api/years")
def years():
    return query("years", "SELECT * FROM v_year_in_review ORDER BY year")


@app.get("/api/obsessions")
def obsessions():
    return query("obsessions", """
        SELECT track_name, artist_name, first_listen, days_to_obsession FROM v_first_listen_to_obsession
        WHERE track_name !~* 'instrumental' ORDER BY days_to_obsession, first_listen LIMIT 6""")


@app.get("/api/skips")
def skips():
    most = query("skips-most", "SELECT * FROM v_skip_rate ORDER BY skip_pct DESC LIMIT 5")
    least = query("skips-least", "SELECT * FROM v_skip_rate ORDER BY skip_pct LIMIT 5")
    return {"most": most, "least": least}


@app.get("/api/skip-rates")
def skip_rates():
    """Skip rate for every artist I've played 200+ times."""
    return query("skip-rates", "SELECT * FROM v_skip_rate ORDER BY skip_pct")


@app.get("/api/days")
def big_days():
    return query("days", "SELECT * FROM v_most_in_a_day ORDER BY listens DESC LIMIT 5")


@app.get("/api/dynasty")
def dynasty():
    """Every month's #1 artist, their share, the runner-up, and the month's top song."""
    return query("dynasty", """
        WITH per_artist AS (
            SELECT date_trunc('month', full_date)::date AS month, artist_name, SUM(minutes) AS minutes
            FROM v_listen GROUP BY 1, 2
        ), ranked AS (
            SELECT month, artist_name, ROUND(100 * minutes / SUM(minutes) OVER (PARTITION BY month), 1) AS share_pct,
                   ROW_NUMBER() OVER (PARTITION BY month ORDER BY minutes DESC) AS place
            FROM per_artist
        ), song AS (
            SELECT DISTINCT ON (month) month, track_name, artist_name, listens FROM (
                SELECT date_trunc('month', full_date)::date AS month, track_name, artist_name, COUNT(*) AS listens
                FROM v_listen GROUP BY 1, track_key, track_name, artist_name) s
            ORDER BY month, listens DESC
        )
        SELECT w.month, w.artist_name AS winner, w.share_pct,
               r.artist_name AS runner_up, r.share_pct AS runner_up_pct,
               s.track_name AS song, s.artist_name AS song_artist, s.listens AS song_listens
        FROM ranked w
        LEFT JOIN ranked r ON r.month = w.month AND r.place = 2
        JOIN song s ON s.month = w.month
        WHERE w.place = 1
        ORDER BY w.month""")


@app.get("/api/discovery")
def discovery():
    """Do I actually discover new music? New artists and songs each year, and how much of my listening went to them."""
    return query("discovery", """
        WITH first_song AS (SELECT track_key, MIN(year) AS y FROM v_listen GROUP BY track_key),
        first_artist AS (SELECT artist_key, MIN(year) AS y FROM v_listen GROUP BY artist_key)
        SELECT v.year,
               COUNT(DISTINCT v.artist_key) FILTER (WHERE fa.y = v.year) AS new_artists,
               COUNT(DISTINCT v.artist_key) AS artists,
               COUNT(DISTINCT v.track_key) FILTER (WHERE fs.y = v.year) AS new_songs,
               COUNT(DISTINCT v.track_key) AS songs,
               ROUND(100.0 * COUNT(*) FILTER (WHERE fs.y = v.year) / COUNT(*), 1) AS new_song_share,
               ROUND(100.0 * COUNT(*) FILTER (WHERE fa.y = v.year) / COUNT(*), 1) AS new_artist_share
        FROM v_listen v
        JOIN first_song fs USING (track_key)
        JOIN first_artist fa USING (artist_key)
        GROUP BY v.year ORDER BY v.year""")


@app.get("/api/loyalty")
def loyalty():
    """How loyal I am: my #1 artist each year, what I played every single year, and how concentrated my listening is."""
    yearly = query("loyal-yearly", """
        SELECT DISTINCT ON (year) year, artist_name, ROUND(SUM(minutes) / 60) AS hours
        FROM v_listen GROUP BY year, artist_name ORDER BY year, SUM(minutes) DESC""")
    numbers = query("loyal-numbers", """
        WITH years AS (SELECT COUNT(DISTINCT year) AS n FROM v_listen),
        top_artist AS (SELECT artist_key FROM v_listen GROUP BY artist_key ORDER BY SUM(minutes) DESC LIMIT 1),
        artist_minutes AS (SELECT artist_key, SUM(minutes) AS m, COUNT(*) AS listens FROM v_listen GROUP BY artist_key)
        SELECT
            (SELECT n FROM years) AS years,
            (SELECT COUNT(*) FROM (SELECT artist_key FROM v_listen GROUP BY artist_key
                HAVING COUNT(DISTINCT year) = (SELECT n FROM years)) a) AS artists_every_year,
            (SELECT COUNT(*) FROM (SELECT track_key FROM v_listen GROUP BY track_key
                HAVING COUNT(DISTINCT year) = (SELECT n FROM years)) t) AS songs_every_year,
            (SELECT COUNT(DISTINCT full_date) FROM v_listen WHERE artist_key = (SELECT artist_key FROM top_artist)) AS top_artist_days,
            (SELECT COUNT(DISTINCT full_date) FROM v_listen) AS listening_days,
            (SELECT ROUND(100 * SUM(m) FILTER (WHERE r <= 10) / SUM(m), 1)
                FROM (SELECT m, RANK() OVER (ORDER BY m DESC) AS r FROM artist_minutes) x) AS top10_share,
            (SELECT COUNT(*) FROM artist_minutes WHERE listens = 1) AS one_listen_artists,
            (SELECT COUNT(*) FROM artist_minutes) AS artists""")[0]
    songs = query("loyal-songs", """
        WITH every_year AS (
            SELECT track_key FROM v_listen GROUP BY track_key
            HAVING COUNT(DISTINCT year) = (SELECT COUNT(DISTINCT year) FROM v_listen)
        ), ranked AS (
            SELECT DISTINCT ON (artist_name) track_name, artist_name, COUNT(*) AS listens
            FROM v_listen WHERE track_key IN (SELECT track_key FROM every_year)
            GROUP BY track_key, track_name, artist_name ORDER BY artist_name, COUNT(*) DESC
        )
        SELECT * FROM ranked ORDER BY listens DESC LIMIT 6""")
    return {"yearly": yearly, **numbers, "songs": songs}


@app.get("/api/top-artists")
def top_artists():
    """My ten most-listened artists by hours."""
    return query("top-artists", ARTIST_TOTALS_TOP)


@app.get("/api/top-songs")
def top_songs():
    """My 40 most-played songs, for the "which did I play more?" game."""
    return query("top-songs", """
        SELECT track_name, artist_name, COUNT(*) AS listens FROM v_listen
        GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 40""")


ARTIST_TOTALS = """
    WITH totals AS (
        SELECT artist_key, artist_name, COUNT(*) AS listens, ROUND(SUM(minutes) / 60, 1) AS hours,
               MIN(full_date) AS first_listen, RANK() OVER (ORDER BY SUM(minutes) DESC) AS rank
        FROM v_listen GROUP BY artist_key, artist_name
    )"""


ARTIST_TOTALS_TOP = ARTIST_TOTALS + " SELECT artist_name, listens, hours FROM totals ORDER BY rank LIMIT 10"


@app.get("/api/artist-names")
def artist_names():
    """The 400 artists I listen to most, for the search box suggestions."""
    return [r["artist_name"] for r in query("artist-names", ARTIST_TOTALS + " SELECT artist_name FROM totals ORDER BY rank LIMIT 400")]


@app.get("/api/artist")
def artist(name: str = Query(min_length=2, max_length=80)):
    """Do I listen to your favorite artist? Exact name first, then the closest partial match."""
    wanted = " ".join(name.split())
    key = "artist:" + wanted.lower()
    if key not in _cache and len(_cache) > 2000:
        _cache.pop(next(k for k in _cache if k.startswith("artist:")), None)
    pattern = "%" + re.sub(r"([%_\\])", r"\\\1", wanted) + "%"
    found = query(key, ARTIST_TOTALS + """
        SELECT t.*, (SELECT COUNT(*) FROM totals) AS of_artists,
               s.track_name AS top_song, s.listens AS top_song_listens
        FROM totals t
        CROSS JOIN LATERAL (
            SELECT track_name, COUNT(*) AS listens FROM v_listen v
            WHERE v.artist_key = t.artist_key GROUP BY track_key, track_name ORDER BY listens DESC LIMIT 1) s
        WHERE t.artist_name ILIKE %s
        ORDER BY lower(t.artist_name) = lower(%s) DESC, t.rank LIMIT 1""", (pattern, wanted))
    return found[0] if found else {"artist_name": wanted, "listens": 0}


async def itunes(client: httpx.AsyncClient, title: str, artist: str, entity: str) -> Optional[dict]:
    """The first iTunes result whose artist and title really match mine."""
    try:
        r = await client.get("https://itunes.apple.com/search",
                             params={"term": f"{title} {artist}", "entity": entity, "limit": 10, "country": "US"})
        want_t, want_a = clean(title), clean(artist)
        for item in r.json().get("results", []):
            got_t, got_a = clean(item.get("trackName", "")), clean(item.get("artistName", ""))
            if item.get("previewUrl") and (want_a in got_a or got_a in want_a) and (got_t.startswith(want_t) or want_t.startswith(got_t)):
                return item
    except (httpx.HTTPError, ValueError):
        pass
    return None


@app.get("/api/videos")
async def videos():
    """Music video previews (iTunes) for my most-played songs: up to eight, no more than three per artist."""
    if "videos" not in _cache:
        songs = query("top-songs-50", """
            SELECT track_name, artist_name, COUNT(*) AS listens FROM v_listen
            GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 50""")
        gate = asyncio.Semaphore(6)                     # stay polite to the iTunes API

        async def find(client, s):
            async with gate:
                return await itunes(client, s["track_name"], s["artist_name"], "musicVideo")

        async with httpx.AsyncClient(timeout=8) as client:
            found = await asyncio.gather(*(find(client, s) for s in songs))
        picked, per_artist = [], Counter()
        for s, v in zip(songs, found):
            if v and per_artist[s["artist_name"]] < 3 and len(picked) < 8:
                per_artist[s["artist_name"]] += 1
                picked.append({**s, "video": v["previewUrl"], "poster": v.get("artworkUrl100", "").replace("100x100bb", "600x338bb")})
        if len(picked) < 4:                             # iTunes had a bad moment; try again next visit
            return picked
        _cache["videos"] = picked
    return _cache["videos"]

# ---------- life stories: one song, one artist, one year, one stretch of time ----------

LIFE = """
    days AS (SELECT DISTINCT full_date FROM p),
    isl AS (SELECT full_date - (ROW_NUMBER() OVER (ORDER BY full_date))::int AS g FROM days),
    gaps AS (SELECT full_date, full_date - LAG(full_date) OVER (ORDER BY full_date) AS gap FROM days),
    by_day AS (SELECT full_date, COUNT(*) AS n FROM p GROUP BY full_date),
    by_month AS (SELECT to_char(date_trunc('month', full_date), 'YYYY-MM') AS m, COUNT(*) AS n FROM p GROUP BY 1)
    SELECT
        (SELECT COUNT(*) FROM p) AS listens,
        (SELECT MIN(full_date) FROM p) AS first_listen,
        (SELECT MAX(full_date) FROM p) AS last_listen,
        (SELECT full_date FROM by_day ORDER BY n DESC, full_date LIMIT 1) AS peak_day,
        (SELECT MAX(n) FROM by_day) AS peak_day_plays,
        (SELECT m FROM by_month ORDER BY n DESC, m LIMIT 1) AS peak_month,
        (SELECT MAX(n) FROM by_month) AS peak_month_plays,
        (SELECT MAX(c) FROM (SELECT COUNT(*) AS c FROM isl GROUP BY g) x) AS longest_streak,
        (SELECT gap FROM gaps ORDER BY gap DESC NULLS LAST LIMIT 1) AS longest_gap,
        (SELECT full_date - gap FROM gaps ORDER BY gap DESC NULLS LAST LIMIT 1) AS gap_from,
        (SELECT full_date FROM gaps ORDER BY gap DESC NULLS LAST LIMIT 1) AS gap_to,
        (SELECT json_object_agg(m, n) FROM by_month) AS by_month"""


def bounded_key(prefix: str, *parts: str) -> str:
    """Cache key for a visitor-typed lookup; the oldest such entry is dropped once the cache gets big."""
    key = prefix + "|".join(" ".join(p.split()).lower() for p in parts)
    if key not in _cache and len(_cache) > 2000:
        _cache.pop(next((k for k in _cache if k.startswith(prefix)), key), None)
    return key


@app.get("/api/song")
def song(title: str = Query(min_length=1, max_length=150), artist: str = Query(min_length=1, max_length=100)):
    """The life of one song in my listening: first listen, the 25th, its peak, its longest streak and longest silence."""
    rows = query(bounded_key("song:", title, artist), """
        WITH p AS (SELECT full_date, played_at FROM v_listen WHERE track_name = %s AND artist_name = %s),
        nth AS (SELECT full_date, ROW_NUMBER() OVER (ORDER BY played_at) AS n FROM p),""" + LIFE + """,
        (SELECT full_date FROM nth WHERE n = 25) AS twenty_fifth""", (title, artist))
    if not rows or not rows[0]["listens"]:
        raise HTTPException(404, "not in my history")
    return {"track_name": title, "artist_name": artist, **rows[0]}


@app.get("/api/artist-life")
def artist_life(name: str = Query(min_length=1, max_length=100)):
    """An artist's arc in my listening: peak month, longest streak of days, longest gap, top songs."""
    key = bounded_key("artistlife:", name)
    rows = query(key, """
        WITH p AS (SELECT full_date FROM v_listen WHERE artist_name = %s),""" + LIFE, (name,))
    if not rows or not rows[0]["listens"]:
        raise HTTPException(404, "not in my history")
    top = query(key + ":top", """
        SELECT track_name, COUNT(*) AS listens FROM v_listen WHERE artist_name = %s
        GROUP BY track_key, track_name ORDER BY listens DESC LIMIT 3""", (name,))
    return {"artist_name": name, **rows[0], "top_songs": top}


YEAR_STATS = """
    SELECT {group} AS period,
           ROUND(SUM(minutes) / 60) AS hours,
           COUNT(*) AS listens,
           COUNT(DISTINCT full_date) AS active_days,
           ROUND(SUM(minutes) / 60 / COUNT(DISTINCT full_date), 1) AS hours_per_day,
           COUNT(DISTINCT artist_key) AS artists,
           COUNT(DISTINCT track_key) AS songs,
           ROUND(COUNT(*)::numeric / COUNT(DISTINCT track_key), 1) AS listens_per_song
    FROM v_listen {where} GROUP BY 1"""


@app.get("/api/change")
def change():
    """How I changed year to year: volume, variety, repetition, concentration and skipping."""
    base = query("change-base", YEAR_STATS.format(group="year", where="") + " ORDER BY 1")
    extra = query("change-extra", """
        WITH a AS (SELECT year, artist_key, SUM(minutes) AS m,
                          RANK() OVER (PARTITION BY year ORDER BY SUM(minutes) DESC) AS r
                   FROM v_listen GROUP BY year, artist_key),
        conc AS (SELECT year, ROUND(100 * SUM(m) FILTER (WHERE r <= 10) / SUM(m), 1) AS top10_share FROM a GROUP BY year),
        skips AS (SELECT d.year, ROUND(100.0 * COUNT(*) FILTER (WHERE f.skipped) / COUNT(*), 1) AS skip_rate
                  FROM fact_play f JOIN dim_date d USING (date_key) GROUP BY d.year),
        peak AS (SELECT DISTINCT ON (year) year, hour AS peak_hour FROM v_listening_clock ORDER BY year, share_pct DESC)
        SELECT conc.year, top10_share, skip_rate, peak_hour
        FROM conc JOIN skips USING (year) JOIN peak USING (year) ORDER BY year""")
    by_year = {r["year"]: r for r in extra}
    return [{**r, **{k: v for k, v in by_year[r["period"]].items() if k != "year"}} for r in base]


@app.get("/api/period")
def period(start: str = Query(pattern=r"^20\d\d-(0[1-9]|1[0-2])$"), end: str = Query(pattern=r"^20\d\d-(0[1-9]|1[0-2])$")):
    """Any stretch of months (start and end as YYYY-MM), for comparing two eras side by side."""
    if end < start:
        raise HTTPException(400, "end comes before start")
    key = bounded_key("period:", start, end)
    lo, hi = f"{start}-01", f"{end}-01"
    stats = query(key, YEAR_STATS.format(group="1", where="WHERE date_trunc('month', full_date) BETWEEN %s::date AND %s::date"), (lo, hi))
    if not stats:
        raise HTTPException(404, "no listening in that stretch")
    more = query(key + ":more", """
        WITH p AS (SELECT * FROM v_listen WHERE date_trunc('month', full_date) BETWEEN %s::date AND %s::date),
        a AS (SELECT artist_name, artist_key, SUM(minutes) AS m, RANK() OVER (ORDER BY SUM(minutes) DESC) AS r FROM p GROUP BY 1, 2),
        first_artist AS (SELECT artist_key, MIN(full_date) AS f FROM v_listen GROUP BY artist_key)
        SELECT
            (SELECT artist_name FROM a WHERE r = 1 LIMIT 1) AS top_artist,
            (SELECT ROUND(100 * m / (SELECT SUM(m) FROM a), 1) FROM a WHERE r = 1 LIMIT 1) AS top_artist_share,
            (SELECT ROUND(100 * SUM(m) FILTER (WHERE r <= 10) / SUM(m), 1) FROM a) AS top10_share,
            (SELECT track_name || '|' || artist_name FROM p GROUP BY track_key, track_name, artist_name ORDER BY COUNT(*) DESC LIMIT 1) AS top_song,
            (SELECT COUNT(*) FROM first_artist WHERE f BETWEEN %s::date AND (%s::date + INTERVAL '1 month' - INTERVAL '1 day')) AS new_artists,
            (SELECT hour FROM p GROUP BY hour ORDER BY SUM(minutes) DESC LIMIT 1) AS peak_hour""", (lo, hi, lo, hi))[0]
    song_name, song_artist = (more.get("top_song") or "|").split("|", 1)   # read, never change, the cached row
    return {**stats[0], **more, "top_song": song_name, "top_song_artist": song_artist}


def clean(text: str) -> str:
    text = re.sub(r"[\(\[].*?[\)\]]", "", text).split(" - ")[0]
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


@app.get("/api/preview")
async def preview(title: str = Query(max_length=150), artist: str = Query(max_length=100)):
    """A 30-second preview from the iTunes Search API, only when the artist and title really match."""
    key = f"preview:{clean(title)}|{clean(artist)}"
    if key not in _cache:
        async with httpx.AsyncClient(timeout=8) as client:
            item = await itunes(client, title, artist, "song")
        _cache[key] = {"url": item["previewUrl"]} if item else None
    if not _cache[key]:
        raise HTTPException(404, "no preview")
    return _cache[key]


# ---------- pictures: album art for any song or artist, and the shape of every day ----------

_art_gate: Optional[asyncio.Semaphore] = None        # a wall of covers loads at once; stay polite to Spotify
WEEK = {"Cache-Control": "public, max-age=604800"}


async def cover_for(uri: str, title: str, artist: str, big: bool) -> Optional[str]:
    """The exact cover from Spotify's public oEmbed (by the ID I played), then iTunes as a fallback."""
    global _art_gate
    _art_gate = _art_gate or asyncio.Semaphore(8)       # made inside the server's event loop
    async with _art_gate, httpx.AsyncClient(timeout=8) as client:
        try:
            r = await client.get("https://open.spotify.com/oembed", params={"url": uri})
            thumb = r.json().get("thumbnail_url") if r.status_code == 200 else None
            if thumb:
                return thumb.replace("ab67616d00001e02", "ab67616d0000b273") if big else thumb
        except (httpx.HTTPError, ValueError):
            pass
        item = await itunes(client, title, artist, "song")
    if item and item.get("artworkUrl100"):
        return item["artworkUrl100"].replace("100x100bb", "600x600bb" if big else "300x300bb")
    return None


async def art_redirect(key: str, found: list, big: bool):
    """Send the browser straight to the image, so any <img> can point at /api/art and cache it for a week."""
    if key not in _cache:
        if not found:
            raise HTTPException(404, "not in my history")
        _cache[key] = await cover_for(found[0]["spotify_uri"], found[0]["track_name"], found[0]["artist_name"], big)
    if not _cache[key]:
        raise HTTPException(404, "no cover")
    return RedirectResponse(_cache[key], status_code=302, headers=WEEK)


@app.get("/api/art")
async def art(title: str = Query(min_length=1, max_length=150), artist: str = Query(min_length=1, max_length=100), big: bool = False):
    """A song's album cover (redirects to the image)."""
    key = bounded_key("art:", title, artist, "big" if big else "")
    found = query(key + ":uri", """
        SELECT t.spotify_uri, t.track_name, a.artist_name FROM dim_track t JOIN dim_artist a USING (artist_key)
        WHERE t.track_name = %s AND a.artist_name = %s LIMIT 1""", (title, artist))
    return await art_redirect(key, found, big)


@app.get("/api/artist-art")
async def artist_art(name: str = Query(min_length=1, max_length=100)):
    """An artist's picture: the cover of the song of theirs I played most."""
    key = bounded_key("artistart:", name)
    found = query(key + ":uri", """
        SELECT t.spotify_uri, t.track_name, v.artist_name FROM v_listen v JOIN dim_track t USING (track_key)
        WHERE v.artist_name = %s GROUP BY t.spotify_uri, t.track_name, v.artist_name ORDER BY COUNT(*) DESC LIMIT 1""", (name,))
    return await art_redirect(key, found, False)


@app.get("/api/calendar")
def calendar():
    """Every day in the history: minutes, listens and the song I played most (days with no music are left out)."""
    return query("calendar", """
        WITH per_day AS (
            SELECT full_date, ROUND(SUM(minutes)) AS minutes, COUNT(*) AS listens FROM v_listen GROUP BY full_date
        ), song AS (
            SELECT DISTINCT ON (full_date) full_date, track_name, artist_name FROM (
                SELECT full_date, track_name, artist_name, COUNT(*) AS n FROM v_listen
                GROUP BY full_date, track_key, track_name, artist_name) s
            ORDER BY full_date, n DESC, track_name
        )
        SELECT full_date AS d, minutes AS m, listens AS n, track_name AS s, artist_name AS a
        FROM per_day JOIN song USING (full_date) ORDER BY full_date""")


@app.get("/api/race")
def race():
    """My 12 most-listened artists, hours per month, for the race of who got there first."""
    return query("race", """
        WITH top AS (SELECT artist_key FROM v_listen GROUP BY artist_key ORDER BY SUM(minutes) DESC LIMIT 12)
        SELECT to_char(date_trunc('month', full_date), 'YYYY-MM') AS month, artist_name, ROUND(SUM(minutes) / 60, 1) AS hours
        FROM v_listen WHERE artist_key IN (SELECT artist_key FROM top)
        GROUP BY 1, artist_name ORDER BY 1, artist_name""")


@app.get("/api/report-extras")
def report_extras():
    """Everything else the report charts: the shape of my week, sessions, how plays start and end, and the long tail."""
    week = query("rx-week", """
        SELECT EXTRACT(ISODOW FROM full_date)::int AS dow, hour, ROUND(SUM(minutes) / 60, 1) AS hours
        FROM v_listen GROUP BY 1, 2 ORDER BY 1, 2""")
    weekdays = query("rx-weekdays", """
        SELECT EXTRACT(ISODOW FROM d.full_date)::int AS dow, d.weekday, COUNT(DISTINCT d.date_key) AS days,
               ROUND(COALESCE(SUM(v.minutes), 0) / 60 / COUNT(DISTINCT d.date_key), 2) AS hours_per_day
        FROM dim_date d LEFT JOIN v_listen v ON v.full_date = d.full_date
        GROUP BY 1, 2 ORDER BY 1""")
    seasons = query("rx-seasons", """
        WITH days AS (SELECT season, COUNT(*) AS n FROM dim_date GROUP BY season)
        SELECT v.season, ROUND(SUM(v.minutes) / 60) AS hours, ROUND(SUM(v.minutes) / 60 / days.n, 2) AS hours_per_day
        FROM v_listen v JOIN days USING (season) GROUP BY v.season, days.n ORDER BY hours DESC""")
    totals = query("rx-totals", """
        SELECT (SELECT COUNT(*) FROM dim_date) AS calendar_days, (SELECT COUNT(*) FROM fact_play) AS all_plays,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) FROM dim_session) AS median_session,
               (SELECT ROUND(AVG(play_count)) FROM dim_session) AS avg_session_plays,
               (SELECT ROUND(MAX(minutes) / 60, 1) FROM dim_session) AS longest_session_hours""")[0]
    sessions = query("rx-sessions", """
        SELECT CASE WHEN minutes < 15 THEN 0 WHEN minutes < 30 THEN 1 WHEN minutes < 60 THEN 2
                    WHEN minutes < 120 THEN 3 WHEN minutes < 240 THEN 4 ELSE 5 END AS bucket,
               COUNT(*) AS sessions, ROUND(SUM(minutes) / 60) AS hours
        FROM dim_session GROUP BY 1 ORDER BY 1""")
    lengths = query("rx-lengths", """
        SELECT LEAST(FLOOR(ms_played / 30000.0), 12)::int AS bucket, COUNT(*) AS plays
        FROM fact_play GROUP BY 1 ORDER BY 1""")
    endings = query("rx-endings", "SELECT reason_end AS reason, COUNT(*) AS plays FROM fact_play GROUP BY 1 ORDER BY 2 DESC")
    starts = query("rx-starts", "SELECT reason_start AS reason, COUNT(*) AS plays FROM fact_play GROUP BY 1 ORDER BY 2 DESC")
    by_year = query("rx-by-year", """
        SELECT d.year, ROUND(100.0 * COUNT(*) FILTER (WHERE f.shuffle) / COUNT(*), 1) AS shuffle_pct,
               ROUND(100.0 * COUNT(*) FILTER (WHERE f.reason_start = 'clickrow') / COUNT(*), 1) AS chosen_pct,
               ROUND(100.0 * COUNT(*) FILTER (WHERE f.reason_end = 'backbtn') / COUNT(*), 1) AS replay_pct
        FROM fact_play f JOIN dim_date d USING (date_key) GROUP BY d.year ORDER BY d.year""")
    skip_hours = query("rx-skip-hours", """
        SELECT hour, ROUND(100.0 * COUNT(*) FILTER (WHERE skipped) / COUNT(*), 1) AS skip_pct
        FROM fact_play GROUP BY hour ORDER BY hour""")
    tail = query("rx-tail", """
        WITH per_song AS (SELECT track_key, COUNT(*) AS n FROM v_listen GROUP BY track_key)
        SELECT CASE WHEN n = 1 THEN 0 WHEN n < 5 THEN 1 WHEN n < 10 THEN 2 WHEN n < 25 THEN 3
                    WHEN n < 50 THEN 4 WHEN n < 100 THEN 5 WHEN n < 250 THEN 6 ELSE 7 END AS bucket,
               COUNT(*) AS songs, SUM(n) AS listens
        FROM per_song GROUP BY 1 ORDER BY 1""")
    albums = query("rx-albums", """
        SELECT al.album_name, ar.artist_name, COUNT(*) AS listens, ROUND(SUM(v.minutes) / 60) AS hours
        FROM v_listen v JOIN dim_track t USING (track_key) JOIN dim_album al ON al.album_key = t.album_key
        JOIN dim_artist ar ON ar.artist_key = al.artist_key
        GROUP BY al.album_key, al.album_name, ar.artist_name ORDER BY hours DESC LIMIT 10""")
    year_artists = query("rx-year-artists", """
        SELECT year, artist_name, hours FROM (
            SELECT year, artist_name, ROUND(SUM(minutes) / 60) AS hours,
                   ROW_NUMBER() OVER (PARTITION BY year ORDER BY SUM(minutes) DESC) AS place
            FROM v_listen GROUP BY year, artist_name) r
        WHERE place <= 5 ORDER BY year, place""")
    finds = query("rx-finds", """
        WITH firsts AS (SELECT track_key, MIN(year) AS found FROM v_listen GROUP BY track_key)
        SELECT found AS year, track_name, artist_name, listens FROM (
            SELECT f.found, v.track_name, v.artist_name, COUNT(*) AS listens,
                   ROW_NUMBER() OVER (PARTITION BY f.found ORDER BY COUNT(*) DESC) AS place
            FROM v_listen v JOIN firsts f USING (track_key)
            GROUP BY f.found, v.track_key, v.track_name, v.artist_name) r
        WHERE place <= 3 ORDER BY year, place""")
    return {**totals, "week": week, "weekdays": weekdays, "seasons": seasons, "sessions": sessions,
            "lengths": lengths, "endings": endings, "starts": starts, "by_year": by_year,
            "skip_hours": skip_hours, "tail": tail, "finds": finds, "albums": albums, "year_artists": year_artists}


MOOD_SCORE = """CASE t.mood WHEN 'heartbreak' THEN -2 WHEN 'bittersweet' THEN -1 WHEN 'dark' THEN -1
                 WHEN 'love' THEN 1 WHEN 'confident' THEN 1 WHEN 'party' THEN 2 END"""
MOODED = f"SELECT v.*, t.mood, {MOOD_SCORE} AS score FROM v_listen v JOIN dim_track t USING (track_key) WHERE t.mood IS NOT NULL"


@app.get("/api/moods")
def moods():
    """How my listening felt: my own mood labels on my most-played songs, by year, month, day, hour and artist."""
    by_year = query("mood-year", f"""
        SELECT year, mood, COUNT(*) AS listens,
               ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY year), 1) AS share
        FROM ({MOODED}) m GROUP BY year, mood ORDER BY year, mood""")
    overall = query("mood-all", f"""
        SELECT mood, COUNT(*) AS listens, ROUND(SUM(minutes) / 60) AS hours FROM ({MOODED}) m GROUP BY mood ORDER BY listens DESC""")
    months = query("mood-months", f"""
        WITH m AS ({MOODED}),
        per AS (SELECT date_trunc('month', full_date)::date AS month, ROUND(AVG(score), 2) AS score, COUNT(*) AS listens
                FROM m GROUP BY 1),
        top AS (SELECT DISTINCT ON (month) month, track_name, artist_name, mood FROM (
                    SELECT date_trunc('month', full_date)::date AS month, track_name, artist_name, mood, COUNT(*) AS n
                    FROM m GROUP BY 1, track_key, track_name, artist_name, mood) x ORDER BY month, n DESC)
        SELECT per.*, top.track_name, top.artist_name, top.mood FROM per JOIN top USING (month) ORDER BY month""")
    days = query("mood-days", f"""
        WITH m AS ({MOODED}),
        per AS (SELECT full_date, ROUND(AVG(score), 2) AS score, COUNT(*) AS listens FROM m GROUP BY full_date HAVING COUNT(*) >= 40),
        top AS (SELECT DISTINCT ON (full_date) full_date, track_name, artist_name, mood, n FROM (
                    SELECT full_date, track_name, artist_name, mood, COUNT(*) AS n FROM m GROUP BY 1, track_key, track_name, artist_name, mood) x
                ORDER BY full_date, n DESC)
        SELECT per.*, top.track_name, top.artist_name, top.mood, top.n FROM per JOIN top USING (full_date)""")
    ranked = sorted(days, key=lambda d: d["score"])
    hours = query("mood-hours", f"SELECT hour, ROUND(AVG(score), 2) AS score FROM ({MOODED}) m GROUP BY hour ORDER BY hour")
    songs = query("mood-songs", f"""
        SELECT mood, track_name, artist_name, listens FROM (
            SELECT mood, track_name, artist_name, COUNT(*) AS listens,
                   ROW_NUMBER() OVER (PARTITION BY mood ORDER BY COUNT(*) DESC) AS place
            FROM ({MOODED}) m GROUP BY mood, track_key, track_name, artist_name) x
        WHERE place <= 3 ORDER BY mood, place""")
    artists = query("mood-artists", f"""
        WITH top AS (SELECT artist_key FROM v_listen GROUP BY artist_key ORDER BY SUM(minutes) DESC LIMIT 8)
        SELECT artist_name, mood, COUNT(*) AS listens,
               ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY artist_name), 1) AS share
        FROM ({MOODED}) m WHERE artist_key IN (SELECT artist_key FROM top) GROUP BY artist_name, mood""")
    coverage = query("mood-coverage", """
        SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE t.mood IS NOT NULL) / COUNT(*), 1) AS pct,
               COUNT(DISTINCT t.track_key) FILTER (WHERE t.mood IS NOT NULL) AS songs
        FROM v_listen v JOIN dim_track t USING (track_key)""")[0]
    return {"coverage": coverage, "overall": overall, "by_year": by_year, "months": months, "hours": hours,
            "saddest_days": ranked[:5], "happiest_days": ranked[::-1][:5], "songs": songs, "artists": artists}


@app.get("/api/nights")
def nights():
    """When the music stops at night, all-nighters (music every hour from midnight to 6 AM), and my most loyal song."""
    stops = query("night-stops", """
        WITH p AS (SELECT played_at - make_interval(secs => ms_played / 1000.0) AS started, played_at AS ended FROM fact_play),
        gaps AS (SELECT ended AS quiet_from, LEAD(started) OVER (ORDER BY started) AS quiet_to FROM p),
        longest AS (
            SELECT DISTINCT ON ((quiet_from - INTERVAL '14 hours')::date) quiet_from, quiet_to
            FROM gaps WHERE quiet_to - quiet_from BETWEEN INTERVAL '3 hours' AND INTERVAL '20 hours'
            ORDER BY (quiet_from - INTERVAL '14 hours')::date, quiet_to - quiet_from DESC)
        SELECT EXTRACT(HOUR FROM quiet_from)::int AS hour, COUNT(*) AS nights FROM longest GROUP BY 1 ORDER BY 1""")
    allnighters = query("night-all", """
        SELECT full_date, COUNT(*) AS listens FROM v_listen WHERE hour BETWEEN 0 AND 5
        GROUP BY full_date HAVING COUNT(DISTINCT hour) = 6 ORDER BY full_date""")
    night_songs = query("night-songs", """
        SELECT track_name, artist_name, COUNT(*) AS listens FROM v_listen WHERE hour BETWEEN 0 AND 4
        GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 5""")
    contender = query("night-contender", """
        WITH ranked AS (
            SELECT year, track_key, track_name, artist_name, COUNT(*) AS listens,
                   RANK() OVER (PARTITION BY year ORDER BY COUNT(*) DESC) AS place
            FROM v_listen GROUP BY year, track_key, track_name, artist_name)
        SELECT track_name, artist_name, MAX(place) AS worst_place, SUM(listens) AS listens,
               array_agg(place ORDER BY year) AS places, array_agg(year ORDER BY year) AS years
        FROM ranked GROUP BY track_key, track_name, artist_name
        HAVING COUNT(*) = (SELECT COUNT(DISTINCT year) FROM v_listen)
        ORDER BY MAX(place), SUM(listens) DESC LIMIT 5""")
    return {"stops": stops, "allnighters": allnighters, "night_songs": night_songs, "contenders": contender}


# My life's turning points, used to split the history into eras (dates are the boundaries, not causes).
GRADUATED = "2024-06-01"        # finished high school in May 2024
MOVED_TO_AUSTIN = "2024-08-15"  # moved to Austin in August 2024
ERA = f"""CASE WHEN full_date < '{GRADUATED}' THEN 'High school' WHEN full_date < '{MOVED_TO_AUSTIN}' THEN 'The summer between'
               ELSE 'Austin' END"""
PERIOD = """CASE WHEN hour BETWEEN 6 AND 11 THEN 'morning' WHEN hour BETWEEN 12 AND 17 THEN 'afternoon'
                  WHEN hour BETWEEN 18 AND 23 THEN 'evening' ELSE 'late night' END"""


@app.get("/api/story")
def story():
    """The questions the report asks about me: obsessions, Ariana's share, resurrections, sleep, eras, desi music, love vs. skip."""
    # obsession curves: listens per day for the first 45 days of my biggest binges and fastest obsessions
    picks = query("st-picks", """
        (SELECT track_key FROM v_most_in_a_day v JOIN dim_track t USING (track_name)
         JOIN dim_artist a ON a.artist_key = t.artist_key AND a.artist_name = v.artist_name ORDER BY listens DESC LIMIT 4)
        UNION
        (SELECT t.track_key FROM v_first_listen_to_obsession o JOIN dim_track t USING (track_name)
         JOIN dim_artist a ON a.artist_key = t.artist_key AND a.artist_name = o.artist_name
         WHERE o.track_name !~* 'instrumental' ORDER BY days_to_obsession, first_listen LIMIT 3)""")
    curves = query("st-curves", """
        WITH firsts AS (SELECT track_key, MIN(full_date) AS f FROM v_listen WHERE track_key = ANY(%s) GROUP BY track_key)
        SELECT v.track_key, v.track_name, v.artist_name, v.full_date - firsts.f AS day, COUNT(*) AS listens
        FROM v_listen v JOIN firsts USING (track_key) WHERE v.full_date - firsts.f < 45
        GROUP BY 1, 2, 3, 4 ORDER BY 1, 4""", ([p["track_key"] for p in picks],))
    ariana = query("st-ariana", """
        SELECT date_trunc('month', full_date)::date AS month,
               ROUND(100.0 * COUNT(*) FILTER (WHERE artist_key = (SELECT artist_key FROM v_listen GROUP BY artist_key ORDER BY SUM(minutes) DESC LIMIT 1)) / COUNT(*), 1) AS share
        FROM v_listen GROUP BY 1 ORDER BY 1""")
    comebacks = query("st-comebacks", """
        WITH d AS (SELECT track_key, track_name, artist_name, full_date, COUNT(*) AS n FROM v_listen GROUP BY 1, 2, 3, 4),
        g AS (SELECT *, full_date - LAG(full_date) OVER w AS gap,
                     SUM(n) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before,
                     SUM(n) OVER (w RANGE BETWEEN CURRENT ROW AND INTERVAL '59 days' FOLLOWING) AS after   -- the 60 calendar days after
              FROM d WINDOW w AS (PARTITION BY track_key ORDER BY full_date))
        SELECT DISTINCT ON (track_key) track_name, artist_name, full_date - gap AS last_heard, full_date AS returned, gap, before, after
        FROM g WHERE gap >= 180 AND before >= 40 AND after >= 25 ORDER BY track_key, gap * after DESC""")
    comebacks = sorted(comebacks, key=lambda r: -r["gap"] * r["after"])[:6]
    awake = query("st-awake", """
        SELECT full_date - (SELECT MIN(full_date) FROM dim_date) AS d, hour AS h, ROUND(SUM(minutes)) AS m
        FROM v_listen GROUP BY 1, 2""")
    long_nights = query("st-long-nights", """
        SELECT started_at, ended_at, ROUND(minutes / 60, 1) AS hours, play_count FROM dim_session
        WHERE started_at::date < ended_at::date OR started_at::time < '03:00'
        ORDER BY CASE WHEN ended_at::time >= '05:00' THEN ended_at - date_trunc('day', ended_at) ELSE INTERVAL '0' END DESC LIMIT 3""")
    weather = query("st-weather", f"""
        SELECT v.full_date AS d, ROUND(AVG({MOOD_SCORE}), 2) AS score, ROUND(STDDEV({MOOD_SCORE}), 2) AS spread, COUNT(*) AS n
        FROM v_listen v JOIN dim_track t USING (track_key) WHERE t.mood IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 10""")
    by_period = query("st-periods", f"""
        WITH p AS (SELECT artist_name, {PERIOD} AS period FROM v_listen),
        artists AS (SELECT artist_name, COUNT(*) AS n FROM p GROUP BY 1 HAVING COUNT(*) >= 150),
        periods AS (SELECT period, COUNT(*) AS n FROM p GROUP BY 1),
        lifts AS (SELECT p.period, p.artist_name, COUNT(*) AS listens,
                         ROUND((COUNT(*)::numeric / periods.n) / (artists.n::numeric / (SELECT COUNT(*) FROM p)), 2) AS lift
                  FROM p JOIN artists USING (artist_name) JOIN periods USING (period)
                  GROUP BY p.period, p.artist_name, periods.n, artists.n HAVING COUNT(*) >= 30)
        SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY period ORDER BY lift DESC) AS place FROM lifts) r
        WHERE place <= 4 ORDER BY period, place""")
    desi_hours = query("st-desi-hours", "SELECT hour, ROUND(100.0 * AVG(a.desi::int), 1) AS share FROM v_listen v JOIN dim_artist a USING (artist_key) GROUP BY 1 ORDER BY 1")
    desi_months = query("st-desi-months", """
        SELECT date_trunc('month', full_date)::date AS month, ROUND(100.0 * AVG(a.desi::int), 1) AS share
        FROM v_listen v JOIN dim_artist a USING (artist_key) GROUP BY 1 ORDER BY 1""")
    desi_songs = query("st-desi-songs", """
        SELECT track_name, v.artist_name, COUNT(*) AS listens FROM v_listen v JOIN dim_artist a USING (artist_key)
        WHERE a.desi GROUP BY track_key, track_name, v.artist_name ORDER BY listens DESC LIMIT 6""")
    eras = query("st-eras", f"""
        WITH e AS (SELECT v.*, a.desi, {ERA} AS era FROM v_listen v JOIN dim_artist a USING (artist_key)),
        days AS (SELECT {ERA} AS era, COUNT(*) AS n, MIN(full_date) AS first, MAX(full_date) AS last FROM dim_date GROUP BY 1)
        SELECT e.era, days.first, days.last, ROUND(SUM(minutes) / 60 / days.n, 2) AS hours_per_day,
               ROUND(100.0 * COUNT(*) FILTER (WHERE hour < 5) / COUNT(*), 1) AS late_share,
               ROUND(100.0 * COUNT(*) FILTER (WHERE artist_name = 'Ariana Grande') / COUNT(*), 1) AS ariana_share,
               ROUND(100.0 * AVG(desi::int), 1) AS desi_share
        FROM e JOIN days USING (era) GROUP BY e.era, days.n, days.first, days.last ORDER BY days.first""")
    skips = {r["era"]: r["skip_pct"] for r in query("st-era-skips", f"""
        SELECT {ERA} AS era, ROUND(100.0 * AVG(f.skipped::int), 1) AS skip_pct FROM fact_play f JOIN dim_date d USING (date_key) GROUP BY 1""")}
    eras = [{**e, "skip_pct": skips.get(e["era"])} for e in eras]
    era_songs = query("st-era-songs", f"""
        SELECT DISTINCT ON (era) era, track_name, artist_name, listens FROM (
            SELECT {ERA} AS era, track_name, artist_name, COUNT(*) AS listens FROM v_listen
            GROUP BY 1, track_key, track_name, artist_name) s ORDER BY era, listens DESC""")
    love = query("st-love", """
        SELECT t.track_name, a.artist_name, COUNT(*) FILTER (WHERE f.counted) AS listens,
               ROUND(100.0 * AVG((f.skipped OR NOT f.counted)::int), 1) AS skip_pct
        FROM fact_play f JOIN dim_track t USING (track_key) JOIN dim_artist a ON a.artist_key = t.artist_key
        GROUP BY t.track_key, t.track_name, a.artist_name HAVING COUNT(*) FILTER (WHERE f.counted) >= 120""")
    desi_years = query("st-desi-years", "SELECT year, ROUND(100.0 * AVG(a.desi::int), 1) AS share FROM v_listen v JOIN dim_artist a USING (artist_key) GROUP BY 1 ORDER BY 1")
    day_songs = query("st-day-songs", """
        SELECT track_name, artist_name, COUNT(*) AS listens FROM v_listen WHERE hour BETWEEN 12 AND 17
        GROUP BY track_key, track_name, artist_name ORDER BY listens DESC LIMIT 5""")
    season_artists = query("st-season-artists", """
        WITH artists AS (SELECT artist_name, COUNT(*) AS n FROM v_listen GROUP BY 1 HAVING COUNT(*) >= 150),
        seasons AS (SELECT season, COUNT(*) AS n FROM v_listen GROUP BY 1),
        lifts AS (SELECT v.season, v.artist_name, COUNT(*) AS listens,
                         ROUND((COUNT(*)::numeric / seasons.n) / (artists.n::numeric / (SELECT COUNT(*) FROM v_listen)), 2) AS lift
                  FROM v_listen v JOIN artists USING (artist_name) JOIN seasons USING (season)
                  GROUP BY v.season, v.artist_name, seasons.n, artists.n HAVING COUNT(*) >= 40)
        SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY season ORDER BY lift DESC) AS place FROM lifts) r
        WHERE place <= 3 ORDER BY season, place""")
    era_artists = query("st-era-artists", f"""
        SELECT era, artist_name, hours FROM (
            SELECT {ERA} AS era, artist_name, ROUND(SUM(minutes) / 60) AS hours,
                   ROW_NUMBER() OVER (PARTITION BY {ERA} ORDER BY SUM(minutes) DESC) AS place
            FROM v_listen GROUP BY 1, artist_name) r WHERE place <= 4 ORDER BY era, place""")
    desi_artists = query("st-desi-artists", """
        SELECT v.artist_name, COUNT(*) AS listens FROM v_listen v JOIN dim_artist a USING (artist_key)
        WHERE a.desi GROUP BY v.artist_name ORDER BY listens DESC LIMIT 8""")
    in_a_row = query("st-in-a-row", """
        WITH p AS (SELECT track_key, played_at,
                          ROW_NUMBER() OVER (ORDER BY played_at, play_key) - ROW_NUMBER() OVER (PARTITION BY track_key ORDER BY played_at, play_key) AS run
                   FROM fact_play WHERE counted)
        SELECT t.track_name, a.artist_name, COUNT(*) AS plays, MIN(p.played_at) AS started, MAX(p.played_at) AS ended
        FROM p JOIN dim_track t USING (track_key) JOIN dim_artist a ON a.artist_key = t.artist_key
        GROUP BY p.track_key, p.run, t.track_name, a.artist_name ORDER BY plays DESC LIMIT 5""")
    habits = query("st-habits", """
        WITH p AS (SELECT track_key, LAG(track_key) OVER (ORDER BY played_at, play_key) AS previous FROM fact_play WHERE counted),
        songs AS (SELECT track_key, COUNT(*) AS n FROM v_listen GROUP BY track_key)
        SELECT (SELECT COUNT(*) FILTER (WHERE track_key = previous) FROM p) AS replays,
               (SELECT COUNT(*) FROM p) AS listens,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms_played / 1000.0) FROM fact_play WHERE skipped OR NOT counted) AS skip_seconds,
               (SELECT COUNT(*) FILTER (WHERE n = 1) FROM songs) AS one_listen_songs,
               (SELECT COUNT(*) FILTER (WHERE n >= 10) FROM songs) AS ten_listen_songs,
               (SELECT COUNT(*) FROM songs) AS songs""")[0]
    skip_seconds = query("st-skip-seconds", """
        SELECT a.artist_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY f.ms_played / 1000.0) AS seconds
        FROM fact_play f JOIN dim_track t USING (track_key) JOIN dim_artist a ON a.artist_key = t.artist_key
        WHERE (f.skipped OR NOT f.counted) AND a.artist_name IN (SELECT artist_name FROM v_skip_rate ORDER BY skip_pct DESC LIMIT 5)
        GROUP BY a.artist_name""")
    shifts = query("st-shifts", f"""
        WITH days AS (SELECT {ERA} AS era, COUNT(*) AS n FROM dim_date GROUP BY 1),
        per AS (SELECT artist_name, {ERA} AS era, SUM(minutes) / 60 AS hours FROM v_listen GROUP BY 1, 2),
        m AS (SELECT artist_name, COALESCE(MAX(hours * 30 / days.n) FILTER (WHERE per.era = 'High school'), 0) AS before,
                     COALESCE(MAX(hours * 30 / days.n) FILTER (WHERE per.era = 'Austin'), 0) AS after
              FROM per JOIN days USING (era) GROUP BY artist_name)
        (SELECT 'left' AS way, artist_name, ROUND(before::numeric, 1) AS before, ROUND(after::numeric, 1) AS after FROM m WHERE before > 1.5 ORDER BY after / before LIMIT 3)
        UNION ALL
        (SELECT 'arrived', artist_name, ROUND(before::numeric, 1), ROUND(after::numeric, 1) FROM m WHERE after > 1.5 ORDER BY after / GREATEST(before, 0.05) DESC LIMIT 3)""")
    sunday = query("st-sunday", """
        WITH a AS (SELECT artist_name, COUNT(*) AS n FROM v_listen GROUP BY 1 HAVING COUNT(*) >= 150),
        s AS (SELECT COUNT(*) AS n FROM v_listen WHERE weekday = 'Sunday'), t AS (SELECT COUNT(*) AS n FROM v_listen)
        SELECT v.artist_name, COUNT(*) AS listens, ROUND((COUNT(*)::numeric / s.n) / (a.n::numeric / t.n), 2) AS lift
        FROM v_listen v JOIN a USING (artist_name) CROSS JOIN s CROSS JOIN t WHERE v.weekday = 'Sunday'
        GROUP BY v.artist_name, s.n, a.n, t.n HAVING COUNT(*) >= 30 ORDER BY lift DESC LIMIT 3""")
    graveyard = query("st-graveyard", """
        WITH top AS (SELECT artist_key FROM v_listen GROUP BY artist_key ORDER BY SUM(minutes) DESC LIMIT 6),
        once AS (SELECT track_key, track_name, artist_name, artist_key, MIN(full_date) AS heard FROM v_listen GROUP BY 1, 2, 3, 4 HAVING COUNT(*) = 1)
        SELECT DISTINCT ON (artist_name) track_name, artist_name, heard FROM once WHERE artist_key IN (SELECT artist_key FROM top)
        ORDER BY artist_name, heard""")
    night_years = query("st-night-years", "SELECT year, ROUND(100.0 * COUNT(*) FILTER (WHERE hour < 5) / COUNT(*), 1) AS late_share FROM v_listen GROUP BY 1 ORDER BY 1")
    return {"curves": curves, "ariana": ariana, "comebacks": comebacks, "awake": awake, "long_nights": long_nights,
            "weather": weather, "by_period": by_period, "desi_hours": desi_hours, "desi_months": desi_months,
            "desi_songs": desi_songs, "desi_years": desi_years, "eras": eras, "era_songs": era_songs, "love": love, "night_years": night_years,
            "day_songs": day_songs, "in_a_row": in_a_row, "habits": habits, "skip_seconds": skip_seconds,
            "shifts": shifts, "sunday": sunday, "graveyard": graveyard, "season_artists": season_artists,
            "era_artists": era_artists, "desi_artists": desi_artists, "graduated": GRADUATED, "moved": MOVED_TO_AUSTIN}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# pages are always re-checked, so returning visitors see the newest version
FRESH = {"Cache-Control": "no-cache"}


@app.get("/")
def home():
    """The front door: my four years told as a story, then yours (story.html)."""
    return FileResponse(STATIC / "story.html", headers=FRESH)


@app.get("/explore")
def explore():
    """Every chart, for anyone who wants the numbers behind the story."""
    return FileResponse(STATIC / "index.html", headers=FRESH)


@app.get("/about")
def about():
    """Who I am, what MIS means to me, and my other projects. The main page stays all Spotify."""
    return FileResponse(STATIC / "about.html", headers=FRESH)


@app.get("/report")
def report():
    """The printable report page (the PDF is made from this)."""
    return FileResponse(STATIC / "report.html", headers=FRESH)


@app.get("/report.pdf")
def report_pdf():
    """The four-year report as a PDF download, named after me."""
    return FileResponse(STATIC / "Tiwari_Suhani_Listening_Report.pdf", media_type="application/pdf",
                        filename="Tiwari_Suhani_Listening_Report.pdf")
