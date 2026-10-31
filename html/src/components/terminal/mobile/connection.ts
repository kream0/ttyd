import { config } from './config';
import type { Xterm } from '../xterm';

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'paused' | 'stopped';

export interface ConnectionHost {
    isTmux(): boolean;
    onState(state: ConnectionState, fails: number): void;
    onWake(): void;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Single owner of the socket lifecycle on touch devices. Every path goes through connect(), which
// always drops the previous socket first, so there can never be two.
export class Connection {
    state: ConnectionState = 'paused';
    private attempt = 0;
    private fails = 0;
    private timer?: number;
    private hiddenAt = 0;
    private stoppedByEnd = false;

    constructor(
        private xterm: Xterm,
        private host: ConnectionHost
    ) {}

    start() {
        document.addEventListener('visibilitychange', this.onVisibility);
        window.addEventListener('online', this.onOnline);
        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('pageshow', this.onPageShow);
        document.addEventListener('freeze', this.onFreeze);
        document.addEventListener('resume', this.onResume);
        this.connect();
    }

    connected(): boolean {
        return this.state === 'open' && this.xterm.isConnected();
    }

    retryNow() {
        this.fails = 0;
        this.connect();
    }

    onOpened() {
        this.clearTimer();
        this.fails = 0;
        this.stoppedByEnd = false;
        this.setState('open');
    }

    onDisconnected(code: number, canRetry: boolean) {
        this.clearTimer();
        if (document.hidden) {
            this.setState('paused');
        } else if (!canRetry || code === 1000) {
            this.stoppedByEnd = code === 1000;
            this.setState('stopped');
        } else {
            this.scheduleRetry();
        }
    }

    private async connect() {
        if (document.hidden) {
            this.pause();
            return;
        }
        const id = ++this.attempt;
        this.clearTimer();
        this.xterm.closeSocket();
        this.setState('connecting');
        this.timer = window.setTimeout(() => {
            if (id !== this.attempt) return;
            this.xterm.closeSocket();
            this.scheduleRetry();
        }, config.connectTimeoutMs);
        await Promise.race([this.xterm.refreshToken(), sleep(config.tokenTimeoutMs)]);
        if (id !== this.attempt || document.hidden) return;
        this.xterm.connect();
    }

    private scheduleRetry() {
        const delay = config.backoffMs[Math.min(this.fails, config.backoffMs.length - 1)];
        this.fails++;
        this.clearTimer();
        this.setState('retrying');
        this.timer = window.setTimeout(() => this.connect(), delay);
    }

    private pause() {
        this.attempt++;
        this.clearTimer();
        this.xterm.closeSocket();
        this.setState('paused');
    }

    private clearTimer() {
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.timer = undefined;
    }

    private setState(state: ConnectionState) {
        this.state = state;
        this.host.onState(state, this.fails);
    }

    private onVisibility = () => {
        if (document.hidden) {
            this.hiddenAt = Date.now();
            if (this.state !== 'open' && this.state !== 'stopped') this.pause();
            return;
        }
        const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = 0;
        this.host.onWake();
        const longGone = hiddenFor > config.zombieAfterHiddenMs;
        if (this.state === 'stopped') {
            if (this.stoppedByEnd && longGone) this.retryNow();
        } else if (this.state !== 'open' || !this.xterm.isConnected()) {
            this.retryNow();
        } else if (longGone && this.host.isTmux()) {
            // A socket that slept through a network change reads as open but is dead, and its close
            // event can take a minute. Re-attaching to tmux costs one redraw.
            this.retryNow();
        }
    };

    private onOnline = () => {
        if (this.state === 'retrying') this.retryNow();
    };

    private onPageHide = () => this.pause();

    private onPageShow = (e: PageTransitionEvent) => {
        if (!e.persisted) return;
        this.host.onWake();
        this.retryNow();
    };

    private onFreeze = () => this.pause();

    private onResume = () => {
        if (document.hidden) return;
        this.host.onWake();
        if (!this.connected()) this.retryNow();
    };
}
