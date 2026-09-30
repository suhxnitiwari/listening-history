// Listening History: every section is drawn from one API endpoint (see app/main.py)
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = path => fetch(`/api/${path}`).then(r => r.ok ? r.json() : Promise.reject(r.status));
const fmt = n => Number(n).toLocaleString('en-US');
const monthName = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const dayName = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const hourName = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

// ---------- song previews (iTunes), one at a time ----------
const player = $('#player');
let playing = null;
player.addEventListener('ended', () => playing?.classList.remove('playing'));
player.addEventListener('play', () => $('#screen')?.pause());
const playButton = (title, artist) =>
    `<button type="button" class="play" data-title="${esc(title)}" data-artist="${esc(artist)}" aria-label="Play a preview of ${esc(title)}"></button>`;
document.addEventListener('click', async e => {
    const btn = e.target.closest('.play');
    if (!btn || btn.classList.contains('none')) return;
    if (playing === btn && !player.paused) { player.pause(); btn.classList.remove('playing'); return; }
    playing?.classList.remove('playing');
    playing = btn;
    if (!btn.dataset.src) {
        try { btn.dataset.src = (await api(`preview?title=${encodeURIComponent(btn.dataset.title)}&artist=${encodeURIComponent(btn.dataset.artist)}`)).url; }
        catch { btn.classList.add('none'); btn.setAttribute('aria-label', 'No preview available'); return; }
    }
    player.src = btn.dataset.src;
    player.play().then(() => btn.classList.add('playing')).catch(() => {});
});
const songRow = (s, extra) => `<li>${playButton(s.track_name, s.artist_name)}<div><b>${esc(s.track_name)}</b><span>${esc(s.artist_name)}</span></div><em>${extra}</em></li>`;

