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
const songOpen = (title, artist) => `<button type="button" class="song-open" data-title="${esc(title)}" data-artist="${esc(artist)}">${esc(title)}</button>`;
const songRow = (s, extra) => `<li>${playButton(s.track_name, s.artist_name)}<div><b>${songOpen(s.track_name, s.artist_name)}</b><span>${esc(s.artist_name)}</span></div><em>${extra}</em></li>`;

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

// ---------- how it works: 25 ticks for the ROW_NUMBER card ----------
document.querySelectorAll('.sci .ticks').forEach(g => {
    g.innerHTML = Array.from({ length: 25 }, (_, i) => `<rect x="${30 + i * 9.7}" y="${i === 24 ? 60 : 72}" width="6" height="${i === 24 ? 44 : 32}" rx="1.5" class="${i === 24 ? 'acf' : 'bar2'}"/>`).join('');
});

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

// ---------- takeaways: one computed line under each chart, so it reads as analysis, not just a picture ----------
const takeaway = (id, text) => { const el = document.getElementById(id); if (el) el.innerHTML = `<b>Takeaway</b>${text}`; };
const monthLong = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
Promise.all(['summary', 'months', 'clock', 'streaks', 'years', 'obsessions', 'top-songs', 'skips', 'days'].map(api))
.then(([s, months, clock, streaks, years, obs, top, skips, days]) => {
    const star = s.top_artist.artist_name;
    const owned = months.filter(m => m.era_artist === star);
    const peakShare = owned.reduce((a, b) => (b.share_pct > a.share_pct ? b : a));
    takeaway('tk-months', `${esc(star)} owned ${owned.length} of my ${months.length} months, and ${Math.floor(s.top_artist.hours / s.hours * 100)}% of everything I played. Her strongest month was ${monthLong(peakShare.month)}, at ${peakShare.share_pct}% of my listening.`);

    const ys = [...new Set(clock.map(c => c.year))];
    const peaks = ys.map(y => clock.filter(c => c.year === y).reduce((a, b) => (b.share_pct > a.share_pct ? b : a)).hour);
    const last = ys[ys.length - 1];
    const late = clock.filter(c => c.year === last && c.hour < 6).reduce((t, c) => t + c.share_pct, 0);
    takeaway('tk-clock', `Every year my busiest hour lands between ${hourName(Math.min(...peaks))} and ${hourName(Math.max(...peaks))}. In ${last}, only ${late.toFixed(1)}% of my listening happened between midnight and 6 AM.`);

    const byStar = streaks.filter(r => r.artist_name === star).length;
    const april = streaks.filter(r => r.started.startsWith('2024-04')).length;
    takeaway('tk-streaks', `${byStar} of my ${streaks.length} longest streaks are ${esc(star)} songs${april > 1 ? `, and ${april} of them ran at the same time in April 2024` : ''}. A streak isn't one song on repeat: it's a song I came back to every single day.`);


    const topNames = new Set(top.map(t => `${t.track_name}|${t.artist_name}`));
    const lasting = obs.filter(o => topNames.has(`${o.track_name}|${o.artist_name}`)).length;
    takeaway('tk-obs', lasting === 0
        ? `None of my fastest obsessions made my all-time top 40. The songs I binge hardest aren't the ones I keep: those build up slowly, over years.`
        : `Only ${lasting} of my ${obs.length} fastest obsessions made my all-time top 40. Binging a song and keeping it are different things.`);

    const starSkip = skips.least.concat(skips.most).find(r => r.artist_name === star);
    takeaway('tk-skips', starSkip
        ? `Even ${esc(star)}, my #1 artist, gets skipped ${starSkip.skip_pct}% of the time. A skip usually means "not this one right now," not "not this artist."`
        : `The artists I skip most are the ones shuffle hands me, not the ones I choose.`);
});

