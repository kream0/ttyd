const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const h = require('./helpers');
const { sleep, tmux } = lib;

const PY = 'python3';

async function shell(ctx, conf = 'owner.conf') {
    lib.startTtyd({ port: ctx.port, page: ctx.page, conf });
    await lib.waitPort(ctx.port);
    const context = await lib.mobileContext(ctx.browser);
    const { page, log } = await h.bootPage(context, `http://127.0.0.1:${ctx.port}/`);
    await h.untilOpen(page);
    await lib.waitScreen(page, /\$ /);
    return { context, page, log };
}

async function capture(file) {
    tmux('send-keys', '-t', 'm', '-l', `cat > ${file}`);
    tmux('send-keys', '-t', 'm', 'Enter');
    await sleep(250);
}

const endCapture = () => tmux('send-keys', '-t', 'm', 'C-d');

module.exports = {
    async compose(ctx) {
        const { results: r, group: g } = ctx;
        const { context, page, log } = await shell(ctx);
        const cdp = await context.newCDPSession(page);
        const gate = await page.evaluate(() => ({
            coarse: matchMedia('(pointer: coarse)').matches,
            cls: document.documentElement.className,
            xtermDisabled: document.querySelector('.xterm-helper-textarea').disabled,
            meta: document.querySelector('meta[name=viewport]').content,
        }));
        r.add(
            g,
            'profile reports a coarse pointer, mobile UI on',
            gate.coarse && gate.cls.includes('ttyd-mobile'),
            `coarse=${gate.coarse}`
        );
        r.add(
            g,
            'viewport meta set',
            /interactive-widget=resizes-content/.test(gate.meta) && /viewport-fit=cover/.test(gate.meta)
        );
        r.add(g, 'xterm textarea cannot take focus', gate.xtermDisabled);

        const file = path.join(ctx.tmp, 'compose.txt');
        await capture(file);
        const accents = 'éàçùœ ÉÀ naïve “guillemets” – 你好 😀 👍🏽 👨‍👩‍👧';
        await h.typeCompose(page, accents);
        await page.tap('[data-key=send]');
        await sleep(200);
        let st = await h.uiState(page);
        r.add(
            g,
            'Send clears field, compose keeps focus',
            st.value === '' && st.active === 'm-input',
            JSON.stringify(st)
        );

        const sentence =
            'Je voudrais que tu regardes pourquoi le déploiement échoue, then tell me what you think we should do next, because the previous attempt did not work at all and I am not sure why.';
        await page.keyboard.insertText(sentence);
        await page.keyboard.press('Enter');
        await sleep(200);

        const long = Array.from({ length: 260 }, (_, i) => `mot${i}é`).join(' ');
        await page.keyboard.insertText(long);
        await page.tap('[data-key=send]');
        const want = `${accents}\n${sentence}\n${long}\n`;
        let got = await h.waitFile(file, want);
        r.add(
            g,
            'accents, emoji, long sentence and long text arrive intact',
            got === want,
            `long=${long.length} chars, got=${got.length} want=${want.length}`
        );
        endCapture();
        await sleep(200);

        // IME sequences as Gboard swipe and voice produce them
        const ime = path.join(ctx.tmp, 'ime.txt');
        await capture(ime);
        await page.tap('.m-input');
        const sendKey229 = async type =>
            cdp.send('Input.dispatchKeyEvent', {
                type,
                windowsVirtualKeyCode: 229,
                nativeVirtualKeyCode: 229,
                key: 'Unidentified',
                code: '',
            });
        const compose = t =>
            cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
        for (const word of ['bonjour', ' ', 'été', ' ', 'hello']) {
            if (word === ' ') {
                await sendKey229('rawKeyDown');
                await cdp.send('Input.insertText', { text: ' ' });
                await sendKey229('keyUp');
                continue;
            }
            for (let i = 1; i <= word.length; i++) {
                await sendKey229('rawKeyDown');
                await compose(word.slice(0, i));
                await sendKey229('keyUp');
            }
            await cdp.send('Input.insertText', { text: word });
        }
        st = await h.uiState(page);
        r.add(
            g,
            'IME composition leaves exact text in field',
            st.value === 'bonjour été hello',
            JSON.stringify(st.value)
        );
        await page.tap('[data-key=send]');
        await sleep(200);
        // Word still composing when Send is tapped, as after a Gboard swipe
        await sendKey229('rawKeyDown');
        await compose('compos');
        await sendKey229('keyUp');
        await sleep(30);
        await page.tap('[data-key=send]');
        await sleep(200);
        await page.keyboard.insertText('voix dictée complète');
        await sleep(30);
        await page.tap('[data-key=send]');
        const imeWant = 'bonjour été hello\ncompos\nvoix dictée complète\n';
        got = await h.waitFile(ime, imeWant);
        r.add(
            g,
            'IME: no duplicate, no loss, composing word sent once',
            got === imeWant,
            JSON.stringify(got).slice(0, 120)
        );
        st = await h.uiState(page);
        r.add(g, 'field empty after composing send', st.value === '', JSON.stringify(st.value));
        endCapture();
        await sleep(200);

        // Enter arriving as an inserted line break, as some keyboards do
        const brk = path.join(ctx.tmp, 'break.txt');
        await capture(brk);
        await page.keyboard.insertText('ligne');
        await cdp.send('Input.insertText', { text: '\n' });
        got = await h.waitFile(brk, 'ligne\n');
        r.add(g, 'newline from keyboard sends once', got === 'ligne\n', JSON.stringify(got));
        endCapture();
        await sleep(200);

        // Empty field goes straight to the terminal
        await page.tap('.m-input');
        const before = () => log.sent.length;
        const framesSince = n =>
            log.sent
                .slice(n)
                .filter(f => lib.text(f.d)[0] === '0')
                .map(f => lib.text(f.d).slice(1));
        const check = async (name, press, wantBytes) => {
            const n = before();
            await press();
            await sleep(120);
            const frames = framesSince(n);
            r.add(g, name, wantBytes.includes(frames.join('')), JSON.stringify(frames));
        };
        await check('empty field: Backspace', () => page.keyboard.press('Backspace'), ['\x7f']);
        await check('empty field: Enter', () => page.keyboard.press('Enter'), ['\r']);
        await check('empty field: ArrowUp', () => page.keyboard.press('ArrowUp'), ['\x1bOA', '\x1b[A']);
        await check('empty field: ArrowDown', () => page.keyboard.press('ArrowDown'), ['\x1bOB', '\x1b[B']);
        await check('empty field: ArrowLeft', () => page.keyboard.press('ArrowLeft'), ['\x1bOD', '\x1b[D']);
        await check('empty field: ArrowRight', () => page.keyboard.press('ArrowRight'), ['\x1bOC', '\x1b[C']);
        await check(
            'empty field: Gboard Backspace (key code 229, nothing changes)',
            async () => {
                await sendKey229('rawKeyDown');
                await sendKey229('keyUp');
            },
            ['\x7f']
        );

        await page.keyboard.insertText('abc');
        await check('text in field: Backspace edits the field only', () => page.keyboard.press('Backspace'), ['']);
        await check('text in field: arrow stays in the field', () => page.keyboard.press('ArrowLeft'), ['']);
        st = await h.uiState(page);
        r.add(g, 'field holds edited text', st.value === 'ab', JSON.stringify(st.value));
        await page.evaluate(() => {
            const el = document.querySelector('.m-input');
            el.setSelectionRange(el.value.length, el.value.length);
        });
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');

        // Shift+Enter or a pasted newline stays in the field
        await page.keyboard.insertText('un');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.insertText('deux');
        st = await h.uiState(page);
        r.add(g, 'Shift+Enter adds a line without sending', st.value === 'un\ndeux', JSON.stringify(st.value));
        const grown = await page.evaluate(() => {
            const el = document.querySelector('.m-input');
            return { h: el.clientHeight, max: parseInt(getComputedStyle(el).maxHeight, 10) };
        });
        r.add(g, 'field grows for extra lines', grown.h > 40 && grown.h <= grown.max, JSON.stringify(grown));
        await page.evaluate(() => {
            const el = document.querySelector('.m-input');
            el.value = '';
            el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContent' }));
        });

        r.add(g, 'no console errors', log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
        r.add(g, 'no external requests', log.external.length === 0, log.external.slice(0, 2).join(' '));
        await context.close();
    },

    async keys(ctx) {
        const { results: r, group: g } = ctx;
        const file = path.join(ctx.tmp, 'hex.log');
        lib.startTtyd({ port: ctx.port, page: ctx.page, cmd: [PY, path.join(__dirname, 'hexd.py'), file] });
        await lib.waitPort(ctx.port);
        const context = await lib.mobileContext(ctx.browser);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const { page, log } = await h.bootPage(context, `http://127.0.0.1:${ctx.port}/`);
        await h.untilOpen(page);
        await lib.waitScreen(page, /ready/);
        await page.tap('.m-input');

        const read = () => fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
        let mark = 0;
        const expectBytes = async (name, action, want) => {
            await action();
            let got = '';
            await h.until(() => {
                got = read().slice(mark);
                return got.length >= want.length;
            }, 1200);
            await sleep(30);
            got = read().slice(mark);
            mark += got.length;
            r.add(g, name, got === want, got === want ? want : `got ${got} want ${want}`);
        };
        const tapKey = k => () => page.tap(`[data-key="${k}"]`);
        const table = [
            ['esc', '1b'],
            ['tab', '09'],
            ['ctrl-c', '03'],
            ['left', '1b5b44'],
            ['up', '1b5b41'],
            ['down', '1b5b42'],
            ['right', '1b5b43'],
            ['home', '1b5b48'],
            ['end', '1b5b46'],
            ['pgup', '1b5b357e'],
            ['pgdn', '1b5b367e'],
            ['|', '7c'],
            ['~', '7e'],
            ['-', '2d'],
            ['/', '2f'],
            ['bksp', '7f'],
        ];
        for (const [k, want] of table) await expectBytes(`key ${k}`, tapKey(k), want);
        await expectBytes('Enter button on empty field', tapKey('send'), '0d');

        const seq =
            (...keys) =>
            async () => {
                for (const k of keys) await k();
            };
        const typed = t => () => page.keyboard.insertText(t);
        await expectBytes('sticky Ctrl + typed letter c', seq(tapKey('ctrl'), typed('c')), '03');
        let st = await h.uiState(page);
        r.add(
            g,
            'sticky Ctrl clears after use, field stays empty',
            st.value === '' && !(await page.$('[data-key=ctrl].m-on')),
            JSON.stringify(st.value)
        );
        await expectBytes('sticky Ctrl + typed letter then more text stays', seq(tapKey('ctrl'), typed('rest')), '12');
        st = await h.uiState(page);
        r.add(g, 'rest of typed word stays in the field', st.value === 'est', JSON.stringify(st.value));
        await page.evaluate(() => {
            const el = document.querySelector('.m-input');
            el.value = '';
            el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContent' }));
        });
        await expectBytes('sticky Ctrl + Up', seq(tapKey('ctrl'), tapKey('up')), '1b5b313b3541');
        await expectBytes('sticky Alt + Left', seq(tapKey('alt'), tapKey('left')), '1b5b313b3344');
        await expectBytes(
            'sticky Ctrl + Alt + PgUp',
            seq(tapKey('ctrl'), tapKey('alt'), tapKey('pgup')),
            '1b5b353b377e'
        );
        await expectBytes('sticky Alt + typed x', seq(tapKey('alt'), typed('x')), '1b78');
        await expectBytes('sticky Ctrl + symbol key -', seq(tapKey('ctrl'), tapKey('-')), '1f');
        await expectBytes(
            'sticky Ctrl applied to first letter at Send',
            seq(typed('xy'), tapKey('ctrl'), tapKey('send')),
            '18790d'
        );
        st = await h.uiState(page);
        r.add(g, 'compose keeps focus after key bar taps', st.active === 'm-input', st.active);

        const tall = await page.$$eval('.m-key', els => Math.min(...els.map(e => e.getBoundingClientRect().height)));
        r.add(g, 'keys are at least 40px tall', tall >= 40, `${tall}px`);
        const scroller = await page.$eval('.m-keys-scroll', el => ({ s: el.scrollWidth, c: el.clientWidth }));
        r.add(g, 'key bar scrolls sideways', scroller.s > scroller.c, JSON.stringify(scroller));

        // Paste: clipboard text arrives once; no bracket wrap here as hexd did not ask for it
        await page.evaluate(() => navigator.clipboard.writeText('collé é\nligne2'));
        await expectBytes('Paste key sends clipboard', tapKey('paste'), Buffer.from('collé é\rligne2').toString('hex'));
        st = await h.uiState(page);
        r.add(g, 'Paste leaves focus in compose', st.active === 'm-input', st.active);
        r.add(g, 'no console errors', log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
        await context.close();

        // Application cursor mode and bracketed paste, asked for by the program
        const file2 = path.join(ctx.tmp, 'hex2.log');
        const port2 = ctx.port + 100;
        lib.startTtyd({
            port: port2,
            page: ctx.page,
            cmd: [PY, path.join(__dirname, 'hexd.py'), file2, '\\x1b[?1h\\x1b[?2004h'],
        });
        await lib.waitPort(port2);
        const context2 = await lib.mobileContext(ctx.browser);
        await context2.grantPermissions(['clipboard-read', 'clipboard-write']);
        const { page: page2 } = await h.bootPage(context2, `http://127.0.0.1:${port2}/`);
        await h.untilOpen(page2);
        await lib.waitScreen(page2, /ready/);
        await page2.tap('[data-key=up]');
        await page2.evaluate(() => navigator.clipboard.writeText('p'));
        await page2.tap('[data-key=paste]');
        await sleep(300);
        const got2 = fs.readFileSync(file2, 'utf8').replace(/\s+/g, '');
        r.add(
            g,
            'application cursor Up and bracketed paste',
            got2 === '1b4f41' + '1b5b3230307e' + '70' + '1b5b3230317e',
            got2
        );
        await context2.close();
    },

    async paste(ctx) {
        const { results: r, group: g } = ctx;
        const { context, page, log } = await shell(ctx);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const file = path.join(ctx.tmp, 'paste.txt');
        await capture(file);
        const big = Array.from({ length: 70 }, (_, i) => `ligne ${i} é😀 ${'x'.repeat(30)}`).join('\n') + '\n';
        await page.evaluate(t => navigator.clipboard.writeText(t), big);
        await page.tap('[data-key=paste]');
        const got = await h.waitFile(file, big, 8000);
        r.add(g, 'multi-line clipboard paste intact', got === big, `${big.length} chars, got ${got.length}`);
        endCapture();
        await sleep(200);

        // Paste denied: focus goes to compose so the owner can long-press there
        await context.clearPermissions();
        await page.evaluate(() => {
            navigator.clipboard.readText = () => Promise.reject(new Error('denied'));
        });
        await page.evaluate(() => document.querySelector('.m-input').blur());
        await page.tap('[data-key=paste]');
        await sleep(100);
        const st = await h.uiState(page);
        r.add(
            g,
            'Paste failure focuses compose and says so',
            st.active === 'm-input' && !!(await page.$('[data-line=notice]')),
            st.active
        );

        // A real paste into the field keeps newlines until Send
        const file2 = path.join(ctx.tmp, 'paste2.txt');
        await capture(file2);
        await page.evaluate(() => {
            const el = document.querySelector('.m-input');
            el.focus();
            el.setRangeText('un\ndeux', 0, 0, 'end');
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
        });
        await page.tap('[data-key=send]');
        const pasted = await h.waitFile(file2, 'un\ndeux\n');
        r.add(g, 'multi-line text in the field sent intact', pasted === 'un\ndeux\n', JSON.stringify(pasted));
        endCapture();
        r.add(g, 'no console errors', log.errors.length === 0, log.errors.slice(0, 2).join(' | ').slice(0, 200));
        await context.close();
    },
};