// ---------- headline numbers ----------
api('summary').then(s => {
    const stats = [['Hours', fmt(s.hours)], ['Listens', fmt(s.listens)], ['Songs', fmt(s.songs)], ['Artists', fmt(s.artists)], ['Sessions', fmt(s.sessions)]];
    $('#stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    window.summary = s;
    const hero = $('#heroPlay');
    hero.dataset.title = s.top_song.track_name;
    hero.dataset.artist = s.top_song.artist_name;
    $('#heroSong').textContent = `${s.top_song.track_name}, ${s.top_song.artist_name}`;
    fact('artist', s.top_artist.artist_name, `${fmt(s.top_artist.hours)} hours of her, and counting`);
    fact('artists', fmt(s.artists), `across ${fmt(s.songs)} different songs`);
    game();
});

// ---------- scrub through time ----------
api('months').then(months => {
    const slider = $('#monthSlider'), bars = $('#bars'), card = $('#monthCard'), list = $('#monthSongs');
    const most = Math.max(...months.map(m => m.hours));
    bars.innerHTML = months.map((m, i) =>
        `<i data-i="${i}" class="${m.era_artist === 'Ariana Grande' ? 'ari' : ''}" style="height:${Math.max(4, m.hours / most * 100)}%" title="${esc(monthName(m.month))}"></i>`).join('');
    slider.max = months.length - 1;
    const show = i => {
        const m = months[i];
        slider.value = i;
        bars.querySelectorAll('i').forEach((b, j) => b.classList.toggle('on', j === +i));
        card.innerHTML = `
            <div><p class="label">Month</p><h3>${esc(monthName(m.month))}</h3></div>
            <div><p class="label">Owned by</p><p class="big">${esc(m.era_artist)}</p><p>${m.share_pct}% of my listening</p></div>
            <div><p class="label">Hours</p><p class="big">${m.hours}</p></div>
            <div><p class="label">Song of the month</p><p><b>${esc(m.song)}</b><br>${esc(m.song_artist)}, ${m.song_listens} listens</p></div>`;
        list.hidden = true;
        $('#openMonth').textContent = "See this month's top five";
    };
    slider.addEventListener('input', () => show(slider.value));
    bars.addEventListener('click', e => { const b = e.target.closest('i'); if (b) show(b.dataset.i); });
    $('#openMonth').addEventListener('click', async () => {
        if (!list.hidden) { list.hidden = true; $('#openMonth').textContent = "See this month's top five"; return; }
        const m = months[slider.value].month.slice(0, 7);
        const songs = await api(`month/${m}`);
        list.innerHTML = songs.map(s => songRow(s, `${s.listens} listens`)).join('');
        list.hidden = false;
        $('#openMonth').textContent = 'Hide the top five';
    });
    // start on the month of the longest streak: April 2024
    show(Math.max(0, months.findIndex(m => m.month.startsWith('2024-04'))));
});

// ---------- listening clock ----------
api('clock').then(rows => {
    const years = [...new Set(rows.map(r => r.year))];
    const svg = $('#clock');
    const ticks = [0, 6, 12, 18].map(h => {
        const a = h / 24 * 2 * Math.PI - Math.PI / 2;
        return `<text x="${Math.cos(a) * 148}" y="${Math.sin(a) * 148}">${hourName(h)}</text>`;
    }).join('');
    const draw = year => {
        const data = rows.filter(r => r.year === year);
        const peak = data.reduce((a, b) => (b.share_pct > a.share_pct ? b : a));
        const max = Math.max(...rows.map(r => r.share_pct));
        const spokes = data.map(r => {
            const len = 24 + r.share_pct / max * 100, w = 7;
            return `<rect class="spoke${r.hour === peak.hour ? ' peak' : ''}" x="${-w / 2}" y="${-24 - len}" width="${w}" height="${len}" rx="3" transform="rotate(${r.hour / 24 * 360})"><title>${hourName(r.hour)}: ${r.share_pct}%</title></rect>`;
        }).join('');
        svg.innerHTML = `<circle class="ring" r="24"/><circle class="ring" r="124"/>${spokes}${ticks}`;
        $('#clockNote').innerHTML = `In ${year}, my peak hour was <b>${hourName(peak.hour)}</b>, with ${peak.share_pct}% of the year's listening.`;
        document.querySelectorAll('#yearChips .chip').forEach(c => c.setAttribute('aria-pressed', +c.dataset.year === year));
    };
    $('#yearChips').innerHTML = years.map(y => `<button type="button" class="chip" data-year="${y}">${y}</button>`).join('');
    $('#yearChips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) draw(+c.dataset.year); });
    draw(years[years.length - 1]);
    // across every year, which hour gets the most listening
    const byHour = {};
    rows.forEach(r => byHour[r.hour] = (byHour[r.hour] || 0) + r.share_pct);
    const top = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0][0];
    fact('hour', hourName(+top), `my busiest hour, averaged over ${years.length} years`);
});

// ---------- streak race: bars grow when the section scrolls into view ----------
api('streaks').then(rows => {
    fact('streak', `${rows[0].days_in_a_row} days`, `of "${rows[0].track_name}", ${dayName(rows[0].started)} to ${dayName(rows[0].ended)}`);
    const race = $('#race'), best = rows[0].days_in_a_row;
    race.innerHTML = rows.map(r => `
        <li><div class="who"><b>${esc(r.track_name)}</b><span>${esc(r.artist_name)}, ${dayName(r.started)} to ${dayName(r.ended)}</span></div>
            <div class="track"><div class="fill" data-w="${r.days_in_a_row / best * 100}"></div><span class="days">${r.days_in_a_row} days</span></div></li>`).join('');
    const go = () => race.querySelectorAll('.fill').forEach((f, i) => setTimeout(() => f.style.width = f.dataset.w + '%', i * 120));
    new IntersectionObserver((entries, obs) => { if (entries.some(e => e.isIntersecting)) { go(); obs.disconnect(); } }, { threshold: 0.3 }).observe(race);
});

// ---------- year in review ----------
api('years').then(rows => {
    $('#years').innerHTML = rows.map(y => `
        <article class="year">
            <h3>${y.year}</h3>
            <dl><dt>Hours</dt><dd>${fmt(y.hours)}</dd><dt>Songs</dt><dd>${fmt(y.songs)}</dd>
                <dt>Artists</dt><dd>${fmt(y.artists)}</dd><dt>New discoveries</dt><dd>${fmt(y.new_songs)}</dd></dl>
            <div class="soty">${playButton(y.song_of_the_year, y.song_of_the_year_artist)}
                <div><b>${esc(y.song_of_the_year)}</b><span>Song of the year, ${y.song_listens} listens</span></div></div>
        </article>`).join('');
});

// ---------- obsessions and skips ----------
api('obsessions').then(rows => {
    $('#obsessions').innerHTML = rows.map(r => songRow(r, r.days_to_obsession === 0 ? 'same day' : `${r.days_to_obsession} ${r.days_to_obsession === 1 ? 'day' : 'days'}`)).join('');
});
api('skips').then(data => {
    const draw = which => {
        $('#skips').innerHTML = data[which].map(r => `
            <li><div><b>${esc(r.artist_name)}</b> <span class="muted">${fmt(r.plays)} plays</span></div><em>${r.skip_pct}%</em>
                <div class="meter"><i style="width:${r.skip_pct}%"></i></div></li>`).join('');
        document.querySelectorAll('[data-skip]').forEach(c => c.setAttribute('aria-pressed', c.dataset.skip === which));
    };
    document.querySelectorAll('[data-skip]').forEach(c => c.addEventListener('click', () => draw(c.dataset.skip)));
    draw('most');
});

// ---------- guess the stat ----------
async function game() {
    const [streaks, days, years] = await Promise.all([api('streaks'), api('days'), api('years')]);
    const s = window.summary, big = years.reduce((a, b) => (b.hours > a.hours ? b : a));
    const questions = [
        { q: `How many times did I play "${days[0].track_name}" on my biggest day?`, max: 200, answer: days[0].listens, unit: 'times',
          after: `on ${dayName(days[0].full_date)}. Same song, all afternoon and evening.` },
        { q: `How many days in a row did I play "${streaks[0].track_name}"?`, max: 40, answer: streaks[0].days_in_a_row, unit: 'days',
          after: `from ${dayName(streaks[0].started)} to ${dayName(streaks[0].ended)}.` },
        { q: `How many hours of music did I listen to in ${big.year}?`, max: 3000, answer: big.hours, unit: 'hours',
          after: `That's about ${Math.round(big.hours / 24)} full days.` },
        { q: `How many hours of Ariana Grande have I listened to since 2022?`, max: 3000, answer: s.top_artist.hours, unit: 'hours',
          after: `She's been my #1 artist every single year.` },
    ];
    let i = 0, score = 0;
    const box = $('#game');
    const ask = () => {
        const q = questions[i], start = Math.round(q.max / 2);
        box.innerHTML = `
            <p class="q">${esc(q.q)}</p>
            <div class="guess"><input type="range" min="0" max="${q.max}" value="${start}" aria-label="Your guess"><output>${fmt(start)}</output></div>
            <div class="row"><span class="progress">Question ${i + 1} of ${questions.length}</span><button type="button" class="pill solid" id="lockIn">Lock it in</button></div>`;
        const input = box.querySelector('input'), out = box.querySelector('output');
        input.addEventListener('input', () => out.textContent = fmt(input.value));
        $('#lockIn').addEventListener('click', () => {
            const guess = +input.value, off = Math.abs(guess - q.answer) / q.answer;
            if (off <= 0.15) score++;
            const verdict = off <= 0.05 ? 'Basically perfect.' : off <= 0.15 ? 'Close enough to count.' : guess < q.answer ? 'Higher. Much higher.' : 'Lower than that.';
            box.querySelector('.guess').insertAdjacentHTML('afterend',
                `<p class="reveal">${verdict} The answer is <b>${fmt(q.answer)} ${q.unit}</b>, ${esc(q.after)}</p>`);
            input.disabled = true;
            const last = i === questions.length - 1;
            $('#lockIn').textContent = last ? 'See my score' : 'Next question';
            $('#lockIn').onclick = null;
            $('#lockIn').addEventListener('click', () => {
                if (last) {
                    box.innerHTML = `<p class="q">You got ${score} of ${questions.length} within 15%.</p>
                        <p class="reveal">${score >= 3 ? 'You clearly know me.' : score >= 1 ? 'Not bad. Now you know more.' : 'Now you know.'}</p>
                        <div class="row"><span></span><button type="button" class="pill" id="again">Play again</button></div>`;
                    $('#again').addEventListener('click', () => { i = 0; score = 0; ask(); });
                } else { i++; ask(); }
            }, { once: true });
        }, { once: true });
    };
    ask();
}

// ---------- about me: flip cards filled from the data ----------
function fact(name, big, small) {
    const back = document.querySelector(`[data-fact="${name}"]`);
    if (back) back.innerHTML = `<b>${esc(big)}</b><small>${esc(small)}</small>`;
}
$('#flips').addEventListener('click', e => {
    const card = e.target.closest('.flip');
    if (card) card.setAttribute('aria-pressed', card.getAttribute('aria-pressed') !== 'true');
});

// ---------- watch: music video previews ----------
api('videos').then(list => {
    const screen = $('#screen'), reel = $('#reel');
    if (!list.length) { $('#watch').hidden = true; return; }
    reel.innerHTML = list.map((v, i) => `
        <li><button type="button" data-i="${i}"><img src="${esc(v.poster)}" alt="" loading="lazy">
            <div><b>${esc(v.track_name)}</b><span>${esc(v.artist_name)}, ${fmt(v.listens)} listens</span></div></button></li>`).join('');
    const show = (i, play) => {
        const v = list[i];
        screen.src = v.video;
        screen.poster = v.poster;
        $('#screenCap').innerHTML = `<b>${esc(v.track_name)}</b>, ${esc(v.artist_name)}. I've played it ${fmt(v.listens)} times.`;
        reel.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-current', j === i));
        if (play) { player.pause(); playing?.classList.remove('playing'); screen.play().catch(() => {}); }
    };
    reel.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(+b.dataset.i, true); });
    screen.addEventListener('play', () => { player.pause(); playing?.classList.remove('playing'); });
    show(0, false);
});

