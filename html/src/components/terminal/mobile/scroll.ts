import type { IBufferCell, Terminal } from '@xterm/xterm';
import { config } from './config';
import { specialBytes } from './keys';

export interface CopyPosition {
    n: number;
    m: number;
}

export interface ScrollHost {
    term(): Terminal;
    isTmux(): boolean;
    send(data: string): void;
    tap(): void;
    pinch(scale: number): void;
    notice(text: string): void;
    onChange(copy: CopyPosition | null, history: boolean): void;
}

const NO_MODS = { ctrl: false, alt: false };
const C_UP = '\x1b[1;5A';
const C_DOWN = '\x1b[1;5B';
const PG_UP = '\x1b[5~';
const PG_DOWN = '\x1b[6~';
const FLUSH_MS = 33;
const FAST_LINES_PER_MS = 0.12;
const FRICTION_MS = 325;
const MIN_FLING = 0.004;
const ENTER_TIMEOUT_MS = 1200;
const EXIT_TIMEOUT_MS = 800;
const BORDER = /^[─q┬┼├┤┌┐]$/;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Finds tmux's copy mode position, drawn styled at the top right of a pane. It is the only source of
// truth for "are we in copy mode": it survives reconnects and reflects keys sent from anywhere.
export function readCopyPosition(term: Terminal): CopyPosition | null {
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    const reusable: IBufferCell = cell;
    for (let row = 0; row < term.rows - 1; row++) {
        const line = buffer.getLine(buffer.viewportY + row);
        if (!line) continue;
        const above = row > 1 ? buffer.getLine(buffer.viewportY + row - 1) : undefined;
        for (let col = term.cols - 3; col >= 0; col--) {
            line.getCell(col, reusable);
            if (reusable.getChars() !== '[' || (reusable.isBgDefault() && !reusable.isInverse())) continue;
            if (row > 1 && !BORDER.test(above?.getCell(col)?.getChars() || '')) continue;
            let text = '';
            let end = col;
            for (; end < term.cols && !text.endsWith(']'); end++) {
                line.getCell(end, reusable);
                text += reusable.getChars();
            }
            const match = /^\[(\d+)\/(\d+)\]$/.exec(text);
            if (!match) continue;
            const after = end < term.cols ? line.getCell(end)?.getChars() || ' ' : '';
            if (after !== '' && !/^[│x ]$/.test(after)) continue;
            return { n: Number(match[1]), m: Number(match[2]) };
        }
    }
    return null;
}

export class ScrollEngine {
    copy: CopyPosition | null = null;
    private history = false;

    private entering = false;
    private enterTimer?: number;
    private blocked = false;
    private pendingLines = 0;

    private lastY = 0;
    private lastT = 0;
    private carry = 0;
    private velocity = 0;
    private moved = false;
    private forward = false;
    private touching = false;
    private fling?: number;

    private pinchStart = 0;
    private pinchScale = 0;

    private outLines = 0;
    private outToCopy = false;
    private outTimer?: number;
    private checkTimer?: number;

    constructor(private host: ScrollHost) {}

    attach(el: HTMLElement) {
        const opts = { capture: true, passive: false };
        el.addEventListener('touchstart', this.onTouchStart, opts);
        el.addEventListener('touchmove', this.onTouchMove, opts);
        el.addEventListener('touchend', this.onTouchEnd, opts);
        el.addEventListener('touchcancel', this.onTouchEnd, opts);
        el.addEventListener('contextmenu', e => e.preventDefault(), opts);
    }

    scheduleCheck() {
        if (this.checkTimer !== undefined) return;
        this.checkTimer = window.setTimeout(() => {
            this.checkTimer = undefined;
            this.check();
        }, 50);
    }

    check() {
        const term = this.host.term();
        const copy = this.host.isTmux() ? readCopyPosition(term) : null;
        const buffer = term.buffer.active;
        const history = !copy && !this.host.isTmux() && buffer.viewportY < buffer.baseY;
        const changed = !!copy !== !!this.copy || copy?.n !== this.copy?.n || copy?.m !== this.copy?.m;
        this.copy = copy;
        if (copy && this.entering) {
            this.entering = false;
            window.clearTimeout(this.enterTimer);
            const pending = this.pendingLines;
            this.pendingLines = 0;
            if (pending) this.queueLines(pending);
        }
        if (changed || history !== this.history) {
            this.history = history;
            this.host.onChange(copy, history);
        }
    }

    // Leaves copy mode if it is on. Resolves false if tmux is still in copy mode afterwards.
    async leave(): Promise<boolean> {
        this.stopFling();
        this.flushOut();
        this.check();
        if (!this.copy) return true;
        for (let attempt = 0; attempt < 2; attempt++) {
            this.host.send('q');
            const start = Date.now();
            while (Date.now() - start < EXIT_TIMEOUT_MS) {
                await sleep(40);
                this.check();
                if (!this.copy) return true;
            }
        }
        return false;
    }

    exitHistory() {
        this.stopFling();
        this.carry = 0;
        this.host.term().scrollToBottom();
        this.check();
    }

    private onTouchStart = (e: TouchEvent) => {
        e.stopPropagation();
        this.stopFling();
        this.touching = true;
        if (e.touches.length >= 2) {
            this.pinchStart = this.touchDistance(e);
            this.pinchScale = 1;
            this.moved = true;
            return;
        }
        this.pinchStart = 0;
        this.lastY = e.touches[0].clientY;
        this.lastT = e.timeStamp;
        this.carry = 0;
        this.velocity = 0;
        this.moved = false;
        this.forward = false;
        this.blocked = false;
    };

