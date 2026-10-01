/*
 * Listening engine: any Spotify export -> the answers my story asks.
 *
 * Runs in the visitor's browser (their history never leaves it) and in Node, where it is checked
 * against the SQL version of the same questions on my own data.
 * © 2026 Suhani Tiwari. All rights reserved.
 *
 * Accepts both exports:
 *   Extended streaming history  (Streaming_History_Audio_*.json): ts, ms_played, master_metadata_*, skipped, reason_end
 *   Account data                (StreamingHistory_music_*.json):  endTime, artistName, trackName, msPlayed
 */
(function (root) {
    const COUNTED_MS = 30000;                 // Spotify counts a stream at 30 seconds
    const DAY = 864e5;
    const NOT_MUSIC = /(white noise|sleep|rain sounds|asmr)/i;   // sleep sounds aren't an obsession

    const clean = t => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const pad = n => String(n).padStart(2, '0');
    const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dayIndex = key => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
    const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
    const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
    const maxBy = (arr, f) => arr.reduce((a, b) => (a === undefined || f(b) > f(a) ? b : a), undefined);

    /** Raw export records -> plays, oldest first. Podcasts, private sessions and duplicates are dropped. */
    function toPlays(records, { exclude = [] } = {}) {
        const seen = new Set(), plays = [];
        let hasSkips = false;
        for (const r of records) {
            const track = r.master_metadata_track_name || r.trackName, artist = r.master_metadata_album_artist_name || r.artistName;
            if (!track || !artist || r.incognito_mode) continue;
            const ms = Number(r.ms_played ?? r.msPlayed ?? 0);
            // extended history gives an ISO time in UTC; account data gives "YYYY-MM-DD HH:MM" in UTC
            const end = r.ts ? new Date(r.ts) : new Date(String(r.endTime).replace(' ', 'T') + ':00Z');
            if (isNaN(end)) continue;
            const id = `${end.getTime()}|${track}|${ms}`;
            if (seen.has(id)) continue;
            seen.add(id);
            if ('skipped' in r || 'reason_end' in r) hasSkips = true;
            plays.push({ end, track: track.trim(), artist: artist.trim(), ms,
                         skipped: !!r.skipped || r.reason_end === 'fwdbtn', key: clean(track) + '|' + artist.trim() });
        }
        const out = plays.filter(p => !exclude.some(f => f(p))).sort((a, b) => a.end - b.end);
        out.hasSkips = hasSkips;
        return out;
    }

    /** Plays -> the profile the story renders. */
    function profile(plays, { who = 'You', obsession = 25 } = {}) {
        if (!plays.length) throw new Error('No songs found in this file.');
        const listens = plays.filter(p => p.ms >= COUNTED_MS);
        for (const p of listens) { p.day = dayKey(p.end); p.hour = p.end.getHours(); p.month = p.day.slice(0, 7); }

        // songs: one name per merged song (the spelling I played most)
        const songName = new Map(), songListens = new Map();
        for (const p of listens) { bump(songListens, p.key); if (!songName.has(p.key)) songName.set(p.key, { track: p.track, artist: p.artist }); }
        const song = k => songName.get(k);

        const hours = listens.reduce((t, p) => t + p.ms, 0) / 36e5;
        const artistHours = new Map(), artistListens = new Map();
        for (const p of listens) { bump(artistHours, p.artist, p.ms / 36e5); bump(artistListens, p.artist); }
        const topArtists = [...artistHours].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, h]) => ({ name, hours: h, listens: artistListens.get(name) }));
        const topSongs = [...songListens].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ ...song(k), listens: n }));
        const top = topArtists[0];

        // the dynasty: who won each month
        const monthArtist = new Map(), monthHours = new Map();
        for (const p of listens) { bump(monthArtist, p.month + '|' + p.artist, p.ms); bump(monthHours, p.month, p.ms / 36e5); }
        const winners = new Map();
        for (const [k, ms] of monthArtist) { const [m, a] = [k.slice(0, 7), k.slice(8)]; if (!winners.has(m) || ms > winners.get(m).ms) winners.set(m, { artist: a, ms }); }
        const months = [...winners].sort().map(([month, w]) => ({ month, winner: w.artist, hours: monthHours.get(month) }));

        // per-song days: for obsessions, streaks, comebacks and biggest days
        const songDays = new Map();
        for (const p of listens) { if (!songDays.has(p.key)) songDays.set(p.key, new Map()); bump(songDays.get(p.key), p.day); }

        // fastest from first listen to N listens (25, or 10 for a short history)
        const threshold = [...songListens.values()].some(n => n >= obsession) ? obsession : 10;
        let fastest = null;
        for (const [k, days] of songDays) {
            if (songListens.get(k) < threshold || /instrumental/i.test(song(k).track) || NOT_MUSIC.test(song(k).artist + ' ' + song(k).track)) continue;
            const sorted = [...days].sort(); let total = 0, reached;
            for (const [d, n] of sorted) { total += n; if (total >= threshold) { reached = d; break; } }
            const took = dayIndex(reached) - dayIndex(sorted[0][0]);
            if (!fastest || took < fastest.days || (took === fastest.days && sorted[0][0] < fastest.first)) fastest = { ...song(k), days: took, first: sorted[0][0], threshold };
        }

        // biggest single day with one song
        let biggest = null;
        for (const [k, days] of songDays) for (const [d, n] of days) if (!biggest || n > biggest.n) biggest = { ...song(k), date: d, n };

        // most times in a row, and how often I replay what just finished
        let run = null, cur = null, replays = 0;
        listens.forEach((p, i) => {
            if (i && p.key === listens[i - 1].key) { replays++; cur.n++; cur.endAt = p.end; }
            else cur = { key: p.key, n: 1, start: p.end, endAt: p.end };
            if (!run || cur.n > run.n) run = { ...cur };
        });

        // longest daily streak with one song
        let streak = null;
        for (const [k, days] of songDays) {
            const idx = [...days.keys()].map(dayIndex).sort((a, b) => a - b);
            let len = 1, start = idx[0];
            for (let i = 1; i <= idx.length; i++) {
                if (i < idx.length && idx[i] === idx[i - 1] + 1) { len++; continue; }
                if (!streak || len > streak.days) streak = { ...song(k), days: len, start: new Date(start * DAY).toISOString().slice(0, 10) };
                len = 1; start = idx[i];
            }
        }

        // the biggest comeback: a long silence, then a burst (thresholds shrink for short histories)
        const span = dayIndex(dayKey(plays[plays.length - 1].end)) - dayIndex(dayKey(plays[0].end));
        const [minGap, minBefore, minAfter] = span > 900 ? [180, 40, 25] : [60, 8, 5];
        let comeback = null;
        for (const [k, days] of songDays) {
            const sorted = [...days].sort(); let before = 0;
            for (let i = 0; i < sorted.length; i++) {
                if (i) {
                    const gap = dayIndex(sorted[i][0]) - dayIndex(sorted[i - 1][0]);
                    if (gap >= minGap && before >= minBefore) {
                        const limit = dayIndex(sorted[i][0]) + 59;
                        const after = sorted.slice(i).filter(([d]) => dayIndex(d) <= limit).reduce((t, [, n]) => t + n, 0);
                        if (after >= minAfter && (!comeback || gap * after > comeback.gap * comeback.after)) comeback = { ...song(k), gap, after, returned: sorted[i][0], lastHeard: sorted[i - 1][0] };
                    }
                }
                before += sorted[i][1];
            }
        }

        // the graveyard: songs with exactly one listen
        const once = [...songListens].filter(([, n]) => n === 1);
        const topNames = new Set(topArtists.slice(0, 6).map(a => a.name)), graves = [];
        for (const [k] of once) { const s = song(k); if (topNames.has(s.artist) && !graves.some(g => g.artist === s.artist)) graves.push(s); }

        // the night: all-nighters, when the music stops, the listening clock and the quiet window
        const nightHours = new Map();
        for (const p of listens) if (p.hour < 6) { if (!nightHours.has(p.day)) nightHours.set(p.day, new Set()); nightHours.get(p.day).add(p.hour); }
        const allnighters = [...nightHours].filter(([, h]) => h.size === 6).map(([d]) => d).sort();
        const stopsByNight = new Map();
        for (let i = 1; i < plays.length; i++) {
            const quietFrom = plays[i - 1].end, quietTo = new Date(plays[i].end - plays[i].ms), gap = (quietTo - quietFrom) / 36e5;
            if (gap < 3 || gap > 20) continue;
            const night = dayKey(new Date(quietFrom - 14 * 36e5));
            if (!stopsByNight.has(night) || gap > stopsByNight.get(night).gap) stopsByNight.set(night, { gap, hour: quietFrom.getHours() });
        }
        const stopCounts = new Map();
        for (const { hour } of stopsByNight.values()) bump(stopCounts, hour);
        const stopHour = stopCounts.size ? [...stopCounts].sort((a, b) => b[1] - a[1])[0][0] : null;
        const clockMs = Array(24).fill(0);
        for (const p of listens) clockMs[p.hour] += p.ms;
        const clockTotal = clockMs.reduce((t, v) => t + v, 0) || 1, clock = clockMs.map(v => 100 * v / clockTotal);
        const quietStart = [...Array(24).keys()].reduce((b, s) => { const sum = [0, 1, 2, 3, 4, 5].reduce((t, i) => t + clock[(s + i) % 24], 0); return sum < b[1] ? [s, sum] : b; }, [0, 1e9])[0];
        const peakHour = clock.indexOf(Math.max(...clock));

        // 2 AM me: the artist most over-represented after midnight
        const late = listens.filter(p => p.hour < 6), minAll = Math.max(20, listens.length * 0.0015), lateCount = new Map();
        for (const p of late) bump(lateCount, p.artist);
        let lateArtist = null;
        for (const [a, n] of lateCount) {
            if (n < 10 || artistListens.get(a) < minAll) continue;
            const lift = (n / late.length) / (artistListens.get(a) / listens.length);
            if (!lateArtist || lift > lateArtist.lift) lateArtist = { name: a, lift, listens: n };
        }

        // the skip button: how long a song gets before I give up on it
        const quits = plays.filter(p => p.skipped || p.ms < COUNTED_MS).map(p => p.ms / 1000);
        const skipSeconds = median(quits);
        const skipRate = 100 * quits.length / plays.length;

        // each year: hours, its song, its #1 artist and how many songs were new
        const firstYear = new Map(), years = new Map();
        for (const p of listens) {
            const y = +p.day.slice(0, 4);
            if (!firstYear.has(p.key)) firstYear.set(p.key, y);
            if (!years.has(y)) years.set(y, { year: y, ms: 0, songs: new Map(), artists: new Map(), newSongs: new Set() });
            const Y = years.get(y); Y.ms += p.ms; bump(Y.songs, p.key); bump(Y.artists, p.artist, p.ms);
            if (firstYear.get(p.key) === y) Y.newSongs.add(p.key);
        }
        const yearList = [...years.values()].map(Y => { const [k, n] = maxBy([...Y.songs], e => e[1]); const [a] = maxBy([...Y.artists], e => e[1]);
            return { year: Y.year, hours: Y.ms / 36e5, ...song(k), listens: n, topArtist: a, newSongs: Y.newSongs.size }; });

        // the dating funnel: how many songs made it to each milestone
        const funnel = [1, 2, 3, 10, 25, 100].map(k => ({ at: k, songs: [...songListens.values()].filter(v => v >= k).length }));

        // first impressions: replayed on the spot, or skipped and later loved
        const firstPlay = new Map();
        for (const p of plays) if (!firstPlay.has(p.key)) firstPlay.set(p.key, p);
        let firstListens = 0, instantReplays = 0;
        const seenKeys = new Set();
        listens.forEach((p, i) => { if (seenKeys.has(p.key)) return; seenKeys.add(p.key); firstListens++; if (listens[i + 1] && listens[i + 1].key === p.key) instantReplays++; });
        const growerMin = listens.length > 20000 ? 50 : 15;
        const growers = [...songListens].filter(([k, n]) => n >= growerMin && firstPlay.get(k) && (firstPlay.get(k).skipped || firstPlay.get(k).ms < COUNTED_MS))
            .sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ ...song(k), listens: n, first: dayKey(firstPlay.get(k).end) }));

        // "put it back": a song skipped in under 30 seconds, then played properly within 15 minutes
        let quickSkips = 0, putBack = 0;
        plays.forEach((p, i) => {
            if (p.ms >= COUNTED_MS) return; quickSkips++;
            for (let j = i + 1; j < plays.length && plays[j].end - p.end < 9e5; j++) if (plays[j].key === p.key && plays[j].ms >= COUNTED_MS) { putBack++; break; }
        });

        // taste retention: how many of my first year's top 100 songs I still play in my latest year
        const yearSongs = new Map();
        for (const p of listens) { const y = +p.day.slice(0, 4); if (!yearSongs.has(y)) yearSongs.set(y, new Map()); bump(yearSongs.get(y), p.key); }
        const ys = [...yearSongs.keys()].sort();
        const firstTop = new Set([...yearSongs.get(ys[0])].sort((a, b) => b[1] - a[1]).slice(0, 100).map(e => e[0]));
        const retention = ys.map(y => ({ year: y, kept: [...firstTop].filter(k => yearSongs.get(y).has(k)).length, of: firstTop.size }));

        // without my #1 artist: who would have won each month?
        const runnerUp = new Map();
        for (const [k, ms] of monthArtist) { const [m, a] = [k.slice(0, 7), k.slice(8)]; if (a === top.name) continue; if (!runnerUp.has(m) || ms > runnerUp.get(m).ms) runnerUp.set(m, { artist: a, ms }); }
        const heirCount = new Map(); for (const { artist } of runnerUp.values()) bump(heirCount, artist);
        const heir = [...heirCount].sort((a, b) => b[1] - a[1])[0];
        const heirMonths = months.map(m => (runnerUp.get(m.month) || { artist: null }).artist);

        // my day, hour by hour: share of my listening, the artist most over-represented then, and the song I play most then
        const hourCount = Array(24).fill(0), hourArtist = [...Array(24)].map(() => new Map()), hourSong = [...Array(24)].map(() => new Map());
        for (const p of listens) { hourCount[p.hour]++; bump(hourArtist[p.hour], p.artist); if (!NOT_MUSIC.test(p.artist + ' ' + p.track)) bump(hourSong[p.hour], p.key); }
        const hourly = hourCount.map((n, h) => {
            let best = null;
            for (const [a, c] of hourArtist[h]) { if (c < Math.max(5, n * 0.01) || artistListens.get(a) < minAll) continue; const lift = (c / n) / (artistListens.get(a) / listens.length); if (!best || lift > best.lift) best = { name: a, lift }; }
            const topSong = hourSong[h].size ? maxBy([...hourSong[h]], e => e[1]) : null;
            return { hour: h, share: clock[h], listens: n, artist: best, song: topSong && { ...song(topSong[0]), listens: topSong[1] } };
        });

        // my own weekly chart: how often the #1 song changes hands
        const weekSongs = new Map();
        for (const p of listens) { const d = new Date(p.end); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const w = dayKey(d); if (!weekSongs.has(w)) weekSongs.set(w, new Map()); bump(weekSongs.get(w), p.key); }
        const weekly = [...weekSongs].sort().map(([w, m]) => [w, maxBy([...m], e => e[1])[0]]);
        let reign = null, cr = null;
        for (const [w, k] of weekly) { if (cr && cr.key === k) cr.weeks++; else cr = { key: k, weeks: 1, from: w }; if (!reign || cr.weeks > reign.weeks) reign = { ...cr }; }
        const chart = { weeks: weekly.length, numberOnes: new Set(weekly.map(w => w[1])).size, reign: reign && { ...song(reign.key), weeks: reign.weeks, from: reign.from } };

        // "I don't like you, I like this song": the artist whose plays are almost all one song
        const minArtist = listens.length > 20000 ? 100 : 25, artistSongs = new Map();
        for (const p of listens) { if (!artistSongs.has(p.artist)) artistSongs.set(p.artist, new Map()); bump(artistSongs.get(p.artist), p.key); }
        const oneSong = [...artistListens].filter(([, n]) => n >= minArtist).map(([a, n]) => { const [k, c] = maxBy([...artistSongs.get(a)], e => e[1]); return { artist: a, ...song(k), share: 100 * c / n, listens: n }; })
            .sort((a, b) => b.share - a.share || b.listens - a.listens)[0] || null;

        // a song with a curfew, and the artist with weekend custody
        const minSong = listens.length > 20000 ? 40 : 12, lateSong = new Map();
        for (const p of listens) if (p.hour < 5) bump(lateSong, p.key);
        const curfew = [...songListens].filter(([, n]) => n >= minSong).map(([k, n]) => ({ ...song(k), share: 100 * (lateSong.get(k) || 0) / n, listens: n })).sort((a, b) => b.share - a.share)[0] || null;
        const weekendOf = p => { const d = p.end.getDay(); return d === 5 || d === 6 || d === 0; };
        const weekendShare = 100 * listens.filter(weekendOf).length / listens.length, weekendCount = new Map();
        for (const p of listens) if (weekendOf(p)) bump(weekendCount, p.artist);
        const weekendArtist = [...artistListens].filter(([, n]) => n >= minAll).map(([a, n]) => ({ name: a, share: 100 * (weekendCount.get(a) || 0) / n })).sort((a, b) => b.share - a.share)[0] || null;

        // good night, good morning, and picking up where I left off
        const gn = new Map(), gm = new Map(); let mornings = 0, pickedUp = 0;
        for (let i = 1; i < listens.length; i++) {
            const a = listens[i - 1], b = listens[i];
            if (b.end - a.end > 4 * 36e5 && (a.hour >= 21 || a.hour < 6)) { bump(gn, a.key); bump(gm, b.key); mornings++; if (a.key === b.key) pickedUp++; }
        }
        const goodnight = gn.size ? { ...song(maxBy([...gn], e => e[1])[0]), times: Math.max(...gn.values()) } : null;
        const goodMorning = gm.size ? { ...song(maxBy([...gm], e => e[1])[0]), times: Math.max(...gm.values()) } : null;

        // attention span: songs by one artist in a row before I switch
        let runs = 0, runLen = 0, total = 0;
        listens.forEach((p, i) => { runLen++; if (!listens[i + 1] || listens[i + 1].artist !== p.artist) { runs++; total += runLen; runLen = 0; } });

        // for "would our music click?": my artists and songs as shares of my listening
        const taste = { artists: Object.fromEntries([...artistHours].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([a, h]) => [a, h / hours])),
                        songs: [...songListens].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, n]) => ({ ...song(k), listens: n })) };

        return {
            funnel, loveAtFirstPct: 100 * instantReplays / firstListens, instantReplays, growers: growers.slice(0, 6), growerCount: growers.length, growerMin,
            putBack, quickSkips, retention, heir: heir && { name: heir[0], months: heir[1] }, heirMonths, hourly, chart, oneSong, curfew, weekendArtist, weekendShare,
            goodnight, goodMorning, pickUpPct: mornings ? 100 * pickedUp / mornings : null, attentionSpan: total / runs, taste,
            who, firstDay: dayKey(plays[0].end), lastDay: dayKey(plays[plays.length - 1].end), hasSkips: plays.hasSkips,
            hours, listens: listens.length, songs: songListens.size, artists: artistHours.size,
            topArtists, topSongs, months, owned: months.filter(m => m.winner === top.name).length,
            topShare: 100 * top.hours / hours, nextFourHours: topArtists.slice(1, 5).reduce((t, a) => t + a.hours, 0),
            fastest, biggestDay: biggest,
            inARow: run && { ...song(run.key), n: run.n, start: run.start.toISOString(), end: run.endAt.toISOString() },
            replayPct: 100 * replays / listens.length, streak, comeback,
            graveyard: { count: once.length, pct: 100 * once.length / songListens.size, graves: graves.slice(0, 6) },
            allnighters, stopHour, quietStart, clock, peakHour, lateArtist, skipSeconds, skipRate, years: yearList,
        };
    }

    /** Files (File objects or {name, text}) -> records, unzipping Spotify's zip with JSZip when given one. */
    async function readFiles(files, JSZip) {
        const records = [];
        const take = (name, text) => { if (/\.json$/i.test(name) && /(Streaming_History_Audio|StreamingHistory_music|StreamingHistory\d)/i.test(name)) records.push(...JSON.parse(text)); };
        for (const f of files) {
            if (/\.zip$/i.test(f.name)) {
                const zip = await JSZip.loadAsync(f);
                for (const entry of Object.values(zip.files)) if (!entry.dir) take(entry.name.split('/').pop(), await entry.async('string'));
            } else take(f.name, f.text ? await f.text() : f.content);
        }
        return records;
    }

    /** Would our music click? Overlap of two people's artists (weighted by share of listening) and songs. */
    function compare(a, b) {
        const names = new Set([...Object.keys(a.taste.artists), ...Object.keys(b.taste.artists)]);
        let dot = 0, na = 0, nb = 0;
        for (const n of names) { const x = a.taste.artists[n] || 0, y = b.taste.artists[n] || 0; dot += x * y; na += x * x; nb += y * y; }
        const artistScore = na && nb ? dot / Math.sqrt(na * nb) : 0;
        const bSongs = new Map(b.taste.songs.map(s => [clean(s.track) + '|' + s.artist, s]));
        const sharedSongs = a.taste.songs.filter(s => bSongs.has(clean(s.track) + '|' + s.artist)).map(s => ({ ...s, theirs: bSongs.get(clean(s.track) + '|' + s.artist).listens }));
        const sharedArtists = [...names].filter(n => a.taste.artists[n] && b.taste.artists[n]).sort((x, y) => (b.taste.artists[y] + a.taste.artists[y]) - (b.taste.artists[x] + a.taste.artists[x]));
        // habits matter too: how alike our nights, skipping and repeating are (each 0..1)
        const near = (x, y, scale) => (x == null || y == null) ? 0.5 : Math.max(0, 1 - Math.abs(x - y) / scale);
        const habits = (near(a.peakHour, b.peakHour, 8) + near(a.replayPct, b.replayPct, 15) + near(a.skipSeconds, b.skipSeconds, 10) + near(a.allnighters.length / Math.max(1, a.years.length), b.allnighters.length / Math.max(1, b.years.length), 10)) / 4;
        const score = Math.round(100 * (0.6 * Math.sqrt(artistScore) + 0.15 * Math.min(1, sharedSongs.length / 20) + 0.25 * habits));
        return { score, artistScore, habits, sharedArtists: sharedArtists.slice(0, 8), sharedSongs: sharedSongs.slice(0, 8) };
    }

    const api = { toPlays, profile, readFiles, clean, compare };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ListeningEngine = api;
})(this);
