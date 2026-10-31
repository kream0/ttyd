export interface Mods {
    ctrl: boolean;
    alt: boolean;
}

export type SpecialKey =
    | 'up'
    | 'down'
    | 'right'
    | 'left'
    | 'home'
    | 'end'
    | 'pgup'
    | 'pgdn'
    | 'del'
    | 'esc'
    | 'tab'
    | 'bksp'
    | 'enter';

const ESC = '\x1b';
const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE = { pgup: 5, pgdn: 6, del: 3 };
const CTRL_SYMBOLS = {
    ' ': 0,
    '@': 0,
    '[': 27,
    '\\': 28,
    ']': 29,
    '^': 30,
    _: 31,
    '?': 127,
    '-': 31,
    '/': 31,
    '~': 30,
    '|': 28,
};

export function specialBytes(key: SpecialKey, mods: Mods, appCursor: boolean): string {
    const mod = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
    if (key in CURSOR) {
        if (mod > 1) return `${ESC}[1;${mod}${CURSOR[key]}`;
        return `${ESC}${appCursor ? 'O' : '['}${CURSOR[key]}`;
    }
    if (key in TILDE) return mod > 1 ? `${ESC}[${TILDE[key]};${mod}~` : `${ESC}[${TILDE[key]}~`;
    const prefix = mods.alt ? ESC : '';
    switch (key) {
        case 'esc':
            return prefix + ESC;
        case 'tab':
            return prefix + '\t';
        case 'enter':
            return prefix + '\r';
        case 'bksp':
            return prefix + (mods.ctrl ? '\x08' : '\x7f');
        default:
            return '';
    }
}

export function charBytes(ch: string, mods: Mods): string {
    let out = ch;
    if (mods.ctrl) {
        if (/^[a-zA-Z]$/.test(ch)) out = String.fromCharCode(ch.charCodeAt(0) & 0x1f);
        else if (ch in CTRL_SYMBOLS) out = String.fromCharCode(CTRL_SYMBOLS[ch]);
    }
    return (mods.alt ? ESC : '') + out;
}