// ---------- play: pick a game ----------
document.querySelectorAll('[data-game]').forEach(chip => chip.addEventListener('click', () => {
    document.querySelectorAll('[data-game]').forEach(c => c.setAttribute('aria-pressed', c === chip));
    $('#more').hidden = chip.dataset.game !== 'more';
    $('#game').hidden = chip.dataset.game !== 'stat';
}));

// ---------- which did I play more? ----------
api('top-songs').then(songs => {
    const box = $('#more'), rounds = 5;
    let round = 0, score = 0;
    const pair = () => {
        // prefer two different artists, so it isn't Ariana against Ariana every round
        let a, b, tries = 0;
        do { a = songs[Math.floor(Math.random() * songs.length)]; b = songs[Math.floor(Math.random() * songs.length)]; }
        while (a === b || a.listens === b.listens || (a.artist_name === b.artist_name && ++tries < 40));
        return [a, b];
    };
    const ask = () => {
        const [a, b] = pair();
        const card = (s, side) => `<button type="button" class="vs-song" data-side="${side}">
            <b>${esc(s.track_name)}</b><span>${esc(s.artist_name)}</span><em hidden>${fmt(s.listens)} listens</em></button>`;
        box.innerHTML = `<p class="q">Tap the song I've played more.</p>
            <div class="vs">${card(a, 0)}<span class="vs-or">or</span>${card(b, 1)}</div>
            <div class="row"><span class="progress">Round ${round + 1} of ${rounds}, score ${score}</span><span></span></div>`;
        box.querySelector('.vs').addEventListener('click', e => {
            const pick = e.target.closest('.vs-song');
            if (!pick) return;
            const winner = a.listens > b.listens ? 0 : 1, right = +pick.dataset.side === winner;
            if (right) score++;
            box.querySelectorAll('.vs-song').forEach(btn => {
                btn.disabled = true;
                btn.querySelector('em').hidden = false;
                btn.classList.add(+btn.dataset.side === winner ? 'right' : 'wrong');
            });
            const last = round === rounds - 1;
            box.querySelector('.row').innerHTML = `<span class="progress">${right ? 'Yes!' : 'Nope.'} Score ${score} of ${round + 1}</span>
                <button type="button" class="pill solid">${last ? 'See my score' : 'Next pair'}</button>`;
            box.querySelector('.row .pill').addEventListener('click', () => {
                if (!last) { round++; ask(); return; }
                box.innerHTML = `<p class="q">You got ${score} of ${rounds}.</p>
                    <p class="reveal">${score === rounds ? 'Perfect. Are you me?' : score >= 3 ? 'You know my taste.' : 'My taste is harder to read than it looks.'}</p>
                    <div class="row"><span></span><button type="button" class="pill">Play again</button></div>`;
                box.querySelector('.pill').addEventListener('click', () => { round = 0; score = 0; ask(); });
            });
        }, { once: true });
    };
    ask();
});

