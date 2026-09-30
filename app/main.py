"""
Listening History: the web app.

A small FastAPI server over the star schema. Every endpoint is one SQL question (see sql/insights.sql),
answered once and cached: the history only changes when the pipeline reloads it.

    uvicorn app.main:app --reload        (needs DATABASE_URL)
"""

import os
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import date
from decimal import Decimal
from pathlib import Path

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


def clean(text: str) -> str:
    text = re.sub(r"[\(\[].*?[\)\]]", "", text).split(" - ")[0]
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


@app.get("/api/preview")
async def preview(title: str = Query(max_length=150), artist: str = Query(max_length=100)):
    """A 30-second preview from the iTunes Search API, only when the artist and title really match."""
    key = f"preview:{clean(title)}|{clean(artist)}"
    if key not in _cache:
        found = None
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get("https://itunes.apple.com/search",
                                     params={"term": f"{title} {artist}", "entity": "song", "limit": 10, "country": "US"})
            want_t, want_a = clean(title), clean(artist)
            for item in r.json().get("results", []):
                got_t, got_a = clean(item.get("trackName", "")), clean(item.get("artistName", ""))
                if item.get("previewUrl") and (want_a in got_a or got_a in want_a) and (got_t.startswith(want_t) or want_t.startswith(got_t)):
                    found = {"url": item["previewUrl"]}
                    break
        except (httpx.HTTPError, ValueError):
            pass
        _cache[key] = found
    if not _cache[key]:
        raise HTTPException(404, "no preview")
    return _cache[key]


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")
