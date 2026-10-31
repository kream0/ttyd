// Reconnect, crash hardening, desktop parity, server versions and the reverse proxy.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const h = require('./helpers');
const { startProxy } = require('./proxy');

const { sleep } = lib;
const FAILED_WS =
    /WebSocket connection to .* failed|ERR_CONNECTION_REFUSED|Failed to load resource|\[ttyd\] fetch .*token.*Failed to fetch/s;
const realErrors = log => log.errors.filter(e => !FAILED_WS.test(e));

// Counts sockets and listeners from the first line of the page.
const SPY = () => {
    window.__socks = [];
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
        constructor(...a) {
            super(...a);
            window.__socks.push(this);
        }
    };
    window.__unload = 0;
    const add = window.addEventListener;
    window.addEventListener = function (type, ...rest) {
        if (type === 'beforeunload') window.__unload++;
        return add.call(this, type, ...rest);
    };
    window.__gl = 0;
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (/webgl/.test(type)) window.__gl++;
        return get.call(this, type, ...rest);
    };
    window.__shows = [];
    add.call(window, 'pageshow', e => window.__shows.push(e.persisted));
};
// Page.crash never answers, and closing a dead page can hang.
async function crashPage(context, page) {
    const cdp = await context.newCDPSession(page);
    cdp.send('Page.crash').catch(() => {});
    await sleep(600);
    await Promise.race([page.close().catch(() => {}), sleep(1500)]);
}
const liveSockets = page => page.evaluate(() => window.__socks.filter(s => s.readyState <= 1).length);
const setHidden = (page, hidden) =>
    page.evaluate(v => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (v ? 'hidden' : 'visible'),
        });
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
const stateIs = (page, want, timeout = 8000) => h.until(async () => (await h.uiState(page)).state === want, timeout);

const armed = new WeakSet();
async function spied(context, url, host) {
    if (!armed.has(context)) await context.addInitScript(SPY);
    armed.add(context);
    return h.bootPage(context, url, host);
}

// Proves input still reaches the shell, through the compose field.
async function roundTrip(page, tmp, name) {
    const file = path.join(tmp, name);
    await h.typeCompose(page, `echo ok > ${file}`);
    await page.tap('[data-key=send]');
    return (await h.waitFile(file, 'ok\n')) === 'ok\n';
}

async function metrics(cdp) {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics: m } = await cdp.send('Performance.getMetrics');
    const get = n => m.find(x => x.name === n).value;
    return {
        heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(2),
        nodes: get('Nodes'),
        listeners: get('JSEventListeners'),
    };
}