// ---------- how it works: the pipeline, step by step (real code from the repo) ----------
const STEPS = [
    { title: 'Extract', text: 'Spotify sends a zip of JSON files. Python opens the zip and reads every audio record straight out of it, nothing unzipped to disk.',
      list: ['Input: my_spotify_data.zip', 'Output: one list of raw records'],
      code: `def extract(zip_path: Path) -> list:
    records = []
    with zipfile.ZipFile(zip_path) as z:
        for name in sorted(z.namelist()):
            if re.search(r"Streaming_History_Audio_.*\\.json$", name):
                records.extend(json.loads(z.read(name)))
    return records` },
    { title: 'Transform', text: 'Raw data is messy. Every play gets checked before it counts.',
      list: ['Podcasts and audiobooks out, songs only', 'Private sessions stay private', 'Times converted to Austin time', 'Duplicate rows and two overnight loops removed', 'One song under many Spotify IDs merged into one'],
      code: `for r in records:
    if not r.get("master_metadata_track_name"):   <span class="c"># podcasts</span>
        continue
    if r.get("incognito_mode"):                    <span class="c"># private stays private</span>
        continue
    ended = datetime.fromisoformat(r["ts"]).astimezone(AUSTIN)
    ...
<span class="c"># the same play can appear twice across files; keep one</span>
unique = {(p.played_at, p.uri, p.ms_played): p for p in plays}` },
    { title: 'Load', text: 'Six CSVs go into PostgreSQL on Neon in order, so every foreign key already exists when its row arrives. COPY is the fastest way in.',
      list: ['Schema rebuilt from sql/schema.sql', 'SQL views rebuilt on every load'],
      code: `order = ["dim_artist", "dim_album", "dim_track",
         "dim_date", "dim_session", "fact_play"]
with psycopg.connect(url) as conn, conn.cursor() as cur:
    cur.execute(schema.read_text())
    for name in order:
        with cur.copy(f"COPY {name} FROM STDIN WITH (FORMAT csv, HEADER true)") as copy:
            copy.write(open(out / f"{name}.csv").read())` },
    { title: 'Ask', text: 'Every chart on this page is a SQL view. The streak race uses gaps and islands: on days in a row, the date minus a row number never changes, so each streak shares one number.',
      list: ['Window functions: ROW_NUMBER, RANK', 'CTEs to build answers step by step', 'A partial index on counted plays'],
      code: `WITH days AS (
    SELECT DISTINCT track_key, full_date FROM v_listen
), islands AS (
    SELECT track_key, full_date,
           full_date - (ROW_NUMBER() OVER (
               PARTITION BY track_key ORDER BY full_date))::int AS island
    FROM days
)
SELECT track_key, COUNT(*) AS days_in_a_row
FROM islands GROUP BY track_key, island` },
    { title: 'Serve', text: 'FastAPI turns each question into an endpoint. Answers are cached, since the data only changes when I reload it, and the database login is read-only.',
      list: ['Deployed on Render', 'Song and video previews from the iTunes Search API', 'Every endpoint documented at /api/docs'],
      code: `@app.get("/api/streaks")
def streaks():
    return query("streaks", """
        SELECT track_name, artist_name, days_in_a_row, started, ended
        FROM v_song_streaks
        ORDER BY days_in_a_row DESC, started LIMIT 8""")` },
];
const showStep = i => {
    const st = STEPS[i];
    $('#stepPanel').innerHTML = `<div><h3>${st.title}</h3><p>${esc(st.text)}</p><ul>${st.list.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <pre class="code">${st.code.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/&lt;span class="c"&gt;(.*?)&lt;\/span&gt;/g, '<span class="c">$1</span>')}</pre>`;
    document.querySelectorAll('#steps button').forEach((b, j) => b.setAttribute('aria-selected', j === i));
};
$('#steps').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showStep(+b.dataset.step); });
showStep(0);

