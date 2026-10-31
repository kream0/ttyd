// Shared helpers for the mobile test runner. Everything runs on a throwaway tmux socket.
const { chromium } = require('playwright-core');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRATCH = process.env.MOBILE_TEST_DIR || '/home/karimel/sandbox/ttyd-mobile-test';
const SOCKET = 'mterm-dev';
const UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
const PORTRAIT = { width: 412, height: 915 };
const LANDSCAPE = { width: 915, height: 412 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmux(...args) {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tmuxKill() {
    try {
        tmux('kill-server');
    } catch {
        // not running
    }
}

const children = new Set();

function startTtyd({ version = '1.7.7', port, page, conf = 'owner.conf', extra = [], cmd }) {
    const bin = path.join(SCRATCH, 'bin', `ttyd-${version}`);
    const command = cmd || [
        'env',
        `HOME=${path.join(SCRATCH, 'home')}`,
        'tmux',
        '-L',
        SOCKET,
        '-f',
        path.join(SCRATCH, 'cfg', conf),
        'new-session',
        '-A',
        '-s',
        'm',
    ];
    const args = [
        '-p',
        String(port),
        '-i',
        '127.0.0.1',
        '-W',
        '-I',
        page,
        '-t',
        'fontSize=14',
        '-t',
        'theme={"background":"#1a1b26","foreground":"#c0caf5"}',
        ...extra,
        ...command,
    ];
    const child = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color', TMUX: '' } });
    children.add(child);
    child.on('exit', () => children.delete(child));
    return child;
}

async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    const gone = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, sleep(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitPort(port, timeout = 5000) {
    const net = require('net');
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const ok = await new Promise(r => {
            const s = net.connect(port, '127.0.0.1');
            s.once('connect', () => (s.destroy(), r(true)));
            s.once('error', () => r(false));
        });
        if (ok) return;
        await sleep(50);
    }
    throw new Error(`port ${port} not listening`);
}

async function launch(args = []) {
    return chromium.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', ...args],
    });
}

function mobileContext(browser, viewport = PORTRAIT) {
    return browser.newContext({ viewport, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: UA });
}

function desktopContext(browser) {
    return browser.newContext({ viewport: { width: 1280, height: 800 } });
}

// Collects everything a page should never do: console errors, page errors, non-local requests.
function watch(page, host = '127.0.0.1') {
    const log = { errors: [], external: [], ws: [], sent: [], received: 0 };
    page.on('console', m => {
        if (m.type() === 'error') log.errors.push(m.text());
    });
    page.on('pageerror', e => log.errors.push(String(e)));
    page.on('request', r => {
        const u = new URL(r.url());
        if (!['data:', 'blob:'].includes(u.protocol) && u.hostname !== host) log.external.push(r.url());
    });
    page.on('websocket', ws => {
        log.ws.push(ws.url());
        ws.on('framesent', f => log.sent.push({ t: Date.now(), d: f.payload }));
        ws.on('framereceived', () => log.received++);
    });
    return log;
}

const text = p => (Buffer.isBuffer(p) ? p.toString('utf8') : String(p));
const resizes = log =>
    log.sent.filter(f => text(f.d)[0] === '1' && text(f.d).includes('columns')).map(f => JSON.parse(text(f.d).slice(1)));

// Visible terminal rows as plain text.
function screen(page) {
    return page.evaluate(() => {
        const b = window.term.buffer.active;
        const out = [];
        for (let i = 0; i < window.term.rows; i++) {
            const l = b.getLine(b.viewportY + i);
            out.push(l ? l.translateToString(true) : '');
        }
        return out;
    });
}

async function waitScreen(page, re, timeout = 5000) {
    const start = Date.now();
    let last = [];
    while (Date.now() - start < timeout) {
        last = await screen(page);
        if (re.test(last.join('\n'))) return true;
        await sleep(40);
    }
    return false;
}

class Results {
    constructor(file) {
        this.file = file;
        this.rows = [];
        if (file) fs.writeFileSync(file, '');
    }
    add(group, name, ok, detail = '') {
        const state = ok === null ? 'NOTRUN' : ok ? 'PASS' : 'FAIL';
        const row = `${state}\t${group}\t${name}\t${detail}`;
        this.rows.push({ state, group, name, detail });
        if (this.file) fs.appendFileSync(this.file, row + '\n');
        console.log(row);
        return ok;
    }
    summary() {
        const c = s => this.rows.filter(r => r.state === s).length;
        return `PASS ${c('PASS')} FAIL ${c('FAIL')} NOTRUN ${c('NOTRUN')}`;
    }
}

async function cleanup() {
    for (const c of [...children]) await stopChild(c);
}

module.exports = {
    SCRATCH,
    SOCKET,
    PORTRAIT,
    LANDSCAPE,
    UA,
    sleep,
    tmux,
    tmuxKill,
    startTtyd,
    stopChild,
    waitPort,
    launch,
    mobileContext,
    desktopContext,
    watch,
    text,
    resizes,
    screen,
    waitScreen,
    Results,
    cleanup,
};
