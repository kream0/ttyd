import type { ITheme, Terminal } from '@xterm/xterm';
import { h, render } from 'preact';
import type { MobileHooks, Preferences, RendererType, Xterm, XtermOptions } from '../xterm';
import { config, urlFlags } from './config';
import { Connection, ConnectionState } from './connection';
import { charBytes, Mods, specialBytes, SpecialKey } from './keys';
import { CopyPosition, ScrollEngine } from './scroll';
import { bootBegin, bootDone, leaveSafeMode, load, save } from './storage';
import { MobileUi } from './ui';

import './mobile.scss';

export interface UiState {
    connection: ConnectionState;
    fails: number;
    ctrl: boolean;
    alt: boolean;
    copy: CopyPosition | null;
    history: boolean;
    notice: string;
    overlay: string | null;
    safeMode: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NAV_KEYS: SpecialKey[] = ['up', 'down', 'left', 'right', 'home', 'end', 'pgup', 'pgdn'];
const FONT_KEY = 'font-size';

export class MobileController implements MobileHooks {
    safeMode = false;
    ui: UiState = {
        connection: 'paused',
        fails: 0,
        ctrl: false,
        alt: false,
        copy: null,
        history: false,
        notice: '',
        overlay: null,
        safeMode: false,
    };
    readonly draftKey = `draft:${window.location.pathname}`;

    private xterm: Xterm;
    private container: HTMLElement;
    private term: Terminal;
    private conn: Connection;
    private scroll: ScrollEngine;
    private listener?: () => void;
    private composeEl?: HTMLTextAreaElement;
    private composeHeight = 0;

    private tmuxOverride = urlFlags.tmux();
    private tmuxSeen = false;
    private tmuxTitle = false;
    private detectUntil = 0;
    private sawMouse1000 = false;
    private sawMouse1005 = false;

    private renderer?: RendererType;
    private rendererLost = false;
    private userFont = Number(load(FONT_KEY)) || 0;
    private fontSize = 13;
    private serverFontFamily = false;
    private fitTimer?: number;
    private noticeTimer?: number;
    private lastViewport = '';
    private baseHeight = { portrait: 0, landscape: 0 };
    private firstPaint = false;

    private guards: Array<() => void> = [];
    private ignorePop = 0;
    private copyGuard?: () => void;
    private overlayGuard?: () => void;

    constructor(private options: XtermOptions) {
        document.documentElement.classList.add('ttyd-mobile');
        this.safeMode = urlFlags.safe() === true;
        this.fontSize = this.pickFont(14);
        options.termOptions.fontSize = this.fontSize;
        options.termOptions.fontFamily = config.fontFamily;
        options.termOptions.scrollback = this.scrollbackLimit();
        this.setViewportMeta();
    }

    // MobileHooks

    filterPrefs(prefs: Preferences): Preferences {
        const out = { ...prefs } as Preferences;
        this.renderer = this.chooseRenderer(out.rendererType);
        delete (out as Partial<Preferences>).rendererType;
        if (!urlFlags.addons()) {
            out.enableZmodem = false;
            out.enableTrzsz = false;
            out.enableSixel = false;
        }
        if (out.scrollback !== undefined) out.scrollback = Math.min(out.scrollback, this.scrollbackLimit());
        if (typeof out.fontSize === 'number') {
            this.fontSize = this.pickFont(out.fontSize);
            out.fontSize = this.fontSize;
        }
        this.serverFontFamily = this.serverFontFamily || out.fontFamily !== undefined;
        if (out.theme) this.applyTheme({ ...this.term.options.theme, ...out.theme });
        window.setTimeout(() => this.applyRenderer());
        return out;
    }

    canFit(): boolean {
        const { clientWidth, clientHeight } = this.container;
        return !document.hidden && clientWidth >= config.minFitWidth && clientHeight >= config.minFitHeight;
    }

    onServerTitle(title: string) {
        if (/\btmux\b/.test(title)) this.tmuxTitle = true;
    }

    onOpened() {
        this.detectUntil = Date.now() + config.tmuxDetectWindowMs;
        this.sawMouse1000 = false;
        this.sawMouse1005 = false;
        this.conn.onOpened();
        this.scheduleFit();
    }

    onDisconnected(code: number, canRetry: boolean) {
        this.conn.onDisconnected(code, canRetry);
    }

    onContextLoss() {
        this.rendererLost = true;
        this.applyRenderer();
    }

    // Startup