// ---------- the star schema ----------
const TABLES = {
    fact_play: ['One row per play, the heart of the model. Short plays stay in, because they are the skips.', ['play_key', 'track_key', 'date_key', 'session_key', 'played_at', 'hour', 'ms_played', 'counted', 'skipped', 'shuffle']],
    dim_track: ['One row per song. Spotify lists one song under several IDs, so the pipeline merges them.', ['track_key', 'track_name', 'artist_key', 'album_key', 'spotify_uri', 'first_played']],
    dim_artist: ['Every artist I have played, once.', ['artist_key', 'artist_name']],
    dim_album: ['Albums, tied to their artist.', ['album_key', 'album_name', 'artist_key']],
    dim_date: ['A calendar row for every day, so any question works by day, month, season or year.', ['date_key', 'full_date', 'year', 'month', 'weekday', 'is_weekend', 'season']],
    dim_session: ['A stretch of listening with no gap longer than 30 minutes.', ['session_key', 'started_at', 'ended_at', 'play_count', 'minutes']],
};
const showTable = t => {
    const [text, cols] = TABLES[t];
    $('#tableDetail').innerHTML = `<p><b>${t}</b>: ${esc(text)}</p>${cols.map(c => `<code>${c}</code>`).join('')}`;
    document.querySelectorAll('.tbl').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === t));
};
$('#schema').addEventListener('click', e => { const b = e.target.closest('.tbl'); if (b) showTable(b.dataset.t); });
showTable('fact_play');