// ---------- loyalty: who stayed #1, what I played every year, how concentrated my listening is ----------
api('loyalty').then(L => {
    $('#loyalYears').innerHTML = L.yearly.map(y => `<div><span>${y.year}</span><b>${esc(y.artist_name)}</b><small>${fmt(y.hours)} hours</small></div>`).join('');
    const pct = (a, b) => Math.round(a / b * 100);
    const same = L.yearly.every(y => y.artist_name === L.yearly[0].artist_name);
    $('#loyalStats').innerHTML = [
        [same ? `${L.yearly.length} of ${L.yearly.length}` : `${L.yearly.length}`, same ? `years with the same #1 artist` : 'years of #1 artists'],
        [`${pct(L.top_artist_days, L.listening_days)}%`, `of my listening days had ${esc(L.yearly[0].artist_name)} in them`],
        [fmt(L.songs_every_year), `songs I played every single year`],
        [`${L.top10_share}%`, `of all my listening goes to just 10 artists`],
    ].map(([n, t]) => `<div><dt>${n}</dt><dd>${t}</dd></div>`).join('');
    $('#loyalSongs').innerHTML = L.songs.map(t => songRow(t, `${fmt(t.listens)} listens`)).join('');
    takeaway('tk-loyal', `Loyal, not closed off: ${fmt(L.one_listen_artists)} of my ${fmt(L.artists)} artists got exactly one listen. I try a lot of music, and I keep a little of it forever.`);
});

// ---------- chapter 01: most plays in one day ----------
api('days').then(rows => {
    $('#bigDays').innerHTML = rows.slice(0, 5).map(r => songRow(r, `${r.listens} plays, ${dayName(r.full_date)}`)).join('');
});

// ---------- chapter 02: the dynasty, one square per month colored by its #1 artist ----------
api('dynasty').then(months => {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wins = {};
    months.forEach(m => wins[m.winner] = (wins[m.winner] || 0) + 1);
    const order = Object.keys(wins).sort((a, b) => wins[b] - wins[a]);
    const PALETTE = ['#D65478', '#F7E9E8', '#8C6BB1', '#C9A36B', '#6FA3A0', '#E07A5F', '#7D8FB3'];
    const color = name => PALETTE[order.indexOf(name) % PALETTE.length];
    const ink = name => ['#F7E9E8', '#C9A36B'].includes(color(name)) ? '#22090F' : '#FFF6F4';
    const byKey = Object.fromEntries(months.map((m, i) => [m.month.slice(0, 7), i]));
    const years = [...new Set(months.map(m => m.month.slice(0, 4)))];
    const grid = $('#dynGrid');
    grid.innerHTML = `<span></span>${MON.map(m => `<span class="dyn-m">${m[0]}</span>`).join('')}` + years.map(y =>
        `<span class="dyn-y">${y}</span>` + MON.map((_, k) => {
            const key = `${y}-${String(k + 1).padStart(2, '0')}`, i = byKey[key];
            if (i === undefined) return '<span class="dyn-empty"></span>';
            const m = months[i];
            return `<button type="button" class="dyn-cell" data-i="${i}" style="background:${color(m.winner)}" aria-label="${monthName(m.month)}: ${esc(m.winner)}"></button>`;
        }).join('')).join('');
    const show = i => {
        const m = months[i];
        grid.querySelectorAll('.dyn-cell').forEach(c => c.setAttribute('aria-pressed', +c.dataset.i === i));
        $('#dynCard').innerHTML = `
            <p class="label">${monthName(m.month)}</p>
            <h3><i style="background:${color(m.winner)}"></i>${esc(m.winner)}</h3>
            <p class="big">${m.share_pct}%</p><p class="muted">of my listening that month</p>
            ${m.runner_up ? `<p class="dyn-runner">Runner-up: <b>${esc(m.runner_up)}</b>, ${m.runner_up_pct}%</p>` : ''}
            <div class="dyn-song">${playButton(m.song, m.song_artist)}<div><b>${esc(m.song)}</b><span>Song of the month, ${m.song_listens} listens</span></div></div>`;
    };
    grid.addEventListener('click', e => { const c = e.target.closest('.dyn-cell'); if (c) show(+c.dataset.i); });
    $('#dynLegend').innerHTML = order.map(n => `<span><i style="background:${color(n)}"></i>${esc(n)} <b>${wins[n]}</b></span>`).join('');
    // reigns: runs of the same #1 artist in consecutive months
    const runs = [];
    months.forEach((m, i) => {
        const last = runs[runs.length - 1];
        if (last && last.name === m.winner) { last.end = i; last.len++; }
        else runs.push({ name: m.winner, start: i, end: i, len: 1 });
    });
    const span = r => r.len === 1 ? monthName(months[r.start].month) : `${monthName(months[r.start].month)} to ${monthName(months[r.end].month)}`;
    const top = [...runs].sort((a, b) => b.len - a.len).slice(0, 4);
    $('#reigns').innerHTML = top.map(r => `<li><i style="background:${color(r.name)}"></i><div><b>${esc(r.name)}</b><span>${span(r)}</span></div><em>${r.len} ${r.len === 1 ? 'month' : 'months'}</em></li>`).join('');
    const king = order[0];
    const others = runs.filter(r => r.name !== king);
    const byArtist = {};
    others.forEach(r => (byArtist[r.name] = byArtist[r.name] || []).push(r));
    $('#usurpers').innerHTML = Object.entries(byArtist).sort((a, b) => wins[b[0]] - wins[a[0]]).map(([name, rs]) =>
        `<li><i style="background:${color(name)}"></i><div><b>${esc(name)}</b><span>${rs.map(span).join('; ')}</span></div><em>${wins[name]} ${wins[name] === 1 ? 'month' : 'months'}</em></li>`).join('');
    const longest = top[0], second = order[1];
    const secondRuns = runs.filter(r => r.name === second);
    takeaway('tk-dyn', `${esc(king)} ruled ${wins[king]} of ${months.length} months, including ${longest.len} in a row, from ${monthName(months[longest.start].month)} to ${monthName(months[longest.end].month)}. ${esc(second)} took the throne ${secondRuns.length} ${secondRuns.length === 1 ? 'time' : 'times'} but never held it longer than ${Math.max(...secondRuns.map(r => r.len))} ${Math.max(...secondRuns.map(r => r.len)) === 1 ? 'month' : 'months'}.`);
    show(months.length - 1);
});

