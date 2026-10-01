/*
 * My story profile, made by the same engine visitors run in their browsers, so "you vs. Suhani" compares like with like.
 * Reads the pipeline's cleaned CSVs (loops, accidents and private sessions are already gone) and writes one small JSON
 * of answers: no timestamps of individual plays, no raw history.
 *
 *     TZ=America/Chicago node etl/profile.js build/ app/static/data/suhani.json
 */
const fs = require('fs');
const path = require('path');
const E = require('../app/static/engine.js');

function readCsv(file) {
    const text = fs.readFileSync(file, 'utf8'), rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const [head, ...body] = rows;
    return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const [buildDir = 'build', out = 'app/static/data/suhani.json'] = process.argv.slice(2);
const artists = new Map(readCsv(path.join(buildDir, 'dim_artist.csv')).map(r => [r.artist_key, r.artist_name]));
const tracks = new Map(readCsv(path.join(buildDir, 'dim_track.csv')).map(r => [r.track_key, { track: r.track_name, artist: artists.get(r.artist_key) }]));
const plays = readCsv(path.join(buildDir, 'fact_play.csv')).map(r => {
    const t = tracks.get(r.track_key);
    return { end: new Date(r.played_at.replace(' ', 'T')), track: t.track, artist: t.artist, ms: Number(r.ms_played),
             skipped: r.skipped === 'True', key: E.clean(t.track) + '|' + t.artist };
}).sort((a, b) => a.end - b.end);
plays.hasSkips = true;

const profile = E.profile(plays, { who: 'Suhani' });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(profile));
console.log(`wrote ${out}: ${profile.listens.toLocaleString()} listens, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
