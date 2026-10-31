export const config = {
    tmuxPrefix: '\x02',
    tmuxCopyModeKey: '[',
    tmuxDetectWindowMs: 3000,
    minCols: 50,
    minFontSize: 12,
    fontRange: [8, 28] as const,
    fontFamily: 'ui-monospace,Menlo,"Roboto Mono","Droid Sans Mono",monospace',
    scrollback: 2000,
    safeScrollback: 500,
    copyScrollbackLines: 1000,
    fitDebounceMs: 180,
    minFitWidth: 120,
    minFitHeight: 60,
    enterDelayMs: 60,
    enterDelayLongMs: 250,
    longTextLength: 500,
    backoffMs: [300, 800, 2000, 4000, 8000, 15000],
    connectTimeoutMs: 8000,
    tokenTimeoutMs: 3000,
    zombieAfterHiddenMs: 45000,
    safeModeStickyMs: 24 * 3600 * 1000,
    keyboardMinHeight: 120,
};

export const URL_KEYS = ['mobile', 'webgl', 'canvas', 'tmux', 'addons', 'safe'];

function flag(name: string): boolean | undefined {
    const value = new URLSearchParams(window.location.search).get(name);
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return undefined;
}

export const urlFlags = {
    webgl: () => flag('webgl') === true,
    canvas: () => flag('canvas') === true,
    addons: () => flag('addons') === true,
    tmux: () => flag('tmux'),
    safe: () => flag('safe'),
};

export function isMobile(): boolean {
    return flag('mobile') ?? window.matchMedia('(pointer: coarse)').matches;
}