    async start(xterm: Xterm, container: HTMLElement) {
        this.xterm = xterm;
        this.container = container;
        this.syncViewport();
        await this.whenPaintable();
        this.safeMode = bootBegin();
        this.ui.safeMode = this.safeMode;
        if (this.safeMode) this.pickSafeOptions();
        window.addEventListener('pagehide', bootDone);

        xterm.open(container);
        this.term = window.term;
        // Scrollbars overlay on touch, but xterm reserves 15px whenever it measures zero.
        const core = (this.term as unknown as { _core?: { viewport?: { scrollBarWidth: number } } })._core;
        if (core?.viewport) core.viewport.scrollBarWidth = 0;
        this.lockTextarea();
        this.applyTheme(this.term.options.theme || {});
        this.mountUi();

        this.scroll = new ScrollEngine({
            term: () => this.term,
            isTmux: () => this.isTmux(),
            send: data => this.term.input(data, true),
            tap: () => this.composeEl?.blur(),
            pinch: scale => this.setFont(Math.round(this.fontSize * scale), true),
            notice: text => this.notice(text),
            onChange: (copy, history) => this.onScrollChange(copy, history),
        });
        this.scroll.attach(container);
        this.watchTmux();
        this.term.onWriteParsed(() => this.scroll.scheduleCheck());
        const firstRender = this.term.onRender(() => {
            firstRender.dispose();
            this.firstPaint = true;
            window.setTimeout(bootDone, 2000);
        });

        this.conn = new Connection(xterm, {
            isTmux: () => this.isTmux(),
            onState: (connection, fails) => this.setUi({ connection, fails }),
            onWake: () => this.onWake(),
        });
        this.watchViewport();
        window.addEventListener('popstate', this.onPopState);
        this.conn.start();
    }

    private whenPaintable(): Promise<void> {
        return new Promise(resolve => {
            const check = () => {
                if (!this.canFit()) return;
                window.clearInterval(timer);
                document.removeEventListener('visibilitychange', check);
                window.removeEventListener('resize', check);
                resolve();
            };
            const timer = window.setInterval(check, 250);
            document.addEventListener('visibilitychange', check);
            window.addEventListener('resize', check);
            check();
        });
    }

    private pickSafeOptions() {
        this.options.termOptions.scrollback = config.safeScrollback;
    }

    private mountUi() {
        const host = document.createElement('div');
        host.id = 'ttyd-mobile-ui';
        document.body.appendChild(host);
        render(h(MobileUi, { ctrl: this }), host);
    }

    // xterm's hidden textarea must never take focus here, it would pop the keyboard on every tap.
    private lockTextarea() {
        const textarea = this.term.textarea;
        if (!textarea) return;
        textarea.disabled = true;
        textarea.tabIndex = -1;
        textarea.setAttribute('inputmode', 'none');
    }

    // UI state

    subscribe(listener: () => void) {
        this.listener = listener;
    }

    private setUi(patch: Partial<UiState>) {
        this.ui = { ...this.ui, ...patch };
        this.listener?.();
    }

    notice(text: string, ms = 3500) {
        window.clearTimeout(this.noticeTimer);
        this.setUi({ notice: text });
        if (ms) this.noticeTimer = window.setTimeout(() => this.setUi({ notice: '' }), ms);
    }

    registerCompose(el: HTMLTextAreaElement | undefined) {
        this.composeEl = el;
    }

    // tmux detection

    isTmux(): boolean {
        return this.tmuxOverride ?? (this.tmuxSeen || this.tmuxTitle);
    }

