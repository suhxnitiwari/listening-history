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
from fastapi.responses import FileResponse
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


@app.get("/api/days")
def big_days():
    return query("days", "SELECT * FROM v_most_in_a_day ORDER BY listens DESC LIMIT 5")


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


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/about")
def about():
    """Who I am, what MIS means to me, and my other projects. The main page stays all Spotify."""
    return FileResponse(STATIC / "about.html")


@app.get("/report")
def report():
    """The printable report page (the PDF is made from this)."""
    return FileResponse(STATIC / "report.html")


@app.get("/report.pdf")
def report_pdf():
    """The four-year report as a PDF download, named after me."""
    return FileResponse(STATIC / "Tiwari_Suhani_Listening_Report.pdf", media_type="application/pdf",
                        filename="Tiwari_Suhani_Listening_Report.pdf")
