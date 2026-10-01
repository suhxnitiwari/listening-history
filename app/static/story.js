/*
 * 91,210 Receipts: my Spotify as a story, then yours.
 * Every scene asks a question about a person and answers it from their own history.
 * © 2026 Suhani Tiwari. All rights reserved.
 */
(function () {
    const $ = s => document.querySelector(s);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = n => Math.round(n).toLocaleString('en-US');
    const day = iso => new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const monthName = ym => new Date(ym + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const hour = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
    const clock = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
                    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
                    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private window */ } } };

    const state = { suhani: null, extras: {}, you: null, sound: false };

    // ---------- covers and previews ----------
    // My songs come from my own API (exact covers by the Spotify ID I played). A visitor's songs are looked up straight
    // from the browser on Apple's iTunes Search, so their history never touches my server.
    const lookups = new Map();
    function itunes(track, artist) {
        const key = track + '|' + artist;
        if (!lookups.has(key)) lookups.set(key, new Promise(resolve => {
            const cb = 'it' + Math.random().toString(36).slice(2), s = document.createElement('script');
            const done = v => { clearTimeout(timer); delete window[cb]; s.remove(); resolve(v || null); };
            const timer = setTimeout(() => done(null), 7000);
            window[cb] = d => done(d && d.results && d.results[0]);
            s.src = `https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + track)}&entity=song&limit=1&callback=${cb}`;
            s.onerror = () => done(null);
            document.head.appendChild(s);
        }));
        return lookups.get(key);
    }
    const mine = p => p && p.who === 'Suhani';
    function cover(track, artist, cls = 'cover', p = current) {
        if (mine(p)) return `<img class="${cls}" alt="" src="/api/art?title=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}&big=true" onerror="this.style.visibility='hidden'">`;
        return `<img class="${cls}" alt="" data-track="${esc(track)}" data-artist="${esc(artist)}">`;
    }
    function face(name, cls = 'cover round', p = current) {
        if (mine(p)) return `<img class="${cls}" alt="" src="/api/artist-art?name=${encodeURIComponent(name)}" onerror="this.style.visibility='hidden'">`;
        return `<img class="${cls}" alt="" data-artist-only="${esc(name)}">`;
    }
    async function hydrate(root) {
        for (const im of root.querySelectorAll('img[data-track], img[data-artist-only]')) {
            const it = im.dataset.track ? await itunes(im.dataset.track, im.dataset.artist) : await itunes('', im.dataset.artistOnly);
            if (it && it.artworkUrl100) im.src = it.artworkUrl100.replace('100x100bb', '600x600bb'); else im.style.visibility = 'hidden';
            im.removeAttribute('data-track'); im.removeAttribute('data-artist-only');
        }
    }
    async function previewUrl(track, artist, p) {
        if (mine(p)) { try { const r = await fetch(`/api/preview?title=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}`); return r.ok ? (await r.json()).url : null; } catch (e) { return null; } }
        const it = await itunes(track, artist); return it && it.previewUrl;
    }

    // ---------- sound: each scene can carry a song; entering the scene plays its preview ----------
    const audio = $('#audio');
    let fadeTimer, nowKey = '';
    function fadeTo(target, then) {
        clearInterval(fadeTimer);
        fadeTimer = setInterval(() => {
            const v = audio.volume + (target > audio.volume ? 0.08 : -0.08);
            audio.volume = Math.max(0, Math.min(1, v));
            if (Math.abs(audio.volume - target) < 0.09) { audio.volume = target; clearInterval(fadeTimer); then && then(); }
        }, 40);
    }
    async function play(song, p) {
        if (!state.sound || !song) return;
        const key = song.track + '|' + song.artist;
        if (key === nowKey) return;
        nowKey = key;
        const url = await previewUrl(song.track, song.artist, p);
        if (!url || nowKey !== key) return;
        fadeTo(0, () => { audio.src = url; audio.volume = 0; audio.play().then(() => fadeTo(0.8)).catch(() => {}); });
    }
    function setSound(on) {
        state.sound = on;
        $('#soundBtn').textContent = on ? '[Sound on]' : '[Sound off]';
        $('#soundBtn').setAttribute('aria-pressed', on);
        if (!on) { fadeTo(0, () => audio.pause()); nowKey = ''; } else { const s = document.querySelector('.scene.in[data-song]'); if (s) play(JSON.parse(s.dataset.song), current); }
    }
    $('#soundBtn').addEventListener('click', () => setSound(!state.sound));

    // ---------- share cards: a 1080×1920 image of any answer ----------
    function shareCard({ eyebrow, big, line, sub }) {
        const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
        const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 1920);
        grad.addColorStop(0, '#FFFBF8'); grad.addColorStop(1, '#FAF1EF'); g.fillStyle = grad; g.fillRect(0, 0, 1080, 1920);
        g.fillStyle = '#8C7770'; g.font = '500 36px "JetBrains Mono", monospace'; g.fillText(eyebrow.toUpperCase(), 90, 520);
        g.fillStyle = '#D65478'; let size = 300; g.font = `400 ${size}px "Bodoni Moda", Georgia, serif`;
        while (g.measureText(big).width > 900 && size > 90) { size -= 10; g.font = `400 ${size}px "Bodoni Moda", Georgia, serif`; }
        g.fillText(big, 84, 520 + size + 20);
        g.fillStyle = '#3A2626'; g.font = '400 58px "Bodoni Moda", Georgia, serif';
        const words = line.split(' '); let ln = '', y = 520 + size + 130;
        for (const w of words) { if (g.measureText(ln + w).width > 900) { g.fillText(ln, 90, y); ln = ''; y += 76; } ln += w + ' '; }
        g.fillText(ln, 90, y);
        if (sub) { g.fillStyle = '#76344E'; g.font = '600 52px Caveat, cursive'; g.fillText(sub, 90, y + 90); }
        g.fillStyle = '#8C7770'; g.font = '500 30px "JetBrains Mono", monospace'; g.fillText('WHAT DOES YOUR SPOTIFY KNOW ABOUT YOU?', 90, 1740); g.fillStyle = '#76344E'; g.fillText('LISTENING-HISTORY.ONRENDER.COM', 90, 1795);
        c.toBlob(async blob => {
            const file = new File([blob], 'my-spotify-receipt.png', { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My Spotify receipt' }); return; } catch (e) { /* fall back to download */ } }
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }, 'image/png');
    }

    // ---------- the story: one scene per question ----------
    let current = null;
    function scenes(p, other) {
        const me = mine(p), W = (a, b) => me ? a : b, they = other && (mine(other) ? 'Suhani' : 'you');
        const vs = (txt) => other ? `<div class="vs r d3">${txt}</div>` : '';
        const kind = k => `<p class="kind r d4">${k === 'o' ? '<b>Observed</b>: Spotify recorded it' : k === 'c' ? '<b>Calculated</b>: derived from the plays' : '<b>Inferred</b>: a proxy, read with care'}</p>`;
        const stamp = '<span class="stamp r">A question Spotify never asked</span>';
        const top = p.topArtists[0], out = [];
        const add = (s) => s && out.push(s);

        add({ id: 'open', hero: true, html: `
            <p class="eyebrow r">${W('A listening story · Suhani Tiwari', 'Your listening story')}</p>
            <h1 class="r d1">${W("I've pressed play", "You've pressed play")} <em>${fmt(p.listens)}</em> times. Here's what ${W('it knows about me', 'it knows about you')}.</h1>
            <div class="meta mono r d1"><span>${day(p.firstDay)} — ${day(p.lastDay)}</span><span>•</span><span>${fmt(p.hours)} hours</span><span>•</span><span>${fmt(p.songs)} songs</span><span>•</span><span>${fmt(p.artists)} artists</span></div>
            <div class="table r d2" data-crate>
                <div class="crate"></div>
                <div class="nowplaying"><p class="scribble">pick a record, any record. drag it onto the turntable ↓</p></div>
                <div class="deck"><div class="platter"><img class="labelart" alt=""></div><div class="arm"></div><p class="hint scribble">drop it here ↓</p></div>
            </div>
            <div class="index r d3" data-index></div>` });

        add({ id: 'hours', center: true, share: { eyebrow: W('I have spent', 'I have spent'), big: `${fmt(p.hours)} h`, line: `listening to music. That's ${fmt(p.hours / 24)} days of my life.` }, html: `
            <p class="eyebrow r">${day(p.firstDay)} → ${day(p.lastDay)}</p>
            <h2 class="r d1">${W("I've spent", "You've spent")}</h2>
            <div class="giant r d1" data-count="${p.hours}">${fmt(p.hours)}</div>
            <h2 class="r d2">hours listening to music.</h2>
            <p class="lede r d3">That's ${fmt(p.hours / 24)} days${p.hours / 24 > 182 ? ', more than half a year' : ''}. ${fmt(p.songs)} songs, ${fmt(p.artists)} artists.</p>
            <p class="lede r d4">${W('I already know what I listened to. I wanted to know what my listening knows about me.', 'You already know what you listened to. Here\'s what your listening knows about you.')}</p>` });

        // PART I: the things I love too much
        const ribbon = `<svg class="strip" viewBox="0 0 ${p.months.length * 12} 70">${p.months.map((m, i) => `<rect x="${i * 12 + 1}" y="0" width="10" height="70" rx="2" fill="${m.winner === top.name ? '#D65478' : '#E9D6D2'}" style="transition-delay:${i * 25}ms"><title>${m.month}: ${esc(m.winner)}</title></rect>`).join('')}</svg>`;
        add({ id: 'main', center: true, song: p.topSongs[0], share: { eyebrow: 'The main character of my music', big: `${p.owned}/${p.months.length}`, line: `months had the same #1 artist: ${top.name}.` }, html: `
            <p class="eyebrow r">Part I · The things ${W('I', 'you')} love too much</p>
            <h2 class="r">${p.months.length} months of listening.</h2>
            <h2 class="r d1">One artist won <span style="color:var(--pink)">${p.owned}</span> of them.</h2>
            <div class="r d2" style="margin:26px 0">${ribbon}</div>
            <div class="whoguess r d3"><p class="lede">Guess who.</p><div class="faces">${shuffle(p.topArtists.slice(0, 4)).map(a => `<button data-who="${esc(a.name)}" aria-label="${esc(a.name)}">${face(a.name, 'cover round', p)}<span>${esc(a.name)}</span></button>`).join('')}</div></div>
            <div class="whoreveal hidden"><div class="row" style="justify-content:center">${face(top.name, 'cover big round', p)}</div>
            <h1 style="margin-top:14px">${esc(top.name)}</h1><p class="lede whomsg"></p>
            <p class="lede">${Math.round(p.topShare)}% of everything. ${fmt(top.hours)} hours${p.nextFourHours < top.hours ? ', more than the next four artists combined' : ''}.</p>
            ${vs(other ? `${they === 'Suhani' ? 'Suhani' : 'You'}: ${esc(other.topArtists[0].name)} won ${other.owned} of ${other.months.length} months.` : '')}${kind('c')}</div>`, wire: el => {
                el.querySelectorAll('[data-who]').forEach(b => b.addEventListener('click', () => {
                    const right = b.dataset.who === top.name;
                    el.querySelector('.whoguess').remove(); const rv = el.querySelector('.whoreveal'); rv.classList.remove('hidden');
                    rv.querySelector('.whomsg').textContent = right ? 'Obviously. You got it.' : `Not ${b.dataset.who}. It was never going to be anyone else.`;
                }));
            } });

        if (p.heir) add({ id: 'without', center: true, html: `
            ${stamp}<h2 class="r">Okay, but who ${W('am I', 'are you')} without ${esc(top.name)}?</h2>
            <p class="lede r d1">Remove ${W('her', 'them')}. Recount every month.</p>
            <div class="r d1" style="margin:22px 0 8px"><svg class="strip heirribbon" viewBox="0 0 ${p.months.length * 12} 70">${p.months.map((m, i) => `<rect x="${i * 12 + 1}" y="0" width="10" height="70" rx="2" fill="${m.winner === top.name ? '#D65478' : '#E9D6D2'}" data-with="${m.winner === top.name ? '#D65478' : '#E9D6D2'}" data-without="${p.heirMonths[i] === p.heir.name ? '#6C9BC9' : '#E9D6D2'}" style="transition:fill .5s ${i * 15}ms, transform .5s"><title>${m.month}: ${esc(m.winner)} → ${esc(p.heirMonths[i] || '')}</title></rect>`).join('')}</svg></div>
            <div class="r d1"><button class="btn" data-remove>Remove ${esc(top.name)}</button></div>
            <div class="heirreveal" style="opacity:.0;transition:opacity .8s"><div class="row" style="justify-content:center;margin-top:24px">${face(p.heir.name, 'cover big round', p)}</div>
            <h1 style="margin-top:14px">${esc(p.heir.name)}</h1>
            <p class="lede">would have won ${p.heir.months} of ${p.months.length} months. Underneath ${W('my', 'your')} favorite, there's a whole second favorite.</p></div>${kind('c')}`, wire: el => {
                let removed = false; const b = el.querySelector('[data-remove]');
                b.addEventListener('click', () => { removed = !removed;
                    el.querySelectorAll('.heirribbon rect').forEach(r => r.setAttribute('fill', removed ? r.dataset.without : r.dataset.with));
                    el.querySelector('.heirreveal').style.opacity = removed ? 1 : 0;
                    b.textContent = removed ? `Put ${top.name} back` : `Remove ${top.name}`; });
            } });

        if (p.fastest) {
            const f = p.fastest, span = Math.max(7, f.days + 1), len = 40 + (f.days + 0.5) / span * 600;
            add({ id: 'fuse', center: true, song: f, share: { eyebrow: 'From first play to obsessed', big: f.days === 0 ? 'same day' : f.days === 1 ? '1 day' : `${f.days} days`, line: `"${f.track}" went from my first listen to ${f.threshold} listens.` }, html: `
                ${stamp}<h2 class="r">How long does it take ${W('me', 'you')} to become obsessed?</h2>
                <div class="r d1" style="margin:30px auto;max-width:720px"><svg viewBox="0 0 720 120">${[...Array(span + 1).keys()].map(d => `<line x1="${40 + d / span * 600}" x2="${40 + d / span * 600}" y1="52" y2="68" stroke="rgba(58,38,38,.25)"/><text x="${40 + d / span * 600}" y="40" font-size="12" text-anchor="middle" fill="#8C7770">${d === 0 ? 'day 1' : 'day ' + (d + 1)}</text>`).join('')}<line x1="40" x2="640" y1="60" y2="60" stroke="rgba(58,38,38,.15)"/><circle cx="40" cy="60" r="8" fill="#3A2626"/><text x="40" y="100" font-size="14" text-anchor="middle" fill="#8C7770">first play</text>
                    <path class="draw" d="M40,60 ${[...Array(Math.ceil(len / 20)).keys()].map(k => `Q${50 + k * 20},${k % 2 ? 72 : 48} ${Math.min(40 + len, 60 + k * 20)},60`).join(' ')}" fill="none" stroke="#C98F2A" stroke-width="4"/>
                    <text class="boom" x="${40 + len}" y="74" font-size="48" text-anchor="middle" style="transition-delay:2.4s">💥</text><text x="${40 + len}" y="112" font-size="14" text-anchor="middle" fill="#8C7770">listen #${f.threshold}</text></svg></div>
                <div class="row r d2" style="justify-content:center">${cover(f.track, f.artist, 'cover', p)}<div style="text-align:left"><h3>${esc(f.track)}</h3><p class="muted">${esc(f.artist)} · first heard ${day(f.first)}</p></div></div>
                <h2 class="r d3" style="margin-top:22px;color:var(--gold)">${f.days === 0 ? 'Same. Day.' : f.days === 1 ? 'By the next day.' : f.days + ' days.'}</h2>
                ${vs(other && other.fastest ? `${they === 'Suhani' ? 'Suhani' : 'You'}: "${esc(other.fastest.track)}" in ${other.fastest.days === 0 ? 'the same day' : other.fastest.days + ' day' + (other.fastest.days === 1 ? '' : 's')}.` : '')}${kind('c')}` });
        }

        const fl = p.funnel, names = ['an audition', 'okayyy…', 'we\'re interested', 'a relationship', 'obsessed', 'basically married'];
        add({ id: 'funnel', html: `
            ${stamp}<h2 class="r">How many songs survive a second date?</h2>
            <p class="lede r d1">${W('I', 'You')} tried ${fmt(fl[0].songs)} songs. Treat it like dating. First: what share do you think got a second listen?</p>
            <div class="slideguess r d1"><input type="range" min="0" max="100" value="50" aria-label="Your guess"><b class="sv">50%</b><button class="btn">Lock it in</button></div>
            <div class="funnel hidden" style="margin-top:24px">${fl.map((f, i) => `<div class="lbl"><span>${f.at === 1 ? '1st listen' : f.at + (f.at === 2 ? 'nd' : f.at === 3 ? 'rd' : 'th') + ' listen'}<br><i>${names[i]}</i></span><div class="f" style="width:${Math.max(6, 100 * f.songs / fl[0].songs)}%;transition-delay:${i * .35}s">${fmt(f.songs)}</div></div>`).join('')}</div>
            <p class="lede funnelmsg hidden">Only ${Math.round(100 * fl[1].songs / fl[0].songs)}% got a second listen. ${fmt(fl[5].songs)} made it to 100.</p>${kind('c')}`, wire: el => {
                const r = el.querySelector('.slideguess input'), sv = el.querySelector('.sv'), real = Math.round(100 * fl[1].songs / fl[0].songs);
                r.addEventListener('input', () => sv.textContent = r.value + '%');
                el.querySelector('.slideguess button').addEventListener('click', () => {
                    const g = Number(r.value), f = el.querySelector('.funnel'), m = el.querySelector('.funnelmsg');
                    el.querySelector('.slideguess').innerHTML = `<p class="lede">You said ${g}%. ${Math.abs(g - real) <= 5 ? 'Basically right.' : g > real ? 'Too generous.' : 'Harsher than me, somehow.'}</p>`;
                    f.classList.remove('hidden'); m.classList.remove('hidden'); f.querySelectorAll('.f').forEach(x => { const w = x.style.width; x.style.width = '0'; requestAnimationFrame(() => requestAnimationFrame(() => x.style.width = w)); });
                });
            } });

        if (p.inARow) {
            const r = p.inARow, b = p.biggestDay;
            add({ id: 'row', center: true, song: r, share: { eyebrow: 'My record for "again"', big: `${r.n}×`, line: `"${r.track}" in a row. Nothing in between.` }, html: `
                <p class="eyebrow r">${W('And sometimes it becomes unreasonable', 'And sometimes it becomes unreasonable')}</p>
                <h2 class="r">What's the most times ${W("I've", "you've")} played one song in a row?</h2>
                <div class="guess r d1" data-answer="${r.n}"><input type="number" inputmode="numeric" placeholder="guess" aria-label="Your guess"><button class="btn">Reveal</button></div>
                <div class="reveal hidden">
                    <div class="giant" style="margin-top:20px">${r.n}</div>
                    <div class="row" style="justify-content:center;margin-top:10px">${cover(r.track, r.artist, 'cover', p)}<div style="text-align:left"><h3>${esc(r.track)}</h3><p class="muted">${esc(r.artist)} · ${clock(r.start)}, ${day(r.start)} → ${clock(r.end)}, ${day(r.end)}</p></div></div>
                    <div class="pop" style="margin:24px auto;max-width:640px">${dots(r.n)}</div>
                    ${b && b.n >= 20 ? `<p class="lede">The biggest single day: ${b.n} plays of "${esc(b.track)}" on ${day(b.date)}.</p>` : ''}
                    <p class="lede">${Math.round(p.replayPct)}% of all ${W('my', 'your')} listens are the song ${W("I'd", "you'd")} just finished, again.</p>
                    ${vs(other && other.inARow ? `${they === 'Suhani' ? 'Suhani' : 'You'}: ${other.inARow.n} in a row, "${esc(other.inARow.track)}".` : '')}${kind('o')}
                </div>` });
        }

        // PART II: the things that stayed, and the ones that didn't
        if (p.streak && p.streak.days >= 3) {
            const st = p.streak;
            add({ id: 'streak', center: true, song: st, share: { eyebrow: 'A song that moved in', big: `${st.days} days`, line: `in a row with "${st.track}". Didn't miss once.` }, html: `
                <p class="eyebrow r">Part II · What stayed</p>
                <h2 class="r">Some songs moved in.</h2>
                <div class="row r d1" style="justify-content:center;margin-top:20px">${cover(st.track, st.artist, 'cover', p)}<div style="text-align:left"><h3>${esc(st.track)}</h3><p class="muted">${esc(st.artist)} · from ${day(st.start)}</p></div></div>
                <div class="pop r d2" style="margin:26px auto;max-width:700px">${squares(st.days)}</div>
                <h2 class="r d3" style="color:var(--gold)">${st.days} days without missing once.</h2>${kind('o')}` });
        }

        if (p.growerCount) {
            const g = p.growers[0];
            add({ id: 'growers', center: true, song: g, share: { eyebrow: 'The second-chance club', big: fmt(p.growerCount), line: `songs I skipped the first time went on to get ${p.growerMin}+ listens.` }, html: `
                ${stamp}<h2 class="r">${W('I', 'You')} don't fall in love at first listen.</h2>
                <p class="lede r d1">Only ${p.loveAtFirstPct.toFixed(1)}% of new songs got replayed on the spot.</p>
                <h2 class="r d2" style="margin-top:22px">But ${W('I believe', 'you believe')} in second chances.</h2>
                <div class="giant gold r d2">${fmt(p.growerCount)}</div>
                <p class="lede r d2">songs ${W('I', 'you')} skipped the first time went on to get ${p.growerMin}+ listens.</p>
                ${g ? `<div class="row r d3" style="justify-content:center;margin-top:18px">${cover(g.track, g.artist, 'cover', p)}<div style="text-align:left"><h3>${esc(g.track)}</h3><p class="muted">skipped on ${day(g.first)} · ${fmt(g.listens)} listens since</p></div></div>` : ''}
                <p class="lede r d4">And ${fmt(p.putBack)} times, ${W('I', 'you')} skipped a song and came back for it within 15 minutes.</p>${kind('c')}` });
        }

        const gv = p.graveyard;
        add({ id: 'graves', center: true, share: { eyebrow: 'The song graveyard', big: fmt(gv.count), line: 'songs got one listen and never a second.' }, html: `
            <h2 class="r">Most songs didn't stay.</h2>
            <div class="giant r d1" style="color:#B9A3A9">${fmt(gv.count)}</div>
            <p class="lede r d1">songs, ${Math.round(gv.pct)}% of every song ${W("I've", "you've")} tried, got exactly one listen.</p>
            <div class="tomb r d2">${gv.graves.map(g => `<button data-play='${esc(JSON.stringify({ track: g.track, artist: g.artist }))}'>RIP<b>${esc(g.track)}</b><span class="muted">${esc(g.artist)}</span><i>tap to resurrect</i></button>`).join('')}</div>
            <p class="lede r d3">Some songs got an era. Some got one audition. Even ${esc(top.name)} has songs in here.</p>${kind('o')}` });

        if (p.comeback) {
            const c = p.comeback;
            add({ id: 'comeback', center: true, song: c, share: { eyebrow: 'Back from the dead', big: `${fmt(c.gap)} days`, line: `of silence, then "${c.track}" came back.` }, html: `
                ${stamp}<h2 class="r">But some came back from the dead.</h2>
                <div class="r d1" style="margin:28px auto;max-width:720px"><svg viewBox="0 0 720 120"><text x="20" y="30" font-size="14" fill="#8C7770">last played ${day(c.lastHeard)}</text><text x="700" y="30" font-size="14" fill="#8C7770" text-anchor="end">hello again, ${day(c.returned)}</text>
                    <path class="draw" d="M20,80 L560,80 L580,80 L595,20 L610,110 L625,50 L640,80 L700,80" fill="none" stroke="#D65478" stroke-width="4" stroke-linejoin="round"/></svg></div>
                <div class="giant r d2">${fmt(c.gap)}</div><p class="lede r d2">days of silence. Then "${esc(c.track)}" by ${esc(c.artist)} came back with ${fmt(c.after)} listens in two months.</p>${kind('c')}` });
        }

        const ret = p.retention;
        if (ret.length > 1) add({ id: 'retention', center: true, html: `
            ${stamp}<h2 class="r">How much of ${ret[0].year} ${W('me', 'you')} survives in ${ret[ret.length - 1].year}?</h2>
            <p class="lede r d1">Take ${W('my', 'your')} top ${ret[0].of} songs of ${ret[0].year}. Drag through the years and watch them fade.</p>
            <div class="r d1" style="margin-top:14px"><input class="scrub" type="range" min="0" max="${ret.length - 1}" value="0" aria-label="Year"></div>
            <div class="r d2" style="margin:24px auto;max-width:720px" data-fade='${JSON.stringify(ret.map(r => r.kept))}'>${hundred(ret[0].of)}<p class="lede" data-fade-label>${ret[0].year}: ${ret[0].of} of ${ret[0].of}</p></div>
            <p class="lede r d3">${ret[ret.length - 1].kept} of them are still playing in ${ret[ret.length - 1].year}.</p>${kind('c')}` });

        // PART III: time leaves fingerprints
        add({ id: 'eras', html: `
            <p class="eyebrow r">Part III · Time leaves fingerprints</p>
            <h2 class="r">You can tell what year it is by what ${W("I'm", "you're")} listening to.</h2>
            <div class="r d1" style="margin-top:22px">${p.years.map(y => `<div class="era" role="button" tabindex="0" data-play='${esc(JSON.stringify({ track: y.track, artist: y.artist }))}'>${cover(y.track, y.artist, 'cover', p).replace('class="cover"', 'class="cover" style="width:100px;height:100px"')}<div><span class="y">${y.year}</span><h3>${esc(y.track)}</h3><p class="muted">${esc(y.artist)} · ${fmt(y.hours)} hours · ${fmt(y.newSongs)} new songs · #1 ${esc(y.topArtist)}</p></div></div>`).join('')}</div>
            <p class="lede r d2">${p.chart.numberOnes} different songs held ${W('my', 'your')} weekly #1 across ${p.chart.weeks} weeks. ${p.chart.reign ? `The longest reign: "${esc(p.chart.reign.track)}", ${p.chart.reign.weeks} weeks.` : ''}</p>${kind('c')}` });

        // Suhani-only: how it felt, and what changed when I moved
        const ex = state.extras;
        if (me && ex.moods) {
            const yrs = {}; ex.moods.by_year.forEach(r => { (yrs[r.year] = yrs[r.year] || {})[r.mood] = r.share; });
            const ys = Object.keys(yrs).map(Number), sad = y => ['heartbreak', 'bittersweet', 'dark'].reduce((t, m) => t + (yrs[y][m] || 0), 0);
            const sd = ex.moods.saddest_days[0];
            add({ id: 'moods', center: true, song: sd, html: `
                <p class="eyebrow r">How it felt</p>
                <h2 class="r">My music got brighter.</h2>
                <div class="r d1" style="margin:24px auto;max-width:640px"><svg viewBox="0 0 640 200">${ys.map((y, i) => { const h = sad(y) * 1.8; return `<rect x="${i * 128 + 24}" y="${180 - h}" width="80" height="${h}" rx="6" fill="#6C9BC9"/><text x="${i * 128 + 64}" y="${172 - h}" font-size="16" text-anchor="middle" fill="#3A2626" font-weight="700">${Math.round(sad(y))}%</text><text x="${i * 128 + 64}" y="198" font-size="14" text-anchor="middle" fill="#8C7770">${y}</text>`; }).join('')}</svg></div>
                <p class="lede r d2">Share of my listening that was heartbreak, bittersweet or dark: ${Math.round(sad(ys[0]))}% in ${ys[0]}, ${Math.round(sad(ys[ys.length - 1]))}% in ${ys[ys.length - 1]}.</p>
                <p class="lede r d3">The saddest-sounding day was ${day(sd.full_date)}: "${esc(sd.track_name)}" ${sd.n} times, through the night.</p>${kind('i')}` });
        }
        if (me && ex.story && ex.story.eras) {
            const [hs, , au] = ex.story.eras;
            add({ id: 'austin', center: true, html: `
                <h2 class="r">Then I graduated and moved to Austin.</h2>
                <p class="lede r d1">Here's what changed in my listening around the same time. Not because of it, necessarily. Around it.</p>
                <div class="grid r d2" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-top:24px">
                    ${[['After midnight', hs.late_share, au.late_share, '%'], ['Ariana', hs.ariana_share, au.ariana_share, '%'], ['Hours a day', hs.hours_per_day, au.hours_per_day, ' h'], ['Desi', hs.desi_share, au.desi_share, '%']].map(([l, a, b, u]) => `<div class="card"><div class="s">${l}</div><div class="t" style="font-size:26px">${a}${u} → <span style="color:var(--pink)">${b}${u}</span></div><div class="s">high school → Austin</div></div>`).join('')}
                </div>${kind('c')}` });
        }

        // PART IV: a day in my headphones
        const quiet = p.quietStart;
        add({ id: 'sleep', center: true, share: { eyebrow: 'So… when do I sleep?', big: p.stopHour != null ? hour(p.stopHour) : hour(quiet), line: `is when my music usually stops. ${p.allnighters.length} nights it never did.` }, html: `
            <p class="eyebrow r">Part IV · A day in ${W('my', 'your')} headphones</p>
            <h2 class="r">So… when ${W('do I', 'do you')} sleep?</h2>
            <p class="lede r d1">Spotify can't tell when ${W("I'm", "you're")} asleep. It can tell when ${W('I', 'you')} finally stop pressing play.</p>
            <div class="r d2" style="max-width:420px;margin:20px auto">${radial(p.clock, quiet)}</div>
            <p class="lede r d3">The music usually stops around <b>${hour(p.stopHour ?? quiet)}</b>, and Spotify stays dark from ${hour(quiet)} to ${hour((quiet + 6) % 24)}.</p>
            ${vs(other ? `${they === 'Suhani' ? 'Suhani' : 'You'}: quiet from ${hour(other.quietStart)} to ${hour((other.quietStart + 6) % 24)}.` : '')}${kind('i')}` });

        add({ id: 'nights', center: true, share: { eyebrow: 'Probable all-nighters', big: String(p.allnighters.length), line: 'nights my music played every hour from midnight to 6 AM.' }, html: `
            <h2 class="r">The nights Spotify suggests ${W('I', 'you')} may not have slept.</h2>
            <div class="r d1" style="margin:20px auto;max-width:720px">${sky(p.allnighters, p.firstDay, p.lastDay)}</div>
            <div class="giant gold r d2">${p.allnighters.length}</div>
            <p class="lede r d2">nights with music in every hour from midnight to 6 AM.${p.allnighters.length ? ` The latest: ${day(p.allnighters[p.allnighters.length - 1])}.` : ''}</p>
            ${vs(other ? `${they === 'Suhani' ? 'Suhani' : 'You'}: ${other.allnighters.length}.` : '')}${kind('i')}` });

        if (p.lateArtist) add({ id: 'twoam', center: true, song: p.curfew || null, share: { eyebrow: 'Who is 2 AM me?', big: `${p.lateArtist.lift.toFixed(1)}×`, line: `more ${p.lateArtist.name} after midnight than any other time.` }, html: `
            ${stamp}<h2 class="r">Daylight ${W('me', 'you')} and 2 AM ${W('me', 'you')} don't get the same aux privileges.</h2>
            <div class="row r d1" style="justify-content:center;margin-top:24px">${face(p.lateArtist.name, 'cover big round', p)}</div>
            <h1 class="r d2" style="margin-top:14px">${esc(p.lateArtist.name)}</h1>
            <p class="lede r d2">is ${p.lateArtist.lift.toFixed(1)}× as likely to be playing after midnight as at any other hour.${me && ex.story ? ' 2 AM me is desi: South Asian music doubles after midnight.' : ''}</p>
            <div class="dial r d3"><p class="eyebrow" style="margin-top:26px">Drag through ${W('my', 'your')} day</p><input class="scrub" type="range" min="0" max="23" value="2" aria-label="Hour of day"><div class="dialout"></div></div>
            ${p.curfew ? `<p class="lede r d3">A song with a curfew: ${Math.round(p.curfew.share)}% of "${esc(p.curfew.track)}" plays happen after midnight.</p>` : ''}
            ${p.goodMorning ? `<p class="lede r d3">${W('My', 'Your')} good-morning song: "${esc(p.goodMorning.track)}". ${Math.round(p.pickUpPct)}% of mornings start with last night's last song.</p>` : ''}${kind('c')}`, wire: el => {
                const r = el.querySelector('.dial input'), out = el.querySelector('.dialout');
                const show = () => { const h = p.hourly[Number(r.value)];
                    out.innerHTML = `<div class="row" style="justify-content:center;margin-top:14px">${h.artist ? face(h.artist.name, 'cover round', p) : ''}<div style="text-align:left"><h3>${hour(h.hour)}</h3><p class="muted">${h.share.toFixed(1)}% of ${W('my', 'your')} listening</p>${h.artist ? `<p><b>${esc(h.artist.name)}</b> owns this hour: ${h.artist.lift.toFixed(1)}× as likely as usual</p>` : ''}${h.song ? `<p class="muted">most played then: "${esc(h.song.track)}"</p>` : ''}</div></div>`;
                    hydrate(out); };
                r.addEventListener('input', show); show();
            } });

        if (p.skipSeconds != null) add({ id: 'skips', center: true, share: { eyebrow: 'How long a song gets', big: `${p.skipSeconds.toFixed(1)}s`, line: 'before I skip it. Not three seconds. Under two.' }, html: `
            ${stamp}<h2 class="r">How long does a song get to impress ${W('me', 'you')}?</h2>
            <div class="giant r d1" data-countdown="${p.skipSeconds.toFixed(1)}">${p.skipSeconds.toFixed(1)}s</div>
            <p class="lede r d2">is the median time before ${W('I', 'you')} skip. ${Math.round(p.skipRate)}% of every song started gets skipped or quit before 30 seconds.</p>
            <div class="r d2" style="margin-top:16px"><button class="btn ghost" data-try>Try it: hear ${p.skipSeconds.toFixed(1)} seconds of a song</button></div>
            ${p.oneSong && p.oneSong.share > 90 ? `<p class="lede r d3">And "I don't like you, I like this song": ${Math.round(p.oneSong.share)}% of ${W('my', 'your')} ${esc(p.oneSong.artist)} plays are "${esc(p.oneSong.track)}".</p>` : ''}
            ${vs(other && other.skipSeconds != null ? `${they === 'Suhani' ? 'Suhani' : 'You'}: ${other.skipSeconds.toFixed(1)}s.` : '')}
            <p class="note r d4">A skip isn't always a verdict: autoplay and playlists ${W('I', 'you')} didn't make count too.</p>${kind('c')}` });

        // Suhani-only: do my receipts match my personality tests?
        if (me) add({ id: 'mirror', html: `
            ${stamp}<h2 class="r">Does my music match my personality tests?</h2>
            <p class="lede r d1">I took ten of them (<a href="https://suhxnitiwari.github.io/suhani-personality/" target="_blank" rel="noopener">here's the full read</a>). Here's what they said, and what 91,210 receipts say.</p>
            <div class="r d2" style="margin-top:20px">${[
                ['Emotional intensity in the top ~2%', `${p.inARow.n} plays of one song in a row; ${Math.round(p.replayPct)}% of listens are an instant replay`],
                ['A small, fiercely loyal inner circle', `${esc(top.name)} for ${p.owned} of ${p.months.length} months; ${p.retention[p.retention.length - 1].kept} of 2022's top 100 still play in ${p.retention[p.retention.length - 1].year}`],
                ['Patience: bottom 5%', `${p.skipSeconds.toFixed(1)} seconds before a skip`],
                ['Forgiveness: 24th of 24 strengths', `…and yet ${fmt(p.growerCount)} songs got a second chance. Grudges are for people, not songs.`],
                ['Needs consistency; anxious attachment', `${Math.round(p.pickUpPct)}% of mornings start with last night's song`],
                ['Low on adventurousness', `Only ${p.loveAtFirstPct.toFixed(1)}% love at first listen`],
            ].map(([a, b]) => `<div class="mirror"><span class="muted">${a}</span><span class="arrow">→</span><b>${b}</b></div>`).join('')}</div>
            ${kind('i')}` });

        if (other) {
            const c = ListeningEngine.compare(p, other);
            add({ id: 'click', center: true, share: { eyebrow: 'Would our music click?', big: `${c.score}%`, line: `my Spotify vs. Suhani's. ${c.sharedArtists.length ? 'We share ' + c.sharedArtists.slice(0, 3).join(', ') + '.' : ''}` }, html: `
                <p class="eyebrow r">Would our music click?</p>
                <h2 class="r">You vs. Suhani</h2>
                <div class="score r d1">${c.score}%</div>
                <p class="lede r d2">${c.score >= 70 ? 'Aux-cord soulmates.' : c.score >= 45 ? 'We could share a car ride.' : c.score >= 25 ? 'One of us is choosing the playlist.' : 'Separate headphones, honestly.'}</p>
                <div class="chips r d3">${c.sharedArtists.map(a => `<span>${esc(a)}</span>`).join('') || '<span>No artists in common (yet)</span>'}</div>
                ${c.sharedSongs.length ? `<p class="lede r d3">Songs we both love: ${c.sharedSongs.slice(0, 4).map(s => `"${esc(s.track)}"`).join(', ')}.</p>` : ''}${kind('c')}` });
        }

        add({ id: 'end', center: true, html: `
            <h2 class="r">So what did ${fmt(p.listens)} listens know?</h2>
            <p class="lede r d1">The obvious things were easy: favorite artist, favorite song, biggest year.</p>
            <p class="lede r d2">The interesting things were hiding between them. How fast ${W('I', 'you')} fall for a song. How stubbornly ${W('I', 'you')} replay it. What disappears, what comes back, and who ${W('I am', 'you are')} at 2 AM.</p>
            <p class="lede r d3">Spotify recorded the plays. The patterns only showed up when ${W('I', 'you')} started asking different questions.</p>
            <div class="start r d4">${me ? '<a class="btn" href="#yours" style="text-decoration:none">Now do yours →</a>' : '<button class="btn" data-mine>Back to Suhani\'s story</button><a class="btn ghost" href="#click" style="text-decoration:none">Compare with a friend</a>'}</div>` });
        return out;
    }

    const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(v => v[1]);

    // ---------- the record crate ----------
    // Every chapter is a record sleeve. Drag one onto the turntable (or tap it): the record spins, the needle drops,
    // its song plays and the chapter opens. Like my bag: pick something up and it tells you something about me.
    const SLEEVES = [['main', 'Main character', 'rose'], ['fuse', 'Obsession', 'butter'], ['row', 'Again, again', 'lilac'], ['streak', 'Moved in', 'mint'],
        ['growers', 'Second chances', 'sky'], ['graves', 'The graveyard', 'peach'], ['comeback', 'Back from the dead', 'lilac'], ['eras', 'The eras', 'rose'],
        ['twoam', '2 AM me', 'sky'], ['skips', '1.8 seconds', 'butter']];
    const SLOTS = [[2, 4, -8], [17, 2, 5], [32, 6, -4], [3, 36, 6], [18, 40, -6], [33, 35, 3], [47, 44, -9], [8, 69, -3], [24, 70, 8], [40, 72, -5]];
    const QUESTION = (id, p) => ({ main: `Who owned ${p.owned} of ${p.months.length} months?`, without: `Who am I without ${p.topArtists[0].name}?`, fuse: 'How fast do I fall for a song?',
        funnel: 'How many songs survive a second date?', row: `What's the most times in a row?`, streak: `${p.streak ? p.streak.days : ''} days without missing once`,
        growers: 'Do I give songs second chances?', graves: 'The songs that got one listen', comeback: 'Songs that came back from the dead', retention: `How much of ${p.retention[0].year} me survives?`,
        eras: 'What year is it, by ear?', moods: 'Did my music get brighter?', austin: 'What changed when I moved to Austin?', sleep: 'So… when do I sleep?', nights: 'The all-nighters',
        twoam: 'Who is 2 AM me?', skips: 'How long does a song get?', mirror: 'Does my music match my personality tests?', click: 'Would our music click?', hours: `${fmt(p.hours)} hours of my life`,
        end: `What did ${fmt(p.listens)} listens know?` })[id];
    // the same questions, asked about a visitor
    const ask = (id, p) => { const q = QUESTION(id, p); if (!q || mine(p)) return q;
        return q.replace('Who am I', 'Who are you').replace('do I', 'do you').replace(/\bI\b/g, 'you').replace(/\bmy\b/g, 'your').replace(/\bme\b/g, 'you'); };
    function crate(p, list) {
        const table = document.querySelector('[data-crate]'); if (!table) return;
        const byId = Object.fromEntries(list.map(s => [s.id, s]));
        const songFor = id => { const sc = byId[id]; if (!sc) return null; if (sc.song) return { track: sc.song.track || sc.song.track_name, artist: sc.song.artist || sc.song.artist_name };
            if (id === 'graves' && p.graveyard.graves[0]) return p.graveyard.graves[0]; if (id === 'eras') { const y = p.years[p.years.length - 1]; return { track: y.track, artist: y.artist }; }
            return p.topSongs[0]; };
        const items = SLEEVES.filter(([id]) => byId[id]);
        const box = table.querySelector('.crate');
        box.innerHTML = items.map(([id, label, color], i) => { const sg = songFor(id);
            return `<div class="sleeve" tabindex="0" role="button" aria-label="Play: ${esc(ask(id, p))}" data-id="${id}" data-song='${esc(JSON.stringify(sg))}' style="left:${SLOTS[i][0]}%;top:${SLOTS[i][1]}%;transform:rotate(${SLOTS[i][2]}deg)">
                <div class="disc"></div><div class="jacket" style="background:var(--${color})">${sg ? cover(sg.track, sg.artist, '', p) : ''}<div><div class="lab">${String(i + 1).padStart(2, '0')} · ${label}</div><div class="q">${esc(ask(id, p))}</div></div></div></div>`; }).join('');
        const deck = table.querySelector('.deck'), platter = deck.querySelector('.platter'), arm = deck.querySelector('.arm'), now = table.querySelector('.nowplaying');
        const narrow = () => matchMedia('(max-width: 900px)').matches;
        function drop(sl) {
            const sg = JSON.parse(sl.dataset.song || 'null'), id = sl.dataset.id, im = sl.querySelector('img');
            platter.querySelector('.labelart').src = im && im.src ? im.src : '';
            platter.classList.remove('spin'); arm.classList.remove('down');
            requestAnimationFrame(() => requestAnimationFrame(() => { platter.classList.add('spin'); arm.classList.add('down'); }));
            now.innerHTML = `<p class="mono muted">Now playing · ${esc(sl.querySelector('.lab').textContent)}</p><h3 style="margin-top:6px">${sg ? esc(sg.track) : ''}</h3><p class="muted">${sg ? esc(sg.artist) : ''}</p><p style="margin-top:14px"><a class="btn" href="#s-${id}">Open this chapter ↓</a></p>`;
            if (sg) { setSound(true); nowKey = ''; play(sg, p); }
        }
        const overDeck = e => { const r = deck.getBoundingClientRect(); return e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom; };
        box.querySelectorAll('.sleeve').forEach((sl, i) => {
            const home = () => { sl.style.left = SLOTS[i][0] + '%'; sl.style.top = SLOTS[i][1] + '%'; sl.style.transform = `rotate(${SLOTS[i][2]}deg)`; };
            let d = null;
            sl.addEventListener('pointerdown', e => { if (narrow()) return;
                const r = sl.getBoundingClientRect(), t = table.getBoundingClientRect();
                d = { x: e.clientX, y: e.clientY, left: r.left - t.left, top: r.top - t.top, moved: false }; sl.classList.add('dragging');
                try { sl.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ } });
            sl.addEventListener('pointermove', e => { if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
                if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
                sl.style.left = (d.left + dx) + 'px'; sl.style.top = (d.top + dy) + 'px'; sl.style.transform = `rotate(${Math.max(-14, Math.min(14, dx / 25))}deg)`;
                deck.classList.toggle('hover', overDeck(e)); });
            const up = e => { if (!d) return; const moved = d.moved; d = null; sl.classList.remove('dragging'); deck.classList.remove('hover');
                if (overDeck(e) || !moved) { drop(sl); home(); } };
            sl.addEventListener('pointerup', up); sl.addEventListener('pointercancel', up);
            sl.addEventListener('click', () => { if (narrow()) drop(sl); });
            sl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop(sl); } });
        });
        // the tracklist: every chapter as a row
        const idx = document.querySelector('[data-index]');
        let part = '', n = 0;
        idx.innerHTML = `<p class="eyebrow" style="margin:18px 0 8px">The tracklist</p>` + list.filter(s => s.id !== 'open').map(s => { if (PARTS[s.id]) part = PARTS[s.id]; n++;
            return `<a href="#s-${s.id}"><span class="n">${String(n).padStart(2, '0')}</span><span class="q">${esc(ask(s.id, p) || s.id)}</span><span class="p">${esc(part)}</span></a>`; }).join('');
    }

    // ---------- small drawings ----------
    function dots(n) { const per = Math.min(n, 17); return `<svg viewBox="0 0 ${per * 36} ${Math.ceil(n / per) * 36}">${[...Array(n).keys()].map(i => `<circle cx="${(i % per) * 36 + 18}" cy="${Math.floor(i / per) * 36 + 18}" r="13" fill="hsl(${340 - i / n * 20},${55 + i / n * 20}%,${80 - i / n * 34}%)" stroke="#3A2626" stroke-width="1.2" style="transition-delay:${i * 18}ms"/>`).join('')}</svg>`; }
    function squares(n) { const per = Math.min(n, 14); return `<svg viewBox="0 0 ${per * 44} ${Math.ceil(n / per) * 44}">${[...Array(n).keys()].map(i => `<rect x="${(i % per) * 44 + 4}" y="${Math.floor(i / per) * 44 + 4}" width="36" height="36" rx="5" fill="#F4A7B9" stroke="#3A2626" stroke-width="1.5" style="transition-delay:${i * 90}ms"/><text x="${(i % per) * 44 + 22}" y="${Math.floor(i / per) * 44 + 27}" font-size="13" text-anchor="middle" fill="#3A2626" font-weight="700">${i + 1}</text>`).join('')}</svg>`; }
    function hundred(n) { return `<svg viewBox="0 0 800 ${Math.ceil(n / 20) * 40}">${[...Array(n).keys()].map(i => `<circle data-i="${i}" cx="${(i % 20) * 40 + 20}" cy="${Math.floor(i / 20) * 40 + 20}" r="15" fill="#F4A7B9" stroke="#3A2626" stroke-width="1.2" style="transition:opacity .6s"/>`).join('')}</svg>`; }
    function radial(shares, quiet) {
        const max = Math.max(...shares), R0 = 46, R1 = 150;
        const wedge = (h, r) => { const a1 = h / 24 * 2 * Math.PI - Math.PI / 2, a2 = (h + 1) / 24 * 2 * Math.PI - Math.PI / 2, P = (a, rr) => `${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`;
            return `M${P(a1, R0)} L${P(a1, r)} A${r},${r} 0 0 1 ${P(a2, r)} L${P(a2, R0)} A${R0},${R0} 0 0 0 ${P(a1, R0)} Z`; };
        const q1 = quiet / 24 * 2 * Math.PI - Math.PI / 2, q2 = (quiet + 6) / 24 * 2 * Math.PI - Math.PI / 2;
        return `<svg viewBox="-175 -175 350 350"><path d="M0,0 L${Math.cos(q1) * 160},${Math.sin(q1) * 160} A160,160 0 0 1 ${Math.cos(q2) * 160},${Math.sin(q2) * 160} Z" fill="#2B1B3D" opacity=".9"/>
            <g class="pop">${shares.map((v, h) => `<path d="${wedge(h, R0 + v / max * (R1 - R0))}" fill="${h >= quiet && h < quiet + 6 ? '#8E7BA8' : '#D65478'}" style="transition-delay:${h * 60}ms"/>`).join('')}</g>
            ${[0, 6, 12, 18].map(h => { const a = h / 24 * 2 * Math.PI - Math.PI / 2; return `<text x="${Math.cos(a) * 166}" y="${Math.sin(a) * 166 + 5}" font-size="14" text-anchor="middle" fill="#3A2626" stroke="#FAF1EF" stroke-width="5" paint-order="stroke">${h === 0 ? '12 AM' : h === 12 ? 'noon' : hour(h)}</text>`; }).join('')}
            <text y="8" font-size="24" text-anchor="middle">🌙</text></svg>`;
    }
    function sky(nights, first, last) {
        const t0 = new Date(first + 'T12:00:00'), t1 = new Date(last + 'T12:00:00'), x = d => 20 + (new Date(d + 'T12:00:00') - t0) / (t1 - t0 || 1) * 680;
        const years = []; for (let y = t0.getFullYear() + 1; y <= t1.getFullYear(); y++) years.push(y);
        return `<svg viewBox="0 0 720 170" style="background:#2B1B3D;border-radius:14px;border:2px solid #3A2626">${years.map(y => `<text x="${x(y + '-01-01')}" y="160" font-size="12" fill="#8E7BA8">${y}</text>`).join('')}
            <g class="stars">${nights.map((d, i) => `<circle cx="${x(d)}" cy="${24 + (i * 41) % 110}" r="${3 + (i % 3)}" fill="#FFF4D6" style="animation-delay:${(i % 7) * .4}s"><title>${d}</title></circle>`).join('')}</g></svg>`;
    }

    // ---------- render ----------
    const PARTS = { hours: 'Prologue', main: 'I · What I love', streak: 'II · What stayed', eras: 'III · Time', sleep: 'IV · My days', end: 'Epilogue' };
    let observer;
    function render(p, other) {
        current = p;
        const list = scenes(p, other);
        const songOf = s => s.song && { track: s.song.track || s.song.track_name, artist: s.song.artist || s.song.artist_name };
        $('#story').innerHTML = list.map(s => `<section class="scene${s.center ? ' center' : ''}${s.hero ? ' hero' : ''}" id="s-${s.id}"${s.song ? ` data-song='${esc(JSON.stringify(songOf(s)))}'` : ''}${PARTS[s.id] ? ` data-part="${PARTS[s.id]}"` : ''}><div class="inner">${s.html}${s.share ? `<div class="share r d4"><button data-share="${s.id}">Save this as a card ↓</button></div>` : ''}</div></section>`).join('');
        const shares = Object.fromEntries(list.filter(s => s.share).map(s => [s.id, s.share]));
        list.forEach(s => s.wire && s.wire(document.getElementById('s-' + s.id)));
        $('#story').querySelectorAll('[data-play]').forEach(b => { const go = () => { const was = state.sound; state.sound = true; nowKey = ''; play(JSON.parse(b.dataset.play), p); state.sound = was || true; if (!was) setSound(true); };
            b.addEventListener('click', go); b.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); });
        $('#story').querySelectorAll('[data-share]').forEach(b => b.addEventListener('click', () => shareCard(shares[b.dataset.share])));
        $('#story').querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => { setSound(b.dataset.start === 'sound'); document.querySelector('#s-hours').scrollIntoView(); }));
        $('#story').querySelectorAll('[data-mine]').forEach(b => b.addEventListener('click', () => { render(state.suhani); window.scrollTo(0, 0); }));
        $('#story').querySelectorAll('.guess').forEach(g => {
            const go = () => { const v = Number(g.querySelector('input').value), a = Number(g.dataset.answer), rev = g.nextElementSibling;
                rev.classList.remove('hidden'); rev.insertAdjacentHTML('afterbegin', `<p class="lede">${v ? (Math.abs(v - a) <= a * 0.1 ? 'You were close. Scary close.' : v < a ? `You guessed ${v}. Aim higher.` : `You guessed ${v}. Not quite that unhinged.`) : ''}</p>`);
                g.remove(); setTimeout(() => rev.closest('.scene').classList.add('in'), 30); };
            g.querySelector('button').addEventListener('click', go); g.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        });
        $('#story').querySelectorAll('[data-try]').forEach(b => b.addEventListener('click', async () => {
            const s = p.topSongs[Math.floor(Math.random() * Math.min(10, p.topSongs.length))], url = await previewUrl(s.track, s.artist, p);
            if (!url) return toast('No preview for that one. Try again.');
            const was = state.sound; audio.pause(); audio.src = url; audio.volume = 0.9; audio.currentTime = 0; await audio.play().catch(() => {});
            toast(`"${s.track}"… time's up.`); setTimeout(() => { audio.pause(); nowKey = ''; if (was) setSound(true); }, p.skipSeconds * 1000);
        }));
        crate(p, list);
        hydrate($('#story'));
        $('#rail').innerHTML = [...document.querySelectorAll('[data-part]')].map(sc => `<a href="#${sc.id}" data-for="${sc.id}"><span>${sc.dataset.part}</span><i></i></a>`).join('') + '<a href="#yours" data-for="yours"><span>Yours</span><i></i></a>';
        if (observer) observer.disconnect();
        observer = new IntersectionObserver(entries => entries.forEach(e => {
            // tall scenes never reach a high ratio, so also count "fills a good part of the screen"
            if (!e.isIntersecting || (e.intersectionRatio < 0.3 && e.intersectionRect.height < innerHeight * 0.45)) return;
            const el = e.target; el.classList.add('in');
            const partScene = [...document.querySelectorAll('[data-part], #yours')].filter(sc => sc.getBoundingClientRect().top <= innerHeight * 0.5).pop();
            document.querySelectorAll('#rail a').forEach(a => a.classList.toggle('on', !!partScene && a.dataset.for === partScene.id));
            if (el.dataset.song) play(JSON.parse(el.dataset.song), p);
            el.querySelectorAll('[data-count]').forEach(countUp);
            el.querySelectorAll('[data-fade]').forEach(fadeYears);
        }), { threshold: [0, 0.15, 0.3, 0.45, 0.6] });
        document.querySelectorAll('.scene').forEach(s => observer.observe(s));
        document.querySelectorAll('.era[data-song]').forEach(row => new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) play(JSON.parse(row.dataset.song), p); }), { threshold: 0.9 }).observe(row));
    }
    function countUp(el) {
        if (el.dataset.done) return; el.dataset.done = 1;
        const end = Number(el.dataset.count), t0 = performance.now();
        const tick = t => { const k = Math.min(1, (t - t0) / 1600); el.textContent = fmt(end * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    }
    function fadeYears(el) {
        if (el.dataset.done) return; el.dataset.done = 1;
        const kept = JSON.parse(el.dataset.fade), label = el.querySelector('[data-fade-label]'), ret = current.retention, scrub = el.closest('.inner').querySelector('.scrub');
        const show = i => { el.querySelectorAll('circle').forEach(c => { c.style.opacity = Number(c.dataset.i) < kept[i] ? 1 : 0.12; }); label.textContent = `${ret[i].year}: ${kept[i]} of ${ret[0].of} still played`; if (scrub) scrub.value = i; };
        let auto = true;
        if (scrub) scrub.addEventListener('input', () => { auto = false; show(Number(scrub.value)); });
        kept.forEach((k, i) => setTimeout(() => auto && show(i), 900 + i * 1300));
    }
    function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); }

    // progress bar
    addEventListener('scroll', () => { const h = document.documentElement; $('#progress').style.width = (100 * h.scrollTop / (h.scrollHeight - h.clientHeight)) + '%'; }, { passive: true });

    // ---------- "now do yours": read the export in the browser ----------
    async function readExport(files, statusEl) {
        statusEl.textContent = 'Reading your files…';
        const records = await ListeningEngine.readFiles([...files], window.JSZip);
        if (!records.length) throw new Error("I couldn't find any streaming history in that. Look for Streaming_History_Audio_*.json or StreamingHistory_music_*.json.");
        statusEl.textContent = `Found ${records.length.toLocaleString()} plays. Asking them questions…`;
        await new Promise(r => setTimeout(r, 30));
        return ListeningEngine.profile(ListeningEngine.toPlays(records), { who: 'You' });
    }
    function wireDrop(dropId, inputId, statusId, onProfile) {
        const drop = $(dropId), input = $(inputId), status = $(statusId);
        const go = async files => { try { onProfile(await readExport(files, status)); status.textContent = ''; } catch (e) { status.textContent = e.message || String(e); } };
        input.addEventListener('change', () => input.files.length && go(input.files));
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', e => e.dataTransfer.files.length && go(e.dataTransfer.files));
    }
    function showYours(prof, fromSave) {
        state.you = prof;
        if (!fromSave) store.set('lh:you', prof);
        render(prof, state.suhani);
        renderSaved();
        window.scrollTo(0, 0);
        toast(fromSave ? 'Welcome back. Here\'s your story again.' : 'This is your story now. Scroll.');
    }
    function renderSaved() {
        const saved = store.get('lh:you'), box = $('#saved');
        if (!saved) { box.classList.add('hidden'); return; }
        box.classList.remove('hidden');
        box.innerHTML = `<p class="muted">Your story is saved on this device only (${saved.listens.toLocaleString()} listens).</p><div class="start" style="margin-top:8px"><button class="btn" id="openSaved">See your story</button><button class="btn ghost" id="forget">Forget my data</button></div>`;
        $('#openSaved').onclick = () => showYours(saved, true);
        $('#forget').onclick = () => { store.del('lh:you'); state.you = null; render(state.suhani); renderSaved(); toast('Forgotten. Nothing of yours is left here.'); };
    }
    wireDrop('#drop', '#file', '#status', p => showYours(p, false));
    wireDrop('#drop2', '#file2', '#status2', friend => {
        const base = state.you || state.suhani, c = ListeningEngine.compare(base, friend), who = state.you ? 'You and your friend' : 'Your friend and Suhani';
        $('#clickResult').innerHTML = `<div class="score">${c.score}%</div><p class="lede">${who}: ${c.score >= 70 ? 'aux-cord soulmates.' : c.score >= 45 ? 'could share a car ride.' : c.score >= 25 ? 'should take turns on the playlist.' : 'need separate headphones.'}</p>
            <div class="chips">${c.sharedArtists.map(a => `<span>${esc(a)}</span>`).join('') || '<span>No artists in common</span>'}</div>
            ${c.sharedSongs.length ? `<p class="lede">Songs you both love: ${c.sharedSongs.slice(0, 5).map(s => `"${esc(s.track)}"`).join(', ')}.</p>` : ''}
            <div class="share"><button id="clickCard">Save this as a card ↓</button></div>`;
        $('#clickCard').onclick = () => shareCard({ eyebrow: 'Would our music click?', big: `${c.score}%`, line: `${who}. ${c.sharedArtists.slice(0, 3).join(', ')}` });
    });

    // ---------- boot ----------
    (async () => {
        // my extra chapters (moods, Austin, 2 AM desi) come from the database: wait a moment for them so the page draws once
        const extras = Promise.all(['moods', 'story'].map(k => fetch('/api/' + k).then(r => r.ok ? r.json() : null).catch(() => null)))
            .then(([moods, story]) => { state.extras = { moods, story }; return true; });
        state.suhani = await fetch('/static/data/suhani.json').then(r => r.json());
        const inTime = await Promise.race([extras, new Promise(r => setTimeout(() => r(false), 2500))]);
        const saved = store.get('lh:you');
        if (saved && location.hash === '#mine') showYours(saved, true); else render(state.suhani);
        renderSaved();
        if (saved) toast('Welcome back. Your story is saved: tap "Do yours" to see it.');
        // if they were slow, add them only while the visitor is still at the top, so nothing jumps under them
        if (!inTime) extras.then(() => { if (current === state.suhani && scrollY < 200 && !document.querySelector('.platter.spin')) render(state.suhani); });
    })();
})();
