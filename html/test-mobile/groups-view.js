const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const h = require('./helpers');
const { sleep, tmux } = lib;

const SHOTS = path.join(lib.SCRATCH, 'shots');
const inMode = () => tmux('display-message', '-t', 'm', '-p', '#{pane_in_mode}').trim() === '1';
const paneScroll = () => Number(tmux('display-message', '-t', 'm', '-p', '#{scroll_position}').trim() || 0);
const run = async cmd => {
    tmux('send-keys', '-t', 'm', '-l', cmd);
    tmux('send-keys', '-t', 'm', 'Enter');
};

async function tmuxPage(ctx, conf, port = ctx.port, viewport) {
    lib.tmuxKill();
    lib.startTtyd({ port, page: ctx.page, conf });
    await lib.waitPort(port);
    const context = await lib.mobileContext(ctx.browser, viewport);
    const { page, log } = await h.bootPage(context, `http://127.0.0.1:${port}/`);
    await h.untilOpen(page);
    await lib.waitScreen(page, /\$ /);
    const cdp = await context.newCDPSession(page);
    return { context, page, log, cdp };
}

async function scrollCase(ctx, conf, label, port) {
    const { results: r, group: g } = ctx;
    const { context, page, log, cdp } = await tmuxPage(ctx, conf, port);
    const buffer = await page.evaluate(() => window.term.buffer.active.type);
    r.add(g, `${label}: xterm buffer seen`, true, buffer);
    await run('seq 1 3000');
    await lib.waitScreen(page, /\n3000\n/);
    await sleep(200);
    const base = await lib.screen(page);

    await h.swipe(cdp, 200, 200, 560);
    const entered = await h.until(() => inMode(), 2000);
    await h.until(async () => (await h.uiState(page)).chip, 1500);
    let st = await h.uiState(page);
    r.add(g, `${label}: first swipe enters tmux copy mode, indicator shown`, !!entered && /^Scroll \d+\/\d+$/.test(st.chip || ''), `chip=${st.chip}`);
    await sleep(600);
    const p1 = paneScroll();
    r.add(g, `${label}: swipe moved history`, p1 > 5, `tmux position ${p1}`);
    const moved = await lib.screen(page);
    r.add(g, `${label}: screen content changed`, moved.join('\n') !== base.join('\n'));
    const sentSoFar = h.inputFrames(log).join('');
    r.add(g, `${label}: prefix then copy key sent once`, sentSoFar.split('\x02[').length === 2 && !/\x1b\[A/.test(sentSoFar), JSON.stringify(sentSoFar.slice(0, 40)));

    // A flick travels further than the finger: momentum
    const beforeFling = paneScroll();
    await h.swipe(cdp, 200, 200, 620, { steps: 5, stepMs: 8 });
    await sleep(1500);
    const afterFling = paneScroll();
    const fingerLines = 420 / 15;
    r.add(g, `${label}: flick has momentum`, afterFling - beforeFling > fingerLines, `moved ${afterFling - beforeFling} lines, finger alone ${Math.round(fingerLines)}`);
    st = await h.uiState(page);
    const chipPos = Number(/Scroll (\d+)/.exec(st.chip || '')?.[1]);
    r.add(g, `${label}: indicator shows the real position`, Math.abs(chipPos - paneScroll()) <= 1, `${st.chip} vs ${paneScroll()}`);

    // Slow swipe up moves toward newer text
    const b4 = paneScroll();
    await h.swipe(cdp, 200, 560, 260, { steps: 15, stepMs: 25, hold: 150 });
    await sleep(400);
    r.add(g, `${label}: swipe the other way goes back`, paneScroll() < b4, `${b4} -> ${paneScroll()}`);

    if (conf === 'owner.conf') {
        await page.screenshot({ path: path.join(SHOTS, 'scroll-mode.png') });
    }

    await page.tap('[data-key=scroll-exit]');
    const out = await h.until(() => !inMode(), 2000);
    await sleep(150);
    st = await h.uiState(page);
    r.add(g, `${label}: Exit returns to the shell`, !!out && !st.chip, `chip=${st.chip}`);

    // Compose while scrolled leaves copy mode first
    await h.swipe(cdp, 200, 200, 500);
    await h.until(() => inMode(), 2000);
    await h.until(async () => (await h.uiState(page)).chip, 1500);
    const file = path.join(ctx.tmp, `scroll-${conf}.txt`);
    await h.typeCompose(page, `echo ok-from-scroll > ${file}`);
    await page.tap('[data-key=send]');
    const got = await h.waitFile(file, 'ok-from-scroll\n');
    r.add(g, `${label}: sending text leaves scroll mode first, nothing lost`, got === 'ok-from-scroll\n' && !inMode(), JSON.stringify(got));

    // Swiping back to the end leaves scroll mode by itself
    await h.swipe(cdp, 200, 200, 300);
    await h.until(() => inMode(), 2000);
    await sleep(300);
    await h.swipe(cdp, 200, 500, 100, { steps: 15, stepMs: 25, hold: 150 });
    await h.swipe(cdp, 200, 500, 100, { steps: 15, stepMs: 25, hold: 150 });
    const auto = await h.until(() => !inMode(), 3000);
    r.add(g, `${label}: reaching the end leaves scroll mode`, !!auto);

    // Swipe up at the live screen does nothing rather than entering copy mode
    const frames = h.inputFrames(log).length;
    await h.swipe(cdp, 200, 500, 200, { hold: 120 });
    await sleep(300);
    r.add(g, `${label}: swipe toward newer at the live screen sends nothing`, h.inputFrames(log).length === frames && !inMode(), JSON.stringify(h.inputFrames(log).slice(frames)).slice(0, 80) + ` inMode=${inMode()}`);

    // Copy mode started some other way is noticed, and survives a reconnect
    tmux('copy-mode', '-t', 'm');
    const noticed = await h.until(async () => (await h.uiState(page)).chip, 1500);
    r.add(g, `${label}: copy mode started elsewhere shows the indicator`, !!noticed, String(noticed));
    await page.tap('[data-key=scroll-exit]');
    r.add(g, `${label}: and Exit leaves it`, !!(await h.until(() => !inMode(), 2000)));

    // Tap does not send anything and does not open the keyboard
    const frames2 = h.inputFrames(log).length;
    await page.touchscreen.tap(200, 300);
    await sleep(250);
    st = await h.uiState(page);
    r.add(g, `${label}: tap on terminal sends nothing, no focus`, h.inputFrames(log).length === frames2 && st.active !== 'm-input', st.active);

    r.add(g, `${label}: no console errors`, log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
    await context.close();
}

module.exports = {
    async scrollOwner(ctx) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await scrollCase(ctx, 'owner.conf', 'owner tmux config', ctx.port);
    },

    async scrollPlain(ctx) {
        await scrollCase(ctx, 'plain.conf', 'plain tmux config', ctx.port);
    },

    async scrollOther(ctx) {
        const { results: r, group: g } = ctx;
        // No tmux, normal buffer: xterm's own scrollback
        lib.startTtyd({ port: ctx.port, page: ctx.page, cmd: ['bash', '-c', 'seq 1 3000; exec cat'] });
        await lib.waitPort(ctx.port);
        let context = await lib.mobileContext(ctx.browser);
        let { page, log } = await h.bootPage(context, `http://127.0.0.1:${ctx.port}/`);
        await h.untilOpen(page);
        await lib.waitScreen(page, /3000/);
        let cdp = await context.newCDPSession(page);
        const base = await page.evaluate(() => window.term.buffer.active.viewportY);
        await h.swipe(cdp, 200, 200, 560);
        await sleep(300);
        const y = await page.evaluate(() => window.term.buffer.active.viewportY);
        const input = h.inputFrames(log).join('');
        r.add(g, 'no tmux: swipe uses xterm scrollback, sends nothing', y < base && input === '', `viewportY ${base} -> ${y}`);
        const limit = await page.evaluate(() => window.term.options.scrollback);
        r.add(g, 'no tmux: scrollback limited on touch', limit === 2000, String(limit));
        let st = await h.uiState(page);
        r.add(g, 'no tmux: History indicator shown', st.chip === 'History', st.chip);
        await page.tap('[data-key=scroll-exit]');
        await sleep(150);
        const back = await page.evaluate(() => [window.term.buffer.active.viewportY, window.term.buffer.active.baseY]);
        r.add(g, 'no tmux: Exit returns to the bottom', back[0] === back[1], back.join('/'));
        await context.close();
        await lib.cleanup();

        // A program with mouse tracking gets wheel events
        const file = path.join(ctx.tmp, 'mouse.log');
        const port2 = ctx.port + 100;
        lib.startTtyd({ port: port2, page: ctx.page, cmd: ['python3', path.join(__dirname, 'hexd.py'), file, '\\x1b[?1000h\\x1b[?1006h'] });
        await lib.waitPort(port2);
        context = await lib.mobileContext(ctx.browser);
        ({ page, log } = await h.bootPage(context, `http://127.0.0.1:${port2}/`));
        await h.untilOpen(page);
        await lib.waitScreen(page, /ready/);
        cdp = await context.newCDPSession(page);
        await h.swipe(cdp, 200, 200, 500);
        await sleep(300);
        const mouseUp = Buffer.from(fs.readFileSync(file, 'utf8').replace(/\s+/g, ''), 'hex').toString();
        r.add(g, 'mouse tracking: swipe down sends wheel up', /\x1b\[<64;\d+;\d+M/.test(mouseUp) && !/\x1b\[<65/.test(mouseUp), JSON.stringify(mouseUp.slice(0, 40)));
        fs.writeFileSync(file, '');
        await h.swipe(cdp, 200, 500, 200);
        await sleep(300);
        const mouseDown = Buffer.from(fs.readFileSync(file, 'utf8').replace(/\s+/g, ''), 'hex').toString();
        r.add(g, 'mouse tracking: swipe up sends wheel down', /\x1b\[<65;\d+;\d+M/.test(mouseDown), JSON.stringify(mouseDown.slice(0, 40)));
        await context.close();
        await lib.cleanup();

        // Full-screen program with no mouse and no tmux: arrows, as desktop xterm does
        const file2 = path.join(ctx.tmp, 'alt.log');
        const port3 = ctx.port + 200;
        lib.startTtyd({ port: port3, page: ctx.page, cmd: ['python3', path.join(__dirname, 'hexd.py'), file2, '\\x1b[?1049h'] });
        await lib.waitPort(port3);
        context = await lib.mobileContext(ctx.browser);
        ({ page, log } = await h.bootPage(context, `http://127.0.0.1:${port3}/`));
        await h.untilOpen(page);
        await lib.waitScreen(page, /ready/);
        cdp = await context.newCDPSession(page);
        await h.swipe(cdp, 200, 200, 500);
        await sleep(300);
        const alt = Buffer.from(fs.readFileSync(file2, 'utf8').replace(/\s+/g, ''), 'hex').toString();
        r.add(g, 'full-screen program, no tmux: swipe sends arrows, no prefix', /\x1b\[A/.test(alt) && !alt.includes('\x02'), JSON.stringify(alt.slice(0, 24)));
        await context.close();
    },

    async apps(ctx) {
        const { results: r, group: g } = ctx;
        const { context, page, log } = await tmuxPage(ctx, 'owner.conf');
        const file = path.join(ctx.tmp, 'vim.txt');
        const has = bin => {
            try {
                require('child_process').execFileSync('which', [bin], { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        };
        if (has('vim')) {
            await h.typeCompose(page, `vim -u NONE -N ${file}`);
            await page.tap('[data-key=send]');
            const up = await lib.waitScreen(page, /^~\s*$/m, 4000);
            await h.typeCompose(page, 'ibonjour vim');
            await page.tap('[data-key=send]');
            await sleep(200);
            await page.tap('[data-key=esc]');
            await sleep(100);
            await page.keyboard.insertText(':wq');
            await page.tap('[data-key=send]');
            const got = await h.waitFile(file, 'bonjour vim\n\n', 4000);
            r.add(g, 'vim opens, inserts, Esc and :wq save', up && got === 'bonjour vim\n\n', JSON.stringify(got));
        } else {
            r.add(g, 'vim', null, 'vim not installed');
        }
        await sleep(300);
        await h.typeCompose(page, 'seq 1 500 | less');
        await page.tap('[data-key=send]');
        const lessUp = await lib.waitScreen(page, /\n1\n2\n/, 4000) || (await lib.waitScreen(page, /^1$/m, 2000));
        await page.tap('[data-key=pgdn]');
        await sleep(300);
        const lessMoved = !/^1$/m.test((await lib.screen(page)).join('\n'));
        r.add(g, 'less renders and PgDn moves', !!lessUp && lessMoved);
        await page.keyboard.insertText('q');
        await page.tap('[data-key=send]');
        await sleep(300);

        if (has('htop')) {
            await h.typeCompose(page, 'htop');
            await page.tap('[data-key=send]');
            const up = await lib.waitScreen(page, /PID|CPU/, 4000);
            r.add(g, 'htop renders', up);
            await page.screenshot({ path: path.join(SHOTS, 'htop.png') });
            await page.keyboard.insertText('q');
            await sleep(400);
            const st = await h.uiState(page);
            if (st.value) await page.tap('[data-key=send]');
            await sleep(300);
        } else {
            r.add(g, 'htop', null, 'htop not installed, less was used instead');
        }

        // Keyboard opening: viewport animates through many heights
        const n0 = lib.resizes(log).length;
        const t0 = Date.now();
        for (let hgt = 915; hgt >= 515; hgt -= 25) {
            await page.setViewportSize({ width: 412, height: hgt });
            await sleep(12);
        }
        await sleep(500);
        const open = lib.resizes(log).slice(n0);
        const dims = open.map(x => `${x.columns}x${x.rows}`).join(' ');
        r.add(g, 'keyboard opening sends one resize', open.length === 1, `${open.length} resize in ${Date.now() - t0} ms for 17 viewport steps: ${dims}`);
        const layout = await page.evaluate(() => {
            const bars = document.querySelector('.m-bars').getBoundingClientRect();
            const term = document.querySelector('#terminal-container').getBoundingClientRect();
            const cmp = document.querySelector('.m-compose').getBoundingClientRect();
            return { barsBottom: bars.bottom, inner: innerHeight, termBottom: term.bottom, barsTop: bars.top, cmp: cmp.bottom, sy: scrollY, docH: document.documentElement.scrollHeight };
        });
        r.add(g, 'bars sit at the keyboard edge, terminal above them', Math.abs(layout.barsBottom - layout.inner) < 1 && layout.termBottom <= layout.barsTop + 1 && layout.sy === 0, JSON.stringify(layout));
        const n1 = lib.resizes(log).length;
        await sleep(600);
        await page.setViewportSize({ width: 412, height: 515 });
        await sleep(400);
        r.add(g, 'same size sends no resize', lib.resizes(log).length === n1);
        await page.setViewportSize({ width: 412, height: 915 });
        await sleep(500);
        const last = lib.resizes(log).slice(-1)[0];
        const tSize = tmux('display-message', '-t', 'm', '-p', '#{window_width}x#{window_height}').trim();
        const termSize = await page.evaluate(() => `${window.term.cols}x${window.term.rows}`);
        r.add(g, 'server size follows the terminal', `${last.columns}x${last.rows}` === termSize, `last=${last.columns}x${last.rows} term=${termSize} tmux=${tSize}`);
        const cols = await page.evaluate(() => window.term.cols);
        r.add(g, 'portrait shows at least 50 columns', cols >= 50, `${cols} columns at ${await page.evaluate(() => window.term.options.fontSize)}px`);

        // Rows fill the area without a clipped line, no page scroll, overscroll blocked
        const fitBox = await page.evaluate(() => {
            const scr = document.querySelector('.xterm-screen').getBoundingClientRect();
            const c = document.querySelector('#terminal-container').getBoundingClientRect();
            const body = getComputedStyle(document.body);
            const root = getComputedStyle(document.documentElement);
            return { screenBottom: scr.bottom, containerBottom: c.bottom, bodyPos: body.position, over: root.overscrollBehaviorY, touch: getComputedStyle(document.querySelector('#terminal-container')).touchAction };
        });
        r.add(g, 'no page scroll, no rubber-band', fitBox.screenBottom <= fitBox.containerBottom + 1 && fitBox.bodyPos === 'fixed' && fitBox.over === 'none' && fitBox.touch === 'none', JSON.stringify(fitBox));

        // Font buttons persist
        const f0 = await page.evaluate(() => window.term.options.fontSize);
        await page.tap('[data-key=font-up]');
        await sleep(300);
        const f1 = await page.evaluate(() => window.term.options.fontSize);
        r.add(g, 'A+ makes text larger', f1 === f0 + 1, `${f0} -> ${f1}`);
        await page.reload();
        await page.waitForFunction(() => window.term && window.term.cols > 0);
        await h.untilOpen(page);
        const f2 = await page.evaluate(() => window.term.options.fontSize);
        r.add(g, 'font choice survives a reload', f2 === f1, `${f2}`);
        await page.tap('[data-key=font-down]');
        await sleep(300);
        const cdp = await context.newCDPSession(page);
        const fA = await page.evaluate(() => window.term.options.fontSize);
        await h.pinch(cdp, 200, 400, 100, 240);
        await sleep(400);
        const fB = await page.evaluate(() => window.term.options.fontSize);
        r.add(g, 'pinch out enlarges text', fB > fA, `${fA} -> ${fB}`);
        await h.pinch(cdp, 200, 400, 240, 100);
        await sleep(400);
        const fC = await page.evaluate(() => window.term.options.fontSize);
        r.add(g, 'pinch in shrinks text', fC < fB, `${fB} -> ${fC}`);
        await page.evaluate(() => localStorage.clear());
        const tc = await page.evaluate(() => document.querySelector('meta[name=theme-color]').content);
        r.add(g, 'theme colour follows the server theme', tc === '#1a1b26', tc);
        const bg = await page.evaluate(() => window.term.options.theme.background);
        r.add(g, '-t theme and fontSize honoured', bg === '#1a1b26', bg);
        r.add(g, 'no console errors', log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
        await context.close();
    },

    async copy(ctx) {
        const { results: r, group: g } = ctx;
        const { context, page, log } = await tmuxPage(ctx, 'owner.conf');
        await run('clear; printf "voir https://example.org/a?b=1, et (http://localhost:9/x).\\nété 😀\\n"');
        await lib.waitScreen(page, /été/);
        await page.tap('[data-key=copy]');
        await page.waitForSelector('.m-overlay');
        const info = await page.evaluate(() => {
            const pre = document.querySelector('.m-overlay-text');
            return { text: pre.innerText, links: [...pre.querySelectorAll('a')].map(a => a.getAttribute('href')), select: getComputedStyle(pre).userSelect, targets: [...pre.querySelectorAll('a')].map(a => a.rel) };
        });
        r.add(g, 'overlay shows the real text', /été 😀/.test(info.text) && /voir https/.test(info.text), JSON.stringify(info.text.slice(0, 60)));
        r.add(g, 'URLs are links, trailing punctuation left out', info.links.join(' ') === 'https://example.org/a?b=1 http://localhost:9/x', info.links.join(' '));
        r.add(g, 'text can be selected natively', info.select === 'text' || info.select === 'auto', info.select);
        await page.screenshot({ path: path.join(SHOTS, 'copy-overlay.png') });
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.tap('[data-key=copy-all]');
        await sleep(150);
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        r.add(g, 'Copy all fills the clipboard', /été 😀/.test(clip), `${clip.length} chars`);
        await page.tap('[data-key=copy-close]');
        await sleep(100);
        r.add(g, 'Close removes the overlay', !(await page.$('.m-overlay')));
        await page.tap('[data-key=copy]');
        await page.waitForSelector('.m-overlay');
        await page.goBack().catch(() => {});
        await sleep(300);
        const stillThere = await page.evaluate(() => ({ overlay: !!document.querySelector('.m-overlay'), term: !!window.term, path: location.href }));
        r.add(g, 'browser back closes the overlay and stays on the page', !stillThere.overlay && stillThere.term, JSON.stringify(stillThere));
        await page.tap('[data-key=copy]');
        await page.waitForSelector('.m-overlay');
        await page.tap('[data-key=copy-close]');
        await sleep(300);
        r.add(g, 'Close then keeps the terminal page in place', await page.evaluate(() => !!window.term));
        r.add(g, 'no console errors', log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
        await context.close();
        await lib.cleanup();

        // Normal buffer without tmux: overlay includes scrollback, opened where the text ends
        const port2 = ctx.port + 100;
        lib.startTtyd({ port: port2, page: ctx.page, cmd: ['bash', '-c', 'seq 1 500; exec cat'] });
        await lib.waitPort(port2);
        const c2 = await lib.mobileContext(ctx.browser);
        const { page: p2 } = await h.bootPage(c2, `http://127.0.0.1:${port2}/`);
        await h.untilOpen(p2);
        await lib.waitScreen(p2, /500/);
        await p2.tap('[data-key=copy]');
        await p2.waitForSelector('.m-overlay');
        const t2 = await p2.$eval('.m-overlay-text', e => ({ text: e.innerText, top: e.scrollTop, max: e.scrollHeight - e.clientHeight }));
        r.add(g, 'no tmux: overlay includes scrollback', /^1\n2\n/.test(t2.text) && /\n500$/.test(t2.text.trim()), `${t2.text.split('\n').length} lines, scrollTop ${t2.top}/${t2.max}`);
        await c2.close();
    },

    async shots(ctx) {
        const { results: r, group: g } = ctx;
        fs.mkdirSync(SHOTS, { recursive: true });
        const demo = `clear; printf 'Compose text goes below, keys sit above the keyboard.\\n\\n'; ls -1 /usr/share/doc | head -4 | sed 's/^/  /'; printf '\\nhttps://example.org/docs\\n'`;
        const { context, page } = await tmuxPage(ctx, 'owner.conf');
        await run(demo);
        await sleep(400);
        await page.setViewportSize({ width: 412, height: 515 });
        await sleep(500);
        await h.typeCompose(page, 'bonjour, voici un test avec un texte assez long pour remplir plus de deux lignes du champ de saisie');
        await sleep(200);
        await page.screenshot({ path: path.join(SHOTS, 'portrait-keyboard.png') });
        await context.close();
        const port2 = ctx.port + 100;
        const l = await lib.mobileContext(ctx.browser, lib.LANDSCAPE);
        lib.startTtyd({ port: port2, page: ctx.page });
        await lib.waitPort(port2);
        const { page: p2 } = await h.bootPage(l, `http://127.0.0.1:${port2}/`);
        await h.untilOpen(p2);
        await lib.waitScreen(p2, /\$ /);
        await sleep(600);
        await p2.screenshot({ path: path.join(SHOTS, 'landscape.png') });
        const lay = await p2.evaluate(() => {
            const scr = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { rows: window.term.rows, cols: window.term.cols, h: scr.height };
        });
        r.add(g, 'landscape layout has usable rows', lay.rows >= 12, JSON.stringify(lay));
        await l.close();
    },
};
