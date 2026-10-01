-- Listening History: a star schema for four years of my Spotify plays (PostgreSQL)
--
-- One fact table (every play) surrounded by the things a play is about:
-- which song, by whom, from which album, on what day, in which listening session.
-- Designed for analytics: narrow facts, descriptive dimensions, integer keys, indexes on the joins.

DROP TABLE IF EXISTS fact_play CASCADE;
DROP TABLE IF EXISTS dim_session CASCADE;
DROP TABLE IF EXISTS dim_track CASCADE;
DROP TABLE IF EXISTS dim_album CASCADE;
DROP TABLE IF EXISTS dim_artist CASCADE;
DROP TABLE IF EXISTS dim_date CASCADE;

CREATE TABLE dim_artist (
    artist_key   INTEGER PRIMARY KEY,
    artist_name  TEXT NOT NULL UNIQUE,
    desi         BOOLEAN NOT NULL DEFAULT FALSE   -- South Asian music (Hindi, Punjabi, Urdu); my list in etl/desi_artists.txt
);

CREATE TABLE dim_album (
    album_key    INTEGER PRIMARY KEY,
    album_name   TEXT NOT NULL,
    artist_key   INTEGER NOT NULL REFERENCES dim_artist (artist_key),
    UNIQUE (album_name, artist_key)
);

-- One row per song. Spotify lists the same song under several IDs (single, album, deluxe),
-- so the pipeline merges them: same title and artist = same song.
CREATE TABLE dim_track (
    track_key    INTEGER PRIMARY KEY,
    track_name   TEXT NOT NULL,
    artist_key   INTEGER NOT NULL REFERENCES dim_artist (artist_key),
    album_key    INTEGER NOT NULL REFERENCES dim_album (album_key),
    spotify_uri  TEXT NOT NULL,          -- the ID I played it under most often
    first_played DATE NOT NULL,
    mood         TEXT                    -- my own label for my most-played songs (etl/song_moods.csv); empty for the rest
                 CHECK (mood IN ('heartbreak', 'bittersweet', 'dark', 'love', 'confident', 'party'))
);

-- A calendar row for every day in the history, so any question can be asked by day, month, season or year.
CREATE TABLE dim_date (
    date_key     INTEGER PRIMARY KEY,    -- yyyymmdd
    full_date    DATE NOT NULL UNIQUE,
    year         SMALLINT NOT NULL,
    month        SMALLINT NOT NULL,
    month_name   TEXT NOT NULL,
    day          SMALLINT NOT NULL,
    weekday      TEXT NOT NULL,
    is_weekend   BOOLEAN NOT NULL,
    season       TEXT NOT NULL
);

-- A session is a stretch of listening with no gap longer than 30 minutes.
CREATE TABLE dim_session (
    session_key  INTEGER PRIMARY KEY,
    started_at   TIMESTAMP NOT NULL,
    ended_at     TIMESTAMP NOT NULL,
    play_count   INTEGER NOT NULL,
    minutes      NUMERIC(8, 1) NOT NULL
);

-- The fact table: one row per play, times in Austin time.
-- Short plays stay in (they are the skips); counted = played 30 seconds or more, Spotify's own threshold.
CREATE TABLE fact_play (
    play_key     INTEGER PRIMARY KEY,
    track_key    INTEGER NOT NULL REFERENCES dim_track (track_key),
    date_key     INTEGER NOT NULL REFERENCES dim_date (date_key),
    session_key  INTEGER NOT NULL REFERENCES dim_session (session_key),
    played_at    TIMESTAMP NOT NULL,
    hour         SMALLINT NOT NULL,
    ms_played    INTEGER NOT NULL,
    counted      BOOLEAN NOT NULL,
    skipped      BOOLEAN NOT NULL,
    shuffle      BOOLEAN NOT NULL,
    reason_start TEXT,
    reason_end   TEXT
);

CREATE INDEX ix_play_track   ON fact_play (track_key);
CREATE INDEX ix_play_date    ON fact_play (date_key);
CREATE INDEX ix_play_session ON fact_play (session_key);
CREATE INDEX ix_play_counted ON fact_play (date_key, track_key) WHERE counted;
CREATE INDEX ix_track_artist ON dim_track (artist_key);