// ---------- your turn: do I listen to your favorite artist? ----------
// suggestions: my own list under the box, names that start with what you typed first
let artistNames = [];
api('artist-names').then(names => { artistNames = names; });
const input = $('#artistInput'), suggest = $('#artistSuggest');
let picked = -1;
const closeSuggest = () => { suggest.hidden = true; input.setAttribute('aria-expanded', 'false'); picked = -1; };
const markPicked = () => suggest.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', i === picked));
input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 1) return closeSuggest();
    const starts = artistNames.filter(n => n.toLowerCase().startsWith(q));
    const has = artistNames.filter(n => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
    const list = [...starts, ...has].slice(0, 6);
    if (!list.length || (list.length === 1 && list[0].toLowerCase() === q)) return closeSuggest();
    suggest.innerHTML = list.map((n, i) => `<li role="option" id="sug-${i}" aria-selected="false" data-name="${esc(n)}">${esc(n)}</li>`).join('');
    suggest.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    picked = -1;
});
input.addEventListener('keydown', e => {
    if (suggest.hidden) return;
    const items = suggest.querySelectorAll('li');
    if (e.key === 'ArrowDown') { e.preventDefault(); picked = (picked + 1) % items.length; markPicked(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); picked = (picked - 1 + items.length) % items.length; markPicked(); }
    else if (e.key === 'Enter' && picked >= 0) { e.preventDefault(); input.value = items[picked].dataset.name; closeSuggest(); $('#artistForm').requestSubmit(); }
    else if (e.key === 'Escape') closeSuggest();
});
suggest.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    input.value = li.dataset.name;
    closeSuggest();
    $('#artistForm').requestSubmit();
});
input.addEventListener('blur', () => setTimeout(closeSuggest, 100));
$('#artistForm').addEventListener('submit', async e => {
    e.preventDefault();
    closeSuggest();
    const card = $('#artistCard'), name = $('#artistInput').value.trim();
    if (name.length < 2) return;
    let a;
    try { a = await api(`artist?name=${encodeURIComponent(name)}`); } catch { return; }
    card.hidden = false;
    if (!a.listens) {
        card.className = 'artist-card none';
        card.innerHTML = `<div><h3>Not once in four years.</h3><p>I've never played ${esc(a.artist_name)}. Send me your favorite song of theirs and I'll give it a real listen.</p>
            <a class="pill solid" href="https://www.linkedin.com/in/suhxnitiwari/" target="_blank" rel="noopener">Send it to me on LinkedIn ↗</a></div>`;
        return;
    }
    card.className = 'artist-card';
    const verdict = a.rank <= 10 ? 'Top ten. We have taste in common.' : a.rank <= 100 ? 'Definitely in my rotation.' : 'We have met a few times.';
    card.innerHTML = `
        <div><p class="label">Yes, I listen to</p><h3>${esc(a.artist_name)}</h3><p>${verdict}</p></div>
        <div><p class="label">Rank</p><p class="big">#${fmt(a.rank)}</p><p>of ${fmt(a.of_artists)} artists</p></div>
        <div><p class="label">Hours</p><p class="big">${fmt(a.hours)}</p><p>${fmt(a.listens)} listens</p></div>
        <div><p class="label">First listen</p><p class="big">${dayName(a.first_listen)}</p></div>
        <div class="top">${playButton(a.top_song, a.artist_name)}<div><b>${esc(a.top_song)}</b><br><span class="muted">My most-played of theirs, ${fmt(a.top_song_listens)} listens</span></div></div>`;
});
