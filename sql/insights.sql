-- Listening History: the questions, answered in SQL (PostgreSQL views over the star schema)
-- Run after the load:  psql "$DATABASE_URL" -f sql/insights.sql
-- Every view counts only real listens (30 seconds or more) unless it's about skipping.

-- A convenience view: every counted play with its song, artist, day and length in minutes.
CREATE OR REPLACE VIEW v_listen AS
SELECT f.play_key, f.played_at, f.hour, d.full_date, d.year, d.month, d.weekday, d.season,
       t.track_key, t.track_name, a.artist_key, a.artist_name, f.session_key,
       f.ms_played / 60000.0 AS minutes
FROM fact_play f
JOIN dim_track  t USING (track_key)
JOIN dim_artist a ON a.artist_key = t.artist_key
JOIN dim_date   d USING (date_key)
WHERE f.counted;


-- 1. Eras: who owned each month. RANK() inside every month, then keep #1.
CREATE OR REPLACE VIEW v_monthly_eras AS
WITH per_artist AS (
    SELECT date_trunc('month', full_date)::date AS month, artist_name, SUM(minutes) AS minutes
    FROM v_listen
    GROUP BY 1, 2
), ranked AS (
    SELECT month, artist_name, minutes,
           RANK() OVER (PARTITION BY month ORDER BY minutes DESC) AS place,
           minutes / SUM(minutes) OVER (PARTITION BY month) AS share
    FROM per_artist
)
SELECT month, artist_name, ROUND(minutes) AS minutes, ROUND(share * 100, 1) AS share_pct
FROM ranked
WHERE place = 1;


-- 2. Streaks: the most days in a row I played one song.
-- Gaps and islands: on consecutive days, date minus row number stays constant, so each run shares one "island".
CREATE OR REPLACE VIEW v_song_streaks AS
WITH days AS (
    SELECT DISTINCT track_key, full_date FROM v_listen
), islands AS (
    SELECT track_key, full_date,
           full_date - (ROW_NUMBER() OVER (PARTITION BY track_key ORDER BY full_date))::int AS island
    FROM days
)
SELECT t.track_name, a.artist_name, COUNT(*) AS days_in_a_row, MIN(full_date) AS started, MAX(full_date) AS ended
FROM islands i
JOIN dim_track t USING (track_key)
JOIN dim_artist a ON a.artist_key = t.artist_key
GROUP BY t.track_key, t.track_name, a.artist_name, island
HAVING COUNT(*) >= 5;


-- 3. First listen to obsession: how many days a song took to reach its 25th listen.
-- ROW_NUMBER() numbers every listen of a song in order; the 25th one marks the obsession.
CREATE OR REPLACE VIEW v_first_listen_to_obsession AS
WITH numbered AS (
    SELECT track_key, full_date,
           ROW_NUMBER() OVER (PARTITION BY track_key ORDER BY played_at) AS nth
    FROM v_listen
), milestones AS (
    SELECT track_key,
           MIN(full_date) FILTER (WHERE nth = 1)  AS first_listen,
           MIN(full_date) FILTER (WHERE nth = 25) AS obsessed_on
    FROM numbered
    GROUP BY track_key
)
SELECT t.track_name, a.artist_name, m.first_listen, m.obsessed_on,
       m.obsessed_on - m.first_listen AS days_to_obsession
FROM milestones m
JOIN dim_track t USING (track_key)
JOIN dim_artist a ON a.artist_key = t.artist_key
WHERE m.obsessed_on IS NOT NULL
  AND a.artist_name !~* '(white noise|sleep|rain sounds|asmr)';   -- sleep sounds aren't an obsession


-- 4. Skip rate: which artists I start and don't finish (artists with 200+ plays, skips included).
CREATE OR REPLACE VIEW v_skip_rate AS
SELECT a.artist_name,
       COUNT(*) AS plays,
       ROUND(100.0 * AVG(CASE WHEN f.skipped OR NOT f.counted THEN 1 ELSE 0 END), 1) AS skip_pct
FROM fact_play f
JOIN dim_track t USING (track_key)
JOIN dim_artist a ON a.artist_key = t.artist_key
GROUP BY a.artist_name
HAVING COUNT(*) >= 200;


-- 5. Listening clock: my share of each year's listening, hour by hour.
CREATE OR REPLACE VIEW v_listening_clock AS
SELECT year, hour, ROUND(SUM(minutes)) AS minutes,
       ROUND(100 * SUM(minutes) / SUM(SUM(minutes)) OVER (PARTITION BY year), 2) AS share_pct
FROM v_listen
GROUP BY year, hour;


-- 6. Each year in one row: hours, songs, artists, new discoveries, and the song of the year.
CREATE OR REPLACE VIEW v_year_in_review AS
WITH totals AS (
    SELECT year, ROUND(SUM(minutes) / 60) AS hours, COUNT(*) AS listens,
           COUNT(DISTINCT track_key) AS songs, COUNT(DISTINCT artist_key) AS artists
    FROM v_listen GROUP BY year
), discoveries AS (
    SELECT EXTRACT(YEAR FROM first_played)::int AS year, COUNT(*) AS new_songs
    FROM dim_track GROUP BY 1
), song_of_year AS (
    SELECT DISTINCT ON (year) year, track_name, artist_name, COUNT(*) AS listens
    FROM v_listen GROUP BY year, track_name, artist_name
    ORDER BY year, COUNT(*) DESC
)
SELECT t.year, t.hours, t.listens, t.songs, t.artists, d.new_songs,
       s.track_name AS song_of_the_year, s.artist_name AS song_of_the_year_artist, s.listens AS song_listens
FROM totals t
JOIN discoveries d USING (year)
JOIN song_of_year s USING (year);


-- 7. My most intense single days with one song.
CREATE OR REPLACE VIEW v_most_in_a_day AS
SELECT full_date, track_name, artist_name, COUNT(*) AS listens
FROM v_listen
GROUP BY full_date, track_key, track_name, artist_name
HAVING COUNT(*) >= 20;


-- The web app connects as a read-only user: it can read every table and view, and change nothing.
-- Re-granted on every load, since the pipeline rebuilds the tables.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'listening_reader') THEN
        GRANT USAGE ON SCHEMA public TO listening_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO listening_reader;
    END IF;
END $$;
