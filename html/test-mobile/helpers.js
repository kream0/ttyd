// Page-level helpers shared by the mobile test groups.
const fs = require('fs');
const lib = require('./lib');
const { sleep, text } = lib;

const INPUT = '0';
const inputFrames = log => log.sent.filter(f => text(f.d)[0] === INPUT).map(f => text(f.d).slice(1));
const hex = s => Buffer.from(s, 'utf8').toString('hex');

async function bootPage(context, url, host) {
    const page = await context.newPage();
    const log = lib.watch(page, host);
    await page.goto(url);
    await page.waitForFunction(() => window.term && window.term.cols > 0, null, { timeout: 15000 });
    return { page, log };
}

async function untilOpen(page, timeout = 10000) {
    await page.waitForSelector('.m-dot[data-state="open"]', { timeout });
}

async function until(fn, timeout = 5000, step = 40) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = await fn();
        if (value) return value;
        await sleep(step);
    }
    return false;
}

async function waitFile(file, want, timeout = 6000) {
    let got = '';
    await until(() => {
        try {
            got = fs.readFileSync(file, 'utf8');
        } catch {
            got = '';
        }
        return got === want;
    }, timeout);
    return got;
}

async function typeCompose(page, value) {
    await page.tap('.m-input');
    await page.keyboard.insertText(value);
}

// Real touch events through the browser's input pipeline.
async function swipe(cdp, x, fromY, toY, { steps = 12, stepMs = 16, release = true, hold = 0 } = {}) {
    const point = y => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(fromY) });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: point(fromY + ((toY - fromY) * i) / steps),
        });
        await sleep(stepMs);
    }
    if (hold) await sleep(hold);
    if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function pinch(cdp, cx, cy, from, to, steps = 8) {
    const points = d => [
        { x: cx - d / 2, y: cy, id: 1 },
        { x: cx + d / 2, y: cy, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: points(from + ((to - from) * i) / steps),
        });
        await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const uiState = page =>
    page.evaluate(() => ({
        active: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
        value: document.querySelector('.m-input') && document.querySelector('.m-input').value,
        chip: document.querySelector('.m-chip-label') && document.querySelector('.m-chip-label').textContent,
        state: document.querySelector('.m-dot') && document.querySelector('.m-dot').dataset.state,
    }));

module.exports = { inputFrames, hex, bootPage, untilOpen, until, waitFile, typeCompose, swipe, pinch, uiState };
