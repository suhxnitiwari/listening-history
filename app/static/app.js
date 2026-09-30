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
});

// ---------- streak race: bars grow when the section scrolls into view ----------
api('streaks').then(rows => {
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