// ---------- chapter 05: discovery, how much of each year was new to me ----------
api('discovery').then(rows => {
    $('#disc').innerHTML = rows.map(r => `
        <div class="disc-row">
            <b class="disc-y">${r.year}</b>
            <div class="disc-bar" title="${r.new_song_share}% of listens went to songs new that year"><i style="width:${r.new_song_share}%"></i><span>${r.new_song_share}% of listens to new songs</span></div>
            <p><b>${fmt(r.new_songs)}</b> new songs</p>
            <p><b>${fmt(r.new_artists)}</b> new artists</p>
        </div>`).join('');
    const later = rows.slice(2);
    const avg = later.reduce((t, r) => t + r.new_song_share, 0) / later.length;
    const lowArtist = rows.slice(1).reduce((a, b) => (b.new_artist_share < a.new_artist_share ? b : a));
    takeaway('tk-disc', `After 2023, only about ${Math.round(avg)}% of my listening each year went to songs I'd never heard before. In ${lowArtist.year}, just ${lowArtist.new_artist_share}% went to brand-new artists. I explore, but mostly I return.`);
});

// ---------- shared: every month in the history, for sparklines ----------
const MONTH_KEYS = api('months').then(ms => ms.map(m => m.month.slice(0, 7)));
const spark = (byMonth, keys, hot) => {
    const vals = keys.map(k => (byMonth || {})[k] || 0), max = Math.max(1, ...vals), w = 600 / keys.length;
    return `<svg class="spark" viewBox="0 0 600 70" preserveAspectRatio="none" aria-hidden="true">${vals.map((v, i) =>
        `<rect x="${i * w + 0.5}" y="${70 - Math.max(v ? 2 : 0, v / max * 66)}" width="${w - 1}" height="${Math.max(v ? 2 : 0, v / max * 66)}" rx="1" class="${keys[i] === hot ? 'hot' : ''}"/>`).join('')}</svg>
        <div class="spark-axis"><span>${monthName(keys[0] + '-01')}</span><span>${monthName(keys[keys.length - 1] + '-01')}</span></div>`;
};
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ---------- 3: the life of a song, opened from any song title ----------
const life = $('#life');
$('#lifeClose').addEventListener('click', () => life.close());
life.addEventListener('click', e => { if (e.target === life) life.close(); });
document.addEventListener('click', async e => {
    const b = e.target.closest('.song-open');
    if (!b) return;
    const [s, keys] = await Promise.all([api(`song?title=${encodeURIComponent(b.dataset.title)}&artist=${encodeURIComponent(b.dataset.artist)}`).catch(() => null), MONTH_KEYS]);
    if (!s) return;
    const comeback = s.longest_gap > 30 && s.gap_to < s.last_listen;
    const facts = [
        ['First listen', dayName(s.first_listen)],
        ['25th listen', s.twenty_fifth ? `${dayName(s.twenty_fifth)}, ${daysBetween(s.first_listen, s.twenty_fifth) === 0 ? 'same day' : daysBetween(s.first_listen, s.twenty_fifth) + ' days later'}` : 'Not yet'],
        ['Biggest day', `${s.peak_day_plays} plays, ${dayName(s.peak_day)}`],
        ['Peak month', `${monthName(s.peak_month + '-01')}, ${s.peak_month_plays} listens`],
        ['Longest streak', `${s.longest_streak} ${s.longest_streak === 1 ? 'day' : 'days in a row'}`],
        ['Longest silence', s.longest_gap > 1 ? `${s.longest_gap} days, ${dayName(s.gap_from)} to ${dayName(s.gap_to)}` : 'None, it never left'],
        ['Last listen', dayName(s.last_listen)],
        ['All time', `${fmt(s.listens)} listens`],
    ];
    $('#lifeBody').innerHTML = `
        <p class="eyebrow">The life of a song</p>
        <div class="life-head">${playButton(s.track_name, s.artist_name)}<div><h3 id="lifeTitle">${esc(s.track_name)}</h3><p>${esc(s.artist_name)}</p></div></div>
        ${spark(s.by_month, keys, s.peak_month)}
        <dl class="life-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        <p class="takeaway"><b>The arc</b>${comeback
            ? `It went quiet for ${s.longest_gap} days and came back. That's a song I keep returning to.`
            : s.twenty_fifth && daysBetween(s.first_listen, s.twenty_fifth) <= 7 ? 'Instant obsession: 25 listens inside a week.' : 'A slow burn: it grew on me over time.'}</p>`;
    life.showModal();
});

// ---------- 3: fuller artist results in "Your turn" ----------
const artistCard = $('#artistCard');
new MutationObserver(async () => {
    if (artistCard.dataset.done === artistCard.innerHTML.length + '' || artistCard.classList.contains('none') || !artistCard.querySelector('h3')) return;
    const name = artistCard.querySelector('h3').textContent;
    const [a, keys] = await Promise.all([api(`artist-life?name=${encodeURIComponent(name)}`).catch(() => null), MONTH_KEYS]);
    if (!a || artistCard.querySelector('h3')?.textContent !== name) return;
    artistCard.insertAdjacentHTML('beforeend', `
        <div class="artist-life">
            <p class="label">Our history</p>
            ${spark(a.by_month, keys, a.peak_month)}
            <dl class="life-facts">
                <div><dt>Peak month</dt><dd>${monthName(a.peak_month + '-01')}, ${fmt(a.peak_month_plays)} listens</dd></div>
                <div><dt>Longest streak</dt><dd>${a.longest_streak} days in a row</dd></div>
                <div><dt>Biggest day</dt><dd>${a.peak_day_plays} plays, ${dayName(a.peak_day)}</dd></div>
                <div><dt>Last listen</dt><dd>${dayName(a.last_listen)}</dd></div>
            </dl>
            <p class="label">Top songs, tap one for its story</p>
            <ol class="artist-top">${a.top_songs.map(t => `<li>${songOpen(t.track_name, name)} <span>${fmt(t.listens)} listens</span></li>`).join('')}</ol>
        </div>`);
    artistCard.dataset.done = artistCard.innerHTML.length + '';
}).observe(artistCard, { childList: true });

// ---------- 4: how I changed, year by year ----------
api('change').then(rows => {
    const METRICS = [
        ['hours', 'Hours of music', v => fmt(v)],
        ['hours_per_day', 'Hours per listening day', v => v],
        ['artists', 'Different artists', v => fmt(v)],
        ['songs', 'Different songs', v => fmt(v)],
        ['listens_per_song', 'Listens per song', v => v],
        ['top10_share', 'Share going to my top 10 artists', v => v + '%'],
        ['skip_rate', 'Plays I skipped', v => v + '%'],
        ['peak_hour', 'Busiest hour', v => hourName(v)],
    ];
    const arrow = (cur, prev, k) => {
        if (prev === undefined || k === 'peak_hour') return '';
        const d = cur - prev; if (Math.abs(d) < 0.05) return '<i class="flat">=</i>';
        return d > 0 ? '<i class="up">↑</i>' : '<i class="down">↓</i>';
    };
    $('#change').innerHTML = `<table><thead><tr><th></th>${rows.map(r => `<th>${r.period}</th>`).join('')}</tr></thead><tbody>${METRICS.map(([k, label, f]) =>
        `<tr><th>${label}</th>${rows.map((r, i) => `<td>${f(r[k])}${arrow(r[k], i ? rows[i - 1][k] : undefined, k)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const full = rows.slice(1);
    const heavy = full.reduce((a, b) => (b.hours_per_day > a.hours_per_day ? b : a));
    const repeat = full.reduce((a, b) => (b.listens_per_song > a.listens_per_song ? b : a));
    const varied = full.reduce((a, b) => (b.top10_share < a.top10_share ? b : a));
    takeaway('tk-years', `${heavy.period} was my heaviest year, ${heavy.hours_per_day} hours a day${repeat.period === heavy.period ? `, and my most repetitive: ${repeat.listens_per_song} listens per song` : ''}. ${varied.period} was my most varied: my top 10 artists got just ${varied.top10_share}% of my listening.`);
});

// ---------- 5: compare two eras ----------
MONTH_KEYS.then(keys => {
    const first = keys[0], last = keys[keys.length - 1];
    const opts = [];
    const years = [...new Set(keys.map(k => k.slice(0, 4)))];
    years.forEach(y => opts.push({ label: y, start: `${y}-01` < first ? first : `${y}-01`, end: `${y}-12` > last ? last : `${y}-12` }));
    const SEASONS = [['Spring', '03', '05'], ['Summer', '06', '08'], ['Fall', '09', '11']];
    years.forEach(y => SEASONS.forEach(([n, a, b]) => {
        const start = `${y}-${a}`, end = `${y}-${b}`;
        if (start >= first && end <= last) opts.push({ label: `${n} ${y}`, start, end });
    }));
    const fill = (sel, pick) => { sel.innerHTML = opts.map((o, i) => `<option value="${i}" ${o.label === pick ? 'selected' : ''}>${o.label}</option>`).join(''); };
    const A = $('#cmpA'), B = $('#cmpB');
    fill(A, '2023'); fill(B, '2025');
    const months = o => (+o.end.slice(0, 4) - +o.start.slice(0, 4)) * 12 + (+o.end.slice(5) - +o.start.slice(5)) + 1;
    const run = async () => {
        const oa = opts[A.value], ob = opts[B.value];
        const [a, b] = await Promise.all([oa, ob].map(o => api(`period?start=${o.start}&end=${o.end}`)));
        const ma = months(oa), mb = months(ob);
        const rows = [
            ['Top artist', x => `${esc(x.top_artist)}, ${x.top_artist_share}%`],
            ['Top song', x => `${songOpen(x.top_song, x.top_song_artist)}`],
            ['Hours per listening day', x => x.hours_per_day],
            ['Different artists', x => fmt(x.artists)],
            ['New artists per month', (x, m) => (x.new_artists / m).toFixed(1)],
            ['Listens per song', x => x.listens_per_song],
            ['Share going to my top 10 artists', x => x.top10_share + '%'],
            ['Busiest hour', x => hourName(x.peak_hour)],
        ];
        $('#cmpTable').innerHTML = `<table><thead><tr><th></th><th>${oa.label}</th><th>${ob.label}</th></tr></thead><tbody>${rows.map(([l, f]) =>
            `<tr><th>${l}</th><td>${f(a, ma)}</td><td>${f(b, mb)}</td></tr>`).join('')}</tbody></table>`;
        if (oa.label === ob.label) { $('#cmpSummary').textContent = 'Pick two different eras.'; return; }
        const explorer = a.new_artists / ma > b.new_artists / mb ? [oa, a, ma] : [ob, b, mb];
        const repeater = a.listens_per_song > b.listens_per_song ? [oa, a] : [ob, b];
        const other = repeater[0] === oa ? b : a;
        const explored = `${(explorer[1].new_artists / explorer[2]).toFixed(1)} new artists a month`, repeated = `${repeater[1].listens_per_song} listens per song, against ${other.listens_per_song}`;
        $('#cmpSummary').innerHTML = explorer[0] === repeater[0]
            ? `<b>${explorer[0].label} me explored more and repeated more</b>: ${explored}, and ${repeated}.`
            : `<b>${explorer[0].label} me explored more</b> (${explored}). <b>${repeater[0].label} me repeated more</b> (${repeated}).`;
    };
    A.addEventListener('change', run); B.addEventListener('change', run);
    run();
});
