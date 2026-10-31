import { config, urlFlags } from './config';

const PREFIX = 'ttyd-mobile:';
const BOOT = 'boot';
const SAFE_UNTIL = 'safe-until';

export function load(key: string): string | null {
    try {
        return window.localStorage.getItem(PREFIX + key);
    } catch {
        return null;
    }
}

export function save(key: string, value: string | null) {
    try {
        if (value === null) window.localStorage.removeItem(PREFIX + key);
        else window.localStorage.setItem(PREFIX + key, value);
    } catch {
        // storage can be blocked or full, the page works without it
    }
}

let bootId = '';

// A start that never reached its first paint leaves BOOT behind; the next load then takes the safest path.
export function bootBegin(): boolean {
    const override = urlFlags.safe();
    const now = Date.now();
    let safe = now < Number(load(SAFE_UNTIL) || 0);
    if (load(BOOT)) {
        safe = true;
        save(SAFE_UNTIL, String(now + config.safeModeStickyMs));
    }
    bootId = `${now}-${Math.random()}`;
    save(BOOT, bootId);
    return override ?? safe;
}

// Only the tab that wrote the flag may clear it, or closing another tab would hide a crash.
export function bootDone() {
    if (load(BOOT) === bootId) save(BOOT, null);
}

export function leaveSafeMode() {
    save(BOOT, null);
    save(SAFE_UNTIL, null);
}