module.exports = {
    async grow(ctx) {
        const { results: r, group: g, port } = ctx;
        lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        const context = await lib.mobileContext(ctx.browser);
        const { page, log } = await h.bootPage(context, `http://127.0.0.1:${port}/`);
        await h.untilOpen(page);
        await lib.waitScreen(page, /\$ /);
        await page.setViewportSize({ width: 412, height: 515 });
        await sleep(500);
        const fits = () =>
            page.evaluate(() => {
                const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
                const keys = document.querySelector('.m-keys').getBoundingClientRect();
                return { over: Math.round(screen.bottom - keys.top), rows: window.term.rows };
            });
        const start = await fits();
        const before = lib.resizes(log).length;
        await h.typeCompose(
            page,
            'voici un texte assez long pour remplir plus de deux lignes du champ de saisie, avec encore des mots'
        );
        await sleep(500);
        const grown = await fits();
        const shown = (await lib.screen(page)).join('\n');
        r.add(
            g,
            'long text: terminal gives up rows, none hidden',
            grown.rows < start.rows && grown.over <= 0,
            `rows ${start.rows} -> ${grown.rows}, overlap ${grown.over} px`
        );
        r.add(g, 'long text: tmux status bar still shown', /demo/.test(shown));
        await page.tap('[data-key=send]');
        await sleep(600);
        const back = await fits();
        r.add(g, 'after send: rows come back', back.rows === start.rows && back.over <= 0, `rows ${back.rows}`);
        r.add(
            g,
            'one resize each way',
            lib.resizes(log).length - before === 2,
            `${lib.resizes(log).length - before} resizes`
        );
        await context.close();
    },

    async reconnect(ctx) {
        const { results: r, group: g, port } = ctx;
        let ttyd = lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        const context = await lib.mobileContext(ctx.browser);
        const { page, log } = await spied(context, `http://127.0.0.1:${port}/`);
        await h.untilOpen(page);
        await lib.waitScreen(page, /\$ /);
        r.add(g, 'one socket after start', (await liveSockets(page)) === 1);

        await h.typeCompose(page, 'brouillon gardé é à 😀');
        await lib.stopChild(ttyd);
        const down = await stateIs(page, 'retrying');
        r.add(g, 'server gone: status shows retrying', !!down, (await h.uiState(page)).state);
        await sleep(2500);
        const modal = await page.evaluate(() => !!document.querySelector('.xterm-overlay'));
        r.add(g, 'server gone: no overlay over the terminal', !modal);
        ttyd = lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        const t0 = Date.now();
        const back = await stateIs(page, 'open', 20000);
        const took = Date.now() - t0;
        r.add(g, 'server back: reconnects with no input', !!back, `${took} ms after the port came back`);
        r.add(g, 'draft kept across reconnect', (await h.uiState(page)).value === 'brouillon gardé é à 😀');
        await sleep(400);
        r.add(g, 'one socket after reconnect', (await liveSockets(page)) === 1, String(await liveSockets(page)));
        await page.fill('.m-input', '');
        r.add(g, 'typing works after reconnect', await roundTrip(page, ctx.tmp, 'rc1.txt'));

        await page.evaluate(() => window.__socks[window.__socks.length - 1].close());
        const forced = await stateIs(page, 'retrying', 2000).then(() => stateIs(page, 'open', 12000));
        await sleep(300);
        r.add(g, 'forced socket close: back alone, one socket', !!forced && (await liveSockets(page)) === 1);

        // Hidden: a live socket is left alone, a lost one waits until the page is visible
        const countA = log.ws.length;
        await setHidden(page, true);
        await sleep(400);
        r.add(g, 'hidden: open socket stays, nothing new', log.ws.length === countA && (await liveSockets(page)) === 1);
        await lib.stopChild(ttyd);
        await stateIs(page, 'paused', 3000);
        const st = (await h.uiState(page)).state;
        ttyd = lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        await sleep(5000);
        r.add(
            g,
            'hidden: no reconnect while hidden',
            st === 'paused' && log.ws.length === countA,
            `${st}, ${log.ws.length - countA} new sockets in 5 s`
        );
        const t1 = Date.now();
        await setHidden(page, false);
        const woke = await stateIs(page, 'open', 6000);
        r.add(
            g,
            'visible again: reconnects at once',
            !!woke && log.ws.length === countA + 1,
            `${Date.now() - t1} ms, ${log.ws.length - countA} socket`
        );
        await sleep(300);
        r.add(g, 'typing works after wake', await roundTrip(page, ctx.tmp, 'rc2.txt'));

        const errs = realErrors(log);
        r.add(g, 'no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 200));
        r.add(g, 'no external requests', log.external.length === 0, log.external.slice(0, 2).join(' '));
        await context.close();
        await lib.stopChild(ttyd);
    },

    async flood(ctx) {
        const { results: r, group: g, port } = ctx;
        const flood = lib.startTtyd({
            port,
            page: ctx.page,
            cmd: ['bash', '--norc', '-c', 'PS1="$ " exec bash --norc'],
        });
        await lib.waitPort(port);
        const c2 = await lib.mobileContext(ctx.browser);
        const { page: p2, log: l2 } = await spied(c2, `http://127.0.0.1:${port}/`);
        await h.untilOpen(p2);
        await h.typeCompose(p2, 'seq 1 600000; echo end-of-flood');
        await p2.tap('[data-key=send]');
        const finished = await lib.waitScreen(p2, /\nend-of-flood/, 60000);
        const frames = l2.sent.map(f => lib.text(f.d)[0]);
        const pauses = frames.filter(c => c === '2').length;
        const resumes = frames.filter(c => c === '3').length;
        r.add(
            g,
            'flow control pauses and resumes under a flood',
            !!finished && pauses > 0 && resumes > 0,
            `${pauses} pauses, ${resumes} resumes`
        );
        const last = await p2.evaluate(() => {
            const b = window.term.buffer.active;
            for (let i = b.length - 1; i >= 0; i--)
                if (/^\d+$/.test(b.getLine(i).translateToString(true))) return b.getLine(i).translateToString(true);
        });
        r.add(g, 'flood arrived whole', last === '600000', last);
        const before = l2.ws.length;
        await h.typeCompose(p2, 'exit');
        await p2.tap('[data-key=send]');
        await sleep(3000);
        const end = (await h.uiState(p2)).state;
        r.add(
            g,
            'process ended: stops, no retry loop',
            l2.ws.length === before,
            `state ${end}, ${l2.ws.length - before} new sockets`
        );
        await c2.close();
        await lib.stopChild(flood);
    },

    async crash(ctx) {
        const { results: r, group: g, port } = ctx;
        lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        const url = `http://127.0.0.1:${port}/`;
        const context = await lib.mobileContext(ctx.browser);

        // Navigate away and back
        const { page, log } = await spied(context, url);
        await h.untilOpen(page);
        await lib.waitScreen(page, /\$ /);
        r.add(g, 'touch default: no WebGL context asked for', (await page.evaluate(() => window.__gl)) === 0);
        const shape = await page.evaluate(() => ({
            canvases: document.querySelectorAll('.xterm-screen canvas').length,
            rows: !!document.querySelector('.xterm-rows'),
        }));
        r.add(g, 'touch default: DOM renderer', shape.canvases === 0 && shape.rows, JSON.stringify(shape));
        r.add(g, 'no beforeunload listener on touch', (await page.evaluate(() => window.__unload)) === 0);
        await sleep(2300);
        const booted = await page.evaluate(() => localStorage.getItem('ttyd-mobile:boot'));
        r.add(g, 'start flag cleared after first paint', booted === null, String(booted));
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        });
        await sleep(200);
        r.add(g, 'pagehide closes the socket', (await liveSockets(page)) === 0, (await h.uiState(page)).state);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        const shown = await stateIs(page, 'open', 6000);
        await sleep(300);
        r.add(
            g,
            'pageshow persisted reconnects, one socket, one terminal',
            !!shown &&
                (await liveSockets(page)) === 1 &&
                (await page.evaluate(() => document.querySelectorAll('.xterm').length)) === 1
        );

        await page.goto('about:blank');
        await sleep(300);
        await page.goBack();
        await page.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 15000 });
        await stateIs(page, 'open', 8000);
        await sleep(400);
        const nav = await page.evaluate(() => {
            const e = performance.getEntriesByType('navigation')[0];
            return {
                shows: window.__shows,
                type: e.type,
                reasons: e.notRestoredReasons
                    ? JSON.stringify(e.notRestoredReasons.reasons || e.notRestoredReasons)
                    : null,
            };
        });
        r.add(
            g,
            'away and back: terminal works',
            (await liveSockets(page)) === 1 && (await roundTrip(page, ctx.tmp, 'c1.txt')),
            JSON.stringify(nav).slice(0, 220)
        );

        // Frozen then active
        const cdp = await context.newCDPSession(page);
        await cdp.send('Page.enable');
        await cdp.send('Performance.enable');
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        await sleep(600);
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        const thawed = await stateIs(page, 'open', 8000);
        await sleep(400);
        const sockets = await liveSockets(page);
        r.add(
            g,
            'frozen then active: back, one socket, one terminal',
            !!thawed && sockets === 1 && (await page.evaluate(() => document.querySelectorAll('.xterm').length)) === 1,
            `${sockets} sockets`
        );
        r.add(g, 'typing works after thaw', await roundTrip(page, ctx.tmp, 'c2.txt'));

        // Many reconnect cycles: memory should not grow
        const m0 = await metrics(cdp);
        for (let i = 0; i < 10; i++) {
            await setHidden(page, true);
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
            await sleep(100);
            await setHidden(page, false);
            await stateIs(page, 'open', 6000);
            await page.evaluate(() => window.term.clearTextureAtlas());
        }
        await sleep(500);
        const m1 = await metrics(cdp);
        r.add(
            g,
            '10 hide and wake cycles: memory steady',
            m1.heapMB - m0.heapMB < 2 && m1.listeners - m0.listeners < 30,
            `heap ${m0.heapMB} -> ${m1.heapMB} MB, nodes ${m0.nodes} -> ${m1.nodes}, listeners ${m0.listeners} -> ${m1.listeners}`
        );
        r.add(g, 'one socket after 10 cycles', (await liveSockets(page)) === 1);
        const errs = realErrors(log);
        r.add(g, 'no unexpected console errors so far', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 200));
        await page.close();

        // Tab close and reopen, ten times
        const times = [];
        let bad = 0;
        const heaps = [];
        for (let i = 0; i < 10; i++) {
            const t = Date.now();
            const { page: p, log: l } = await spied(context, url);
            await h.untilOpen(p);
            times.push(Date.now() - t);
            const safe = await p.evaluate(() => !!document.querySelector('[data-line=safe]'));
            const socks = await liveSockets(p);
            if (safe || socks !== 1 || realErrors(l).length) bad++;
            heaps.push(+(await p.evaluate(() => performance.memory.usedJSHeapSize / 1048576)).toFixed(1));
            await p.close();
        }
        r.add(
            g,
            'tab closed and reopened 10 times: clean',
            bad === 0,
            `open in ${Math.min(...times)}-${Math.max(...times)} ms, heap ${heaps[0]} -> ${heaps[9]} MB, ${bad} bad`
        );

        // Forced renderer crash, long after start: next load is normal
        const a = await spied(context, url);
        await h.untilOpen(a.page);
        await sleep(2300);
        await crashPage(context, a.page);
        const b = await spied(context, url);
        await h.untilOpen(b.page);
        const afterLate = await b.page.evaluate(() => !!document.querySelector('[data-line=safe]'));
        r.add(g, 'crash after a good start: next load is normal', !afterLate);
        r.add(g, 'crash after a good start: terminal works', await roundTrip(b.page, ctx.tmp, 'c3.txt'));
        await sleep(2300);

        // Forced renderer crash during the start window: next load is the safest mode
        const c = await spied(context, url);
        await c.page.waitForFunction(() => localStorage.getItem('ttyd-mobile:boot') !== null, null, { timeout: 8000 });
        await crashPage(context, c.page);
        await b.page.close();
        const d = await spied(context, `${url}`);
        await h.untilOpen(d.page);
        const safeInfo = await d.page.evaluate(() => ({
            line: !!document.querySelector('[data-line=safe]'),
            scrollback: window.term.options.scrollback,
            canvases: document.querySelectorAll('.xterm-screen canvas').length,
            gl: window.__gl,
        }));
        r.add(
            g,
            'crash during start: next load uses safe mode and says so',
            safeInfo.line && safeInfo.canvases === 0 && safeInfo.gl === 0,
            JSON.stringify(safeInfo)
        );
        r.add(g, 'safe mode: terminal works', await roundTrip(d.page, ctx.tmp, 'c4.txt'));
        await d.page.tap('[data-line=safe] button');
        await sleep(800);
        await d.page.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 15000 });
        await h.untilOpen(d.page);
        r.add(
            g,
            'Try normal leaves safe mode',
            !(await d.page.evaluate(() => !!document.querySelector('[data-line=safe]')))
        );
        await context.close();

        // Storage blocked altogether
        const blocked = await lib.mobileContext(ctx.browser);
        await blocked.addInitScript(() => {
            Object.defineProperty(window, 'localStorage', {
                get() {
                    throw new Error('blocked');
                },
            });
        });
        const e = await spied(blocked, url);
        await h.untilOpen(e.page);
        r.add(
            g,
            'storage blocked: page still works',
            await roundTrip(e.page, ctx.tmp, 'c5.txt'),
            realErrors(e.log).slice(0, 1).join('').slice(0, 150)
        );
        await blocked.close();

        // Page opened hidden: nothing is created until it is visible
        const hid = await lib.mobileContext(ctx.browser);
        await hid.addInitScript(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        });
        await hid.addInitScript(SPY);
        armed.add(hid);
        const hp = await hid.newPage();
        await hp.goto(url);
        await sleep(1500);
        const hiddenState = await hp.evaluate(() => ({
            term: !!window.term,
            socks: window.__socks.length,
            gl: window.__gl,
        }));
        r.add(
            g,
            'opened hidden: no terminal, no socket yet',
            !hiddenState.term && hiddenState.socks === 0,
            JSON.stringify(hiddenState)
        );
        await setHidden(hp, false);
        await hp.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 8000 });
        await h.untilOpen(hp);
        r.add(g, 'opened hidden: starts once visible, one socket', (await liveSockets(hp)) === 1);

        // Zero size must not reach fit or the server
        const beforeZero = lib.resizes;
        const hlog = lib.watch(hp);
        const dims = await hp.evaluate(() => [window.term.cols, window.term.rows]);
        await hp.evaluate(() => {
            document.querySelector('#terminal-container').style.display = 'none';
            window.dispatchEvent(new Event('resize'));
            window.visualViewport && window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await sleep(700);
        const zero = await hp.evaluate(() => [window.term.cols, window.term.rows]);
        await hp.evaluate(() => {
            document.querySelector('#terminal-container').style.display = '';
        });
        r.add(
            g,
            'zero size: no fit, no resize sent',
            zero[0] === dims[0] && zero[1] === dims[1] && beforeZero(hlog).length === 0 && hlog.errors.length === 0,
            `${zero.join('x')}`
        );
        await hid.close();
    },

    async webgl(ctx) {
        const { results: r, group: g, port } = ctx;
        lib.startTtyd({ port, page: ctx.page });
        await lib.waitPort(port);
        const url = `http://127.0.0.1:${port}/?webgl=1`;
        const context = await lib.mobileContext(ctx.browser);
        let repaint = 0;
        const heap = [];
        const notes = [];
        const rounds = 5;
        for (let i = 0; i < rounds; i++) {
            const { page, log } = await spied(context, url);
            await h.untilOpen(page);
            await lib.waitScreen(page, /\$ /);
            const marker = `gl-round-${i}`;
            await h.typeCompose(page, `echo ${marker}`);
            await page.tap('[data-key=send]');
            await lib.waitScreen(page, new RegExp(`\\n${marker}`));
            const has = await page.evaluate(() => {
                const canvas = [...document.querySelectorAll('.xterm-screen canvas')].find(c => !c.className);
                if (!canvas) return false;
                const gl = canvas.getContext('webgl2');
                gl.getExtension('WEBGL_lose_context').loseContext();
                return true;
            });
            // the addon waits 3 s for the browser to restore the context before it reports the loss
            await sleep(3600);
            const after = await page.evaluate(
                m => ({
                    rows: document.querySelector('.xterm-rows')
                        ? document.querySelector('.xterm-rows').innerText.includes(m)
                        : false,
                    canvases: [...document.querySelectorAll('.xterm-screen canvas')].filter(c => !c.className).length,
                }),
                marker
            );
            if (has && after.rows && after.canvases === 0 && !realErrors(log).length) repaint++;
            else notes.push(JSON.stringify({ has, after, errors: realErrors(log).slice(0, 2) }).slice(0, 260));
            await h.typeCompose(page, `echo still-here-${i}`);
            await page.tap('[data-key=send]');
            await lib.waitScreen(page, new RegExp(`\\nstill-here-${i}`));
            heap.push(+(await page.evaluate(() => performance.memory.usedJSHeapSize / 1048576)).toFixed(1));
            await page.close();
        }
        r.add(
            g,
            `?webgl=1: context lost ${rounds} times, repaints with DOM each time`,
            repaint === rounds,
            `${repaint}/${rounds}, heap ${heap.join(' ')} MB ${notes[0] || ''}`
        );
        await context.close();

        const noGl = await lib.launch(['--disable-3d-apis', '--disable-gpu']);
        const c2 = await lib.mobileContext(noGl);
        const { page, log } = await spied(c2, url);
        await h.untilOpen(page);
        const works = await page.evaluate(() => {
            const c = document.createElement('canvas');
            return { gl: !!c.getContext('webgl2'), rows: !!document.querySelector('.xterm-rows') };
        });
        const typed = await roundTrip(page, ctx.tmp, 'g1.txt');
        r.add(
            g,
            'WebGL unavailable: ?webgl=1 falls back and works',
            !works.gl && works.rows && typed && !realErrors(log).length,
            JSON.stringify({ ...works, typed, errors: realErrors(log).slice(0, 2) }).slice(0, 300)
        );
        await noGl.close();
    },

    async desktop(ctx) {
        const { results: r, group: g, port } = ctx;
        const shape = page =>
            page.evaluate(() => {
                const walk = el =>
                    `${el.tagName}#${el.id}.${
                        el.className && el.className.baseVal === undefined ? el.className : ''
                    }[${[...el.children].map(walk).join(',')}]`;
                const skip = el => !['SCRIPT', 'STYLE'].includes(el.tagName);
                return [...document.body.children].filter(skip).map(walk).join('|');
            });
        const look = async (file, port_, name) => {
            const child = lib.startTtyd({ port: port_, page: file });
            await lib.waitPort(port_);
            const context = await lib.desktopContext(ctx.browser);
            const { page, log } = await spied(context, `http://127.0.0.1:${port_}/`);
            await h.untilOpen(page).catch(() => {});
            await lib.waitScreen(page, /\$ /);
            await sleep(500);
            const out = {
                shape: await shape(page),
                unload: await page.evaluate(() => window.__unload),
                font: await page.evaluate(() => window.term.options.fontSize),
                scrollback: await page.evaluate(() => window.term.options.scrollback),
                dims: await page.evaluate(() => `${window.term.cols}x${window.term.rows}`),
                bg: await page.evaluate(() => window.term.options.theme.background),
                ui: await page.evaluate(() => !!document.querySelector('#ttyd-mobile-ui')),
                errors: realErrors(log),
                external: log.external,
            };
            if (name === 'new') {
                const file2 = path.join(ctx.tmp, 'desk.txt');
                await page.click('.xterm');
                await page.keyboard.type(`echo typed-direct > ${file2}\n`, { delay: 5 });
                const got = await h.waitFile(file2, 'typed-direct\n');
                r.add(
                    g,
                    'typing goes straight to the terminal',
                    got === 'typed-direct\n',
                    await page.evaluate(() => document.activeElement.className)
                );
            }
            await context.close();
            await lib.stopChild(child);
            lib.tmuxKill();
            return out;
        };
        const base = await look(path.resolve(lib.SCRATCH, 'baseline.html'), port, 'base');
        const now = await look(ctx.page, port + 200, 'new');
        r.add(g, 'no touch UI at 1280x800', !now.ui);
        r.add(
            g,
            'DOM identical to upstream',
            base.shape === now.shape,
            now.shape === base.shape
                ? `${now.shape.length} chars compared`
                : `base ${base.shape.slice(0, 120)} / new ${now.shape.slice(0, 120)}`
        );
        for (const k of ['font', 'scrollback', 'dims', 'bg', 'unload'])
            r.add(g, `same as upstream: ${k}`, base[k] === now[k], `${base[k]} / ${now[k]}`);
        r.add(
            g,
            'no console errors, no external requests',
            !now.errors.length && !now.external.length,
            now.errors.join('').slice(0, 150)
        );

        const child = lib.startTtyd({ port: port + 201, page: ctx.page });
        await lib.waitPort(port + 201);
        const d = await lib.desktopContext(ctx.browser);
        const forced = await spied(d, `http://127.0.0.1:${port + 201}/?mobile=1`);
        await forced.page.waitForSelector('#ttyd-mobile-ui', { timeout: 8000 }).catch(() => {});
        r.add(
            g,
            '?mobile=1 turns the touch UI on',
            await forced.page.evaluate(() => !!document.querySelector('#ttyd-mobile-ui'))
        );
        await d.close();
        const m = await lib.mobileContext(ctx.browser);
        const off = await spied(m, `http://127.0.0.1:${port + 201}/?mobile=0`);
        await sleep(800);
        r.add(
            g,
            '?mobile=0 turns the touch UI off on a phone',
            !(await off.page.evaluate(() => !!document.querySelector('#ttyd-mobile-ui')))
        );
        const bg = await off.page.evaluate(() => window.term.options.theme.background);
        r.add(g, '-t theme honored', bg === '#1a1b26', bg);
        await m.close();
        await lib.stopChild(child);
    },

    async matrix(ctx) {
        const { results: r, group: g } = ctx;
        let port = ctx.port + 300;
        for (const version of ['1.7.4', '1.7.7']) {
            for (const proxied of [false, true]) {
                const label = `${version} ${proxied ? 'via /m/ proxy' : 'direct'}`;
                lib.tmuxKill();
                const backend = port++;
                const child = lib.startTtyd({ version, port: backend, page: ctx.page });
                await lib.waitPort(backend);
                let proxy;
                let url = `http://127.0.0.1:${backend}/`;
                if (proxied) {
                    const front = port++;
                    proxy = await startProxy(front, backend);
                    url = `http://127.0.0.1:${front}/m/`;
                }
                const context = await lib.mobileContext(ctx.browser);
                await context.addInitScript(SPY);
                armed.add(context);
                const page = await context.newPage();
                const log = lib.watch(page);
                const requests = [];
                page.on('request', q => requests.push(new URL(q.url()).pathname));
                await page.goto(url);
                await page.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 15000 });
                await h.untilOpen(page);
                await lib.waitScreen(page, /\$ /);
                const wsPath = new URL(log.ws[0]).pathname;
                const wantWs = proxied ? '/m/ws' : '/ws';
                const wantToken = proxied ? '/m/token' : '/token';
                r.add(
                    g,
                    `${label}: socket and token paths`,
                    wsPath === wantWs && requests.includes(wantToken),
                    `${wsPath}, ${requests.filter(p => /token/.test(p)).join(' ')}`
                );
                r.add(g, `${label}: typing works`, await roundTrip(page, ctx.tmp, `m-${version}-${proxied}.txt`));
                await page.evaluate(() => window.__socks[window.__socks.length - 1].close());
                await stateIs(page, 'retrying', 2000);
                const back = await stateIs(page, 'open', 12000);
                await sleep(300);
                r.add(
                    g,
                    `${label}: reconnects, one socket`,
                    !!back && (await liveSockets(page)) === 1 && new URL(log.ws[log.ws.length - 1]).pathname === wantWs
                );
                r.add(
                    g,
                    `${label}: typing works after reconnect`,
                    await roundTrip(page, ctx.tmp, `m2-${version}-${proxied}.txt`)
                );
                r.add(
                    g,
                    `${label}: no console errors, no external requests`,
                    !realErrors(log).length && !log.external.length,
                    realErrors(log).concat(log.external).join(' ').slice(0, 160)
                );
                await context.close();
                const desk = await lib.desktopContext(ctx.browser);
                const dp = await desk.newPage();
                await dp.goto(url);
                await dp.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 15000 });
                await sleep(500);
                r.add(
                    g,
                    `${label}: desktop page plain`,
                    !(await dp.evaluate(() => !!document.querySelector('#ttyd-mobile-ui')))
                );
                await desk.close();
                if (proxy) proxy.close();
                await lib.stopChild(child);
            }
        }
    },
};