    // On attach tmux resets every mouse mode including the legacy 1005, which nothing else touches
    // at startup, and resets the cursor colour with OSC 112.
    private watchTmux() {
        const { parser } = this.term;
        parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
            if (Date.now() < this.detectUntil) {
                for (const param of params) {
                    if (param === 1000) this.sawMouse1000 = true;
                    if (param === 1005) this.sawMouse1005 = true;
                }
                if (this.sawMouse1000 && this.sawMouse1005) this.markTmux();
            }
            return false;
        });
        parser.registerOscHandler(112, () => {
            if (Date.now() < this.detectUntil) this.markTmux();
            return false;
        });
    }

    private markTmux() {
        if (this.tmuxSeen) return;
        this.tmuxSeen = true;
        this.scroll.scheduleCheck();
    }

    // Input

    mods(): Mods {
        return { ctrl: this.ui.ctrl, alt: this.ui.alt };
    }

    private takeMods(): Mods {
        const mods = this.mods();
        if (mods.ctrl || mods.alt) this.setUi({ ctrl: false, alt: false });
        return mods;
    }

    toggleMod(name: 'ctrl' | 'alt') {
        this.setUi({ [name]: !this.ui[name] } as Partial<UiState>);
    }

    connected(): boolean {
        return this.conn?.connected() ?? false;
    }

    private refuseOffline(): boolean {
        if (this.connected()) return false;
        this.notice('Not connected. Your text is kept.');
        return true;
    }

    async key(key: SpecialKey) {
        if (this.refuseOffline()) return;
        if (!NAV_KEYS.includes(key) && !(await this.leaveScroll())) return;
        this.term.input(specialBytes(key, this.takeMods(), this.term.modes.applicationCursorKeysMode), true);
    }

    async char(ch: string) {
        if (this.refuseOffline() || !(await this.leaveScroll())) return;
        this.term.input(charBytes(ch, this.takeMods()), true);
    }

    async ctrlC() {
        if (this.refuseOffline() || !(await this.leaveScroll())) return;
        this.takeMods();
        this.term.input('\x03', true);
    }

    async sendLine(text: string): Promise<boolean> {
        if (this.refuseOffline() || !(await this.leaveScroll())) return false;
        const mods = this.takeMods();
        if (text) {
            const first = Array.from(text)[0];
            const modified = charBytes(first, mods);
            if (modified !== first) this.term.input(modified, true);
            const rest = modified !== first ? text.slice(first.length) : text;
            if (rest.includes('\n')) this.term.paste(rest);
            else if (rest) this.term.input(rest, true);
            // Claude Code treats a chunk as a paste for a moment; an Enter in the same chunk gets swallowed.
            await sleep(text.length > config.longTextLength ? config.enterDelayLongMs : config.enterDelayMs);
        }
        this.term.input('\r', true);
        return true;
    }

    async paste() {
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            this.composeEl?.focus();
            this.notice('Long-press the text field to paste');
            return;
        }
        if (!text) {
            this.notice('Clipboard is empty');
            return;
        }
        if (this.refuseOffline() || !(await this.leaveScroll())) return;
        this.term.paste(text);
    }

    private async leaveScroll(): Promise<boolean> {
        if (await this.scroll.leave()) return true;
        this.notice('Could not leave scroll mode. Your text is kept.');
        return false;
    }

    // Scroll

    exitScroll() {
        if (this.ui.copy) this.scroll.leave();
        else this.scroll.exitHistory();
    }

    private onScrollChange(copy: CopyPosition | null, history: boolean) {
        const wasIn = !!this.ui.copy;
        this.setUi({ copy, history });
        if (copy && !wasIn) {
            this.copyGuard = () => {
                this.copyGuard = undefined;
                this.scroll.leave();
            };
            this.pushGuard(this.copyGuard);
        } else if (!copy && wasIn && this.copyGuard) {
            this.dropGuard(this.copyGuard);
            this.copyGuard = undefined;
        }
    }

    // Copy overlay

    openCopy() {
        const text = this.visibleText();
        this.overlayGuard = () => {
            this.overlayGuard = undefined;
            this.setUi({ overlay: null });
        };
        this.pushGuard(this.overlayGuard);
        this.setUi({ overlay: text });
    }

    closeCopy() {
        if (this.overlayGuard) this.dropGuard(this.overlayGuard);
        this.overlayGuard = undefined;
        this.setUi({ overlay: null });
    }

    private visibleText(): string {
        const buffer = this.term.buffer.active;
        const start =
            buffer.type === 'normal' ? Math.max(0, buffer.viewportY - config.copyScrollbackLines) : buffer.viewportY;
        const end = Math.min(buffer.viewportY + this.term.rows, buffer.length);
        const statusRow = buffer.baseY + this.term.rows - 1;
        const lines: string[] = [];
        for (let i = start; i < end; i++) {
            const line = buffer.getLine(i);
            if (!line) continue;
            if (i === statusRow && this.isTmux() && line.getCell(0)?.isBgDefault() === false) continue;
            const next = buffer.getLine(i + 1);
            const text = line.translateToString(!next?.isWrapped);
            if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
            else lines.push(text);
        }
        return lines.join('\n').replace(/\s+$/, '');
    }

    // History guard: the browser back action closes what is open instead of leaving the terminal.

    private pushGuard(fn: () => void) {
        window.history.pushState({ ttydMobile: true }, '');
        this.guards.push(fn);
    }

    private dropGuard(fn: () => void) {
        this.guards = this.guards.filter(g => g !== fn);
        this.ignorePop++;
        window.history.back();
    }

    private onPopState = () => {
        if (this.ignorePop > 0) {
            this.ignorePop--;
            return;
        }
        this.guards.pop()?.();
    };

    // Font

    fontStep(delta: number) {
        this.setFont(this.fontSize + delta, true);
    }

    private setFont(size: number, persist: boolean) {
        const next = Math.max(config.fontRange[0], Math.min(config.fontRange[1], size));
        this.fontSize = next;
        if (persist) {
            this.userFont = next;
            save(FONT_KEY, String(next));
        }
        this.term.options.fontSize = next;
        this.fitNow();
        this.notice(`${next} px, ${this.term.cols} columns`, 1500);
    }

    private pickFont(server: number): number {
        if (this.userFont) return this.userFont;
        const width = Math.min(window.innerWidth, window.innerHeight) - 10;
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx || width <= 0) return server;
        let size = server;
        while (size > config.minFontSize) {
            ctx.font = `${size}px ${config.fontFamily}`;
            if (Math.floor(width / ctx.measureText('W').width) >= config.minCols) break;
            size--;
        }
        return size;
    }

    private scrollbackLimit(): number {
        return this.safeMode ? config.safeScrollback : config.scrollback;
    }

    // Renderer

    private chooseRenderer(requested: RendererType): RendererType {
        if (this.safeMode || requested === 'dom') return 'dom';
        if (urlFlags.webgl() && !this.rendererLost) return 'webgl';
        return urlFlags.canvas() ? 'canvas' : 'dom';
    }

    private applyRenderer() {
        if (!this.renderer || !this.canFit()) return;
        const type = this.rendererLost && this.renderer === 'webgl' ? 'dom' : this.renderer;
        try {
            this.xterm.setRendererType(type);
        } catch (e) {
            console.log('[ttyd] renderer failed, using the dom renderer', e);
            this.xterm.setRendererType('dom');
        }
    }

    private onWake() {
        this.syncViewport();
        this.applyRenderer();
        this.term.clearTextureAtlas();
        this.term.refresh(0, this.term.rows - 1);
        this.fitNow();
    }

    // Layout

    private setViewportMeta() {
        const meta = document.querySelector('meta[name="viewport"]');
        meta?.setAttribute(
            'content',
            'width=device-width, initial-scale=1, interactive-widget=resizes-content, viewport-fit=cover'
        );
    }

    private applyTheme(theme: ITheme) {
        const root = document.documentElement.style;
        const background = theme.background || '#1a1b26';
        root.setProperty('--m-bg', background);
        root.setProperty('--m-fg', theme.foreground || '#c0caf5');
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'theme-color');
            document.head.appendChild(meta);
        }
        meta.setAttribute('content', background);
    }

    private watchViewport() {
        const onChange = () => this.syncViewport();
        window.visualViewport?.addEventListener('resize', onChange);
        window.visualViewport?.addEventListener('scroll', onChange);
        window.addEventListener('resize', onChange);
        window.addEventListener('orientationchange', onChange);
    }

    private syncViewport() {
        const vv = window.visualViewport;
        const width = vv?.width ?? window.innerWidth;
        const height = vv?.height ?? window.innerHeight;
        const top = vv?.offsetTop ?? 0;
        const key = `${width}x${height}@${top}`;
        if (key === this.lastViewport) return;
        const sizeChanged = !this.lastViewport.startsWith(`${width}x${height}@`);
        this.lastViewport = key;
        const root = document.documentElement;
        root.style.setProperty('--m-vh', `${height}px`);
        root.style.setProperty('--m-top', `${top}px`);
        const side = width > height ? 'landscape' : 'portrait';
        this.baseHeight[side] = Math.max(this.baseHeight[side], height);
        root.classList.toggle('m-keyboard', this.baseHeight[side] - height > config.keyboardMinHeight);
        if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
        if (sizeChanged && this.term) this.scheduleFit();
    }

    private scheduleFit() {
        window.clearTimeout(this.fitTimer);
        this.fitTimer = window.setTimeout(() => this.fitNow(), config.fitDebounceMs);
    }

    // The field grows with long text, and the terminal gives up those rows instead of hiding them.
    composeResized() {
        const height = this.composeEl?.parentElement?.offsetHeight ?? 0;
        if (!height || height === this.composeHeight) return;
        this.composeHeight = height;
        document.documentElement.style.setProperty('--m-compose-now', `${height}px`);
        if (this.term) this.scheduleFit();
    }

    private fitNow() {
        window.clearTimeout(this.fitTimer);
        (this.term as unknown as { fit(): void }).fit();
        this.scroll.scheduleCheck();
    }

    tryNormalMode() {
        leaveSafeMode();
        const url = new URL(window.location.href);
        url.searchParams.delete('safe');
        window.location.replace(url.toString());
    }

    retry() {
        this.conn.retryNow();
    }

    reload() {
        window.location.reload();
    }

    get painted() {
        return this.firstPaint;
    }
}