    private onTouchMove = (e: TouchEvent) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (this.pinchStart && e.touches.length >= 2) {
            this.pinchScale = this.touchDistance(e) / this.pinchStart;
            return;
        }
        if (this.pinchStart) return;
        const y = e.touches[0].clientY;
        const dt = Math.max(e.timeStamp - this.lastT, 1);
        const lines = (y - this.lastY) / this.lineHeight();
        if (!this.moved && Math.abs(lines) < 0.4) return;
        this.moved = true;
        this.velocity = 0.6 * (lines / dt) + 0.4 * this.velocity;
        this.lastY = y;
        this.lastT = e.timeStamp;
        this.advance(lines);
    };

    private onTouchEnd = (e: TouchEvent) => {
        e.stopPropagation();
        if (e.touches.length > 0) return;
        this.touching = false;
        if (this.pinchStart) {
            const scale = this.pinchScale;
            this.pinchStart = 0;
            if (Math.abs(scale - 1) > 0.05) this.host.pinch(scale);
            return;
        }
        if (!this.moved) {
            this.host.tap();
            return;
        }
        if (e.type === 'touchend' && e.timeStamp - this.lastT < 80 && Math.abs(this.velocity) > MIN_FLING * 3) {
            this.startFling();
        } else {
            this.gestureEnded();
        }
    };

    private touchDistance(e: TouchEvent): number {
        const [a, b] = [e.touches[0], e.touches[1]];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    }

    private lineHeight(): number {
        const term = this.host.term();
        return (term.element?.clientHeight || 16 * term.rows) / term.rows;
    }

    private startFling() {
        let last = performance.now();
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            this.velocity *= Math.exp(-dt / FRICTION_MS);
            if (Math.abs(this.velocity) < MIN_FLING) {
                this.fling = undefined;
                this.gestureEnded();
                return;
            }
            this.advance(this.velocity * dt);
            this.fling = window.requestAnimationFrame(step);
        };
        this.fling = window.requestAnimationFrame(step);
    }

    private stopFling() {
        if (this.fling !== undefined) window.cancelAnimationFrame(this.fling);
        this.fling = undefined;
    }

    private gestureEnded() {
        this.flushOut();
        if (this.touching) return;
        window.setTimeout(() => {
            this.check();
            if (this.forward && this.copy?.n === 0 && !this.touching) this.leave();
        }, 120);
    }

    // Positive lines reveal older content, as when a finger drags the page down.
    private advance(lines: number) {
        this.carry += lines;
        const whole = Math.trunc(this.carry);
        if (!whole) return;
        this.carry -= whole;
        if (whole < 0) this.forward = true;
        this.scroll(whole);
    }

    private scroll(lines: number) {
        const term = this.host.term();
        const buffer = term.buffer.active;
        if (this.copy || this.entering) {
            this.scrollCopyMode(lines);
        } else if (term.modes.mouseTrackingMode !== 'none') {
            this.queueLines(lines);
        } else if (this.host.isTmux()) {
            this.scrollCopyMode(lines);
        } else if (buffer.type === 'normal') {
            term.scrollLines(-lines);
            this.check();
        } else {
            this.queueLines(lines);
        }
    }

    private scrollCopyMode(lines: number) {
        if (this.entering) {
            this.pendingLines += lines;
        } else if (this.copy) {
            this.queueLines(lines, true);
        } else if (lines > 0 && !this.blocked) {
            this.enterCopyMode(lines);
        }
    }

    private enterCopyMode(lines: number) {
        this.entering = true;
        this.pendingLines = lines;
        this.host.send(config.tmuxPrefix + config.tmuxCopyModeKey);
        this.enterTimer = window.setTimeout(() => {
            this.entering = false;
            this.pendingLines = 0;
            this.blocked = true;
            this.stopFling();
            this.host.notice('Scroll mode did not start');
        }, ENTER_TIMEOUT_MS);
    }

    private queueLines(lines: number, toCopy = false) {
        this.outToCopy = toCopy;
        this.outLines += lines;
        if (this.outTimer === undefined) this.outTimer = window.setTimeout(() => this.flushOut(), FLUSH_MS);
    }

    private flushOut() {
        if (this.outTimer !== undefined) window.clearTimeout(this.outTimer);
        this.outTimer = undefined;
        const lines = this.outLines;
        this.outLines = 0;
        if (!lines) return;
        const term = this.host.term();
        this.check();
        if (this.outToCopy && !this.copy) return;
        const up = lines > 0;
        let count = Math.abs(lines);
        if (this.copy) {
            const page = Math.max(1, term.rows - 2);
            let data = '';
            if (Math.abs(this.velocity) > FAST_LINES_PER_MS && count < page && (this.touching || this.fling)) {
                this.outLines = lines;
                if (count > page / 2) {
                    data = up ? PG_UP : PG_DOWN;
                    this.outLines = 0;
                }
            } else {
                data = (up ? PG_UP : PG_DOWN).repeat(Math.floor(count / page));
                data += (up ? C_UP : C_DOWN).repeat(count % page);
            }
            if (data) this.host.send(data);
            if (this.outLines && (this.touching || this.fling)) {
                this.outTimer = window.setTimeout(() => this.flushOut(), FLUSH_MS);
            }
            return;
        }
        if (term.modes.mouseTrackingMode !== 'none') {
            const events = Math.max(1, Math.round(count / 3));
            const el = term.element;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            for (let i = 0; i < events; i++) {
                el.dispatchEvent(
                    new WheelEvent('wheel', {
                        deltaY: up ? -3 : 3,
                        deltaMode: WheelEvent.DOM_DELTA_LINE,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2,
                        bubbles: true,
                        cancelable: true,
                    })
                );
            }
            return;
        }
        const appCursor = term.modes.applicationCursorKeysMode;
        count = Math.min(count, term.rows);
        this.host.send(specialBytes(up ? 'up' : 'down', NO_MODS, appCursor).repeat(count));
    }
}
