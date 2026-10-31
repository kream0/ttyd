import { bind } from 'decko';
import { Component, ComponentChildren, Fragment, h } from 'preact';
import type { MobileController, UiState } from './controller';
import type { SpecialKey } from './keys';
import { load, save } from './storage';

const hold = (e: Event) => e.preventDefault();

interface KeyProps {
    label: ComponentChildren;
    name?: string;
    title?: string;
    active?: boolean;
    wide?: boolean;
    onPress: () => void;
}

function Key({ label, name, title, active, wide, onPress }: KeyProps) {
    return (
        <button
            type="button"
            tabIndex={-1}
            class={`m-key${active ? ' m-on' : ''}${wide ? ' m-wide' : ''}`}
            data-key={name}
            aria-label={title}
            aria-pressed={active}
            onPointerDown={hold}
            onMouseDown={hold}
            onClick={onPress}
        >
            {label}
        </button>
    );
}

function Arrow({ dir }: { dir: 'up' | 'down' | 'left' | 'right' }) {
    const rotate = { up: 0, right: 90, down: 180, left: 270 }[dir];
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
                d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                transform={`rotate(${rotate} 8 8)`}
            />
        </svg>
    );
}

function KeyBar({ ctrl, ui }: { ctrl: MobileController; ui: UiState }) {
    const special = (name: SpecialKey, label: string) => (
        <Key name={name} label={label} onPress={() => ctrl.key(name)} />
    );
    const arrow = (dir: 'up' | 'down' | 'left' | 'right') => (
        <Key name={dir} title={dir} label={<Arrow dir={dir} />} onPress={() => ctrl.key(dir)} />
    );
    const symbol = (ch: string) => <Key name={ch} label={ch} onPress={() => ctrl.char(ch)} />;
    return (
        <div class="m-keys">
            <div class="m-keys-scroll">
                {special('esc', 'Esc')}
                {special('tab', 'Tab')}
                <Key name="ctrl" label="Ctrl" active={ui.ctrl} onPress={() => ctrl.toggleMod('ctrl')} />
                <Key name="alt" label="Alt" active={ui.alt} onPress={() => ctrl.toggleMod('alt')} />
                <Key name="ctrl-c" label="Ctrl+C" wide onPress={() => ctrl.ctrlC()} />
                {arrow('left')}
                {arrow('up')}
                {arrow('down')}
                {arrow('right')}
                {symbol('|')}
                {symbol('~')}
                {symbol('-')}
                {symbol('/')}
                {special('home', 'Home')}
                {special('end', 'End')}
                {special('pgup', 'PgUp')}
                {special('pgdn', 'PgDn')}
                {special('bksp', 'Bksp')}
                <Key name="paste" label="Paste" onPress={() => ctrl.paste()} />
                <Key name="font-down" label="A-" title="Smaller text" onPress={() => ctrl.fontStep(-1)} />
                <Key name="font-up" label="A+" title="Larger text" onPress={() => ctrl.fontStep(1)} />
            </div>
            <Key name="copy" label="Copy" onPress={() => ctrl.openCopy()} />
        </div>
    );
}

const PASS_THROUGH: Record<string, SpecialKey> = {
    Backspace: 'bksp',
    Delete: 'del',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Home: 'home',
    End: 'end',
    PageUp: 'pgup',
    PageDown: 'pgdn',
    Escape: 'esc',
    Tab: 'tab',
};

interface ComposeProps {
    ctrl: MobileController;
    connection: string;
}

interface ComposeState {
    empty: boolean;
}

class Compose extends Component<ComposeProps, ComposeState> {
    private el?: HTMLTextAreaElement;
    private composing = false;
    private lastSubmit = 0;
    private softKeyDown = false;
    private softKeyInput = false;
    private shiftEnter = false;
    private draftTimer?: number;
    state = { empty: true };

    componentDidMount() {
        const { ctrl } = this.props;
        ctrl.registerCompose(this.el);
        const draft = load(ctrl.draftKey);
        if (draft && this.el) {
            this.el.value = draft;
            this.changed();
        }
    }

    componentWillUnmount() {
        this.props.ctrl.registerCompose(undefined);
    }

    @bind
    private onKeyDown(e: KeyboardEvent) {
        const el = this.el as HTMLTextAreaElement;
        this.shiftEnter = false;
        if (e.isComposing) return;
        if (e.keyCode === 229) {
            this.softKeyDown = el.value === '';
            this.softKeyInput = false;
            return;
        }
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                this.shiftEnter = true;
                return;
            }
            e.preventDefault();
            this.submit();
            return;
        }
        if (el.value !== '') return;
        const key = PASS_THROUGH[e.key];
        if (key) {
            e.preventDefault();
            this.props.ctrl.key(key);
        } else if (e.ctrlKey && e.key.length === 1) {
            e.preventDefault();
            const { ctrl } = this.props;
            if (!ctrl.mods().ctrl) ctrl.toggleMod('ctrl');
            ctrl.char(e.key);
        }
    }

    // Gboard reports most keys as 229 and an empty field has nothing to delete, so a soft key press
    // that changed nothing can only be Backspace.
    @bind
    private onKeyUp(e: KeyboardEvent) {
        if (e.keyCode !== 229 && e.key !== 'Unidentified') return;
        if (!this.softKeyDown) return;
        this.softKeyDown = false;
        window.setTimeout(() => {
            if (!this.softKeyInput && !this.composing && this.el?.value === '') this.props.ctrl.key('bksp');
        }, 30);
    }

    @bind
    private onBeforeInput(e: InputEvent) {
        this.softKeyInput = true;
        const type = e.inputType;
        if ((type === 'insertLineBreak' || type === 'insertParagraph') && !this.shiftEnter) {
            e.preventDefault();
            this.submit();
        } else if (type === 'deleteContentBackward' && this.el?.value === '') {
            e.preventDefault();
            this.props.ctrl.key('bksp');
        }
    }

    @bind
    private onInput(e: Event) {
        const el = this.el as HTMLTextAreaElement;
        const event = e as InputEvent;
        this.softKeyInput = true;
        const pasted = event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop';
        if (!pasted && !this.shiftEnter && el.value.endsWith('\n') && !event.isComposing) {
            el.value = el.value.replace(/\n$/, '');
            this.changed();
            this.submit();
            return;
        }
        const { ctrl } = this.props;
        const mods = ctrl.mods();
        if ((mods.ctrl || mods.alt) && el.value !== '' && this.state.empty) {
            const first = Array.from(el.value)[0];
            el.value = el.value.slice(first.length);
            this.resetIme();
            this.changed();
            ctrl.char(first);
            return;
        }
        this.changed();
    }

    @bind
    private onCompositionStart() {
        this.composing = true;
    }

    @bind
    private onCompositionEnd() {
        this.composing = false;
    }

    // Blurring commits the word still being composed and restarts the keyboard's view of the field,
    // otherwise clearing the field leaves the old word in the IME and it comes back on the next letter.
    private resetIme() {
        const { el } = this;
        if (!el) return;
        el.blur();
        el.focus();
        this.composing = false;
    }

    @bind
    private submit() {
        const now = Date.now();
        if (now - this.lastSubmit < 150) return;
        this.lastSubmit = now;
        const el = this.el as HTMLTextAreaElement;
        const hadFocus = document.activeElement === el;
        if (this.composing) this.resetIme();
        const text = el.value;
        el.value = '';
        this.changed();
        if (hadFocus && text) this.resetIme();
        this.props.ctrl.sendLine(text).then(sent => {
            if (!sent && text && el.value === '') {
                el.value = text;
                this.changed();
            }
        });
    }

    private changed() {
        const el = this.el as HTMLTextAreaElement;
        const empty = el.value === '';
        if (empty !== this.state.empty) this.setState({ empty });
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
        const { ctrl } = this.props;
        ctrl.composeResized();
        window.clearTimeout(this.draftTimer);
        this.draftTimer = window.setTimeout(() => save(ctrl.draftKey, el.value || null), 250);
    }

    render({ connection, ctrl }: ComposeProps, { empty }: ComposeState) {
        const canRetry = connection !== 'open' && connection !== 'connecting';
        return (
            <div class="m-compose">
                <button
                    type="button"
                    tabIndex={-1}
                    class={`m-dot m-dot-${connection}`}
                    data-state={connection}
                    aria-label={`Connection: ${connection}`}
                    onPointerDown={hold}
                    onMouseDown={hold}
                    onClick={() => canRetry && ctrl.retry()}
                />
                <textarea
                    ref={c => (this.el = c as HTMLTextAreaElement)}
                    class="m-input"
                    rows={1}
                    placeholder="Type here"
                    autocapitalize="off"
                    autocomplete="on"
                    autocorrect="on"
                    spellcheck={true}
                    enterkeyhint="send"
                    aria-label="Text to send to the terminal"
                    onKeyDown={this.onKeyDown}
                    onKeyUp={this.onKeyUp}
                    onBeforeInput={this.onBeforeInput}
                    onInput={this.onInput}
                    onCompositionStart={this.onCompositionStart}
                    onCompositionEnd={this.onCompositionEnd}
                />
                <button
                    type="button"
                    tabIndex={-1}
                    class="m-send"
                    data-key="send"
                    onPointerDown={hold}
                    onMouseDown={hold}
                    onClick={this.submit}
                >
                    {empty ? 'Enter' : 'Send'}
                </button>
            </div>
        );
    }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

function linkify(text: string): ComponentChildren[] {
    const out: ComponentChildren[] = [];
    let last = 0;
    const re = new RegExp(URL_RE);
    for (let match = re.exec(text); match; match = re.exec(text)) {
        const url = match[0].replace(/[.,;:!?)\]}]+$/, '');
        const start = match.index;
        if (start > last) out.push(text.slice(last, start));
        out.push(
            <a href={url} target="_blank" rel="noopener noreferrer">
                {url}
            </a>
        );
        last = start + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

interface OverlayState {
    message: string;
}

class CopyOverlay extends Component<{ ctrl: MobileController; text: string }, OverlayState> {
    private pre?: HTMLElement;
    state = { message: '' };

    componentDidMount() {
        if (this.pre) this.pre.scrollTop = this.pre.scrollHeight;
    }

    @bind
    private async copyAll() {
        const { text } = this.props;
        let done = false;
        try {
            await navigator.clipboard.writeText(text);
            done = true;
        } catch {
            const selection = window.getSelection();
            if (this.pre && selection) {
                selection.selectAllChildren(this.pre);
                try {
                    done = document.execCommand('copy');
                } catch {
                    done = false;
                }
            }
        }
        this.setState({ message: done ? 'Copied' : 'Text selected. Use the menu to copy it.' });
    }

    render({ ctrl, text }: { ctrl: MobileController; text: string }, { message }: OverlayState) {
        return (
            <div class="m-overlay" role="dialog" aria-label="Terminal text">
                <div class="m-overlay-bar">
                    <button type="button" class="m-key m-wide" data-key="copy-all" onClick={this.copyAll}>
                        Copy all
                    </button>
                    <span class="m-overlay-msg" aria-live="polite">
                        {message}
                    </span>
                    <button type="button" class="m-key m-wide" data-key="copy-close" onClick={() => ctrl.closeCopy()}>
                        Close
                    </button>
                </div>
                <pre ref={c => (this.pre = c as HTMLElement)} class="m-overlay-text">
                    {linkify(text)}
                </pre>
            </div>
        );
    }
}

export class MobileUi extends Component<{ ctrl: MobileController }> {
    componentDidMount() {
        this.props.ctrl.subscribe(() => this.forceUpdate());
    }

    render({ ctrl }: { ctrl: MobileController }) {
        const { ui } = ctrl;
        const lost = ui.connection === 'stopped' || ui.fails >= 3;
        return (
            <Fragment>
                {(ui.copy || ui.history) && (
                    <div class="m-chip" data-scroll={ui.copy ? 'tmux' : 'history'}>
                        <span class="m-chip-label">{ui.copy ? `Scroll ${ui.copy.n}/${ui.copy.m}` : 'History'}</span>
                        <button
                            type="button"
                            class="m-chip-exit"
                            data-key="scroll-exit"
                            tabIndex={-1}
                            onPointerDown={hold}
                            onMouseDown={hold}
                            onClick={() => ctrl.exitScroll()}
                        >
                            Exit
                        </button>
                    </div>
                )}
                <div class="m-bars">
                    {ui.safeMode && (
                        <div class="m-line" data-line="safe">
                            Safe mode after a failed start.
                            <button type="button" tabIndex={-1} onClick={() => ctrl.tryNormalMode()}>
                                Try normal
                            </button>
                        </div>
                    )}
                    {lost && (
                        <div class="m-line" data-line="lost">
                            {ui.connection === 'stopped' ? 'Session ended.' : 'Cannot reach the server.'}
                            <button type="button" tabIndex={-1} onClick={() => ctrl.retry()}>
                                Reconnect
                            </button>
                            <button type="button" tabIndex={-1} onClick={() => ctrl.reload()}>
                                Reload
                            </button>
                        </div>
                    )}
                    {ui.notice && (
                        <div class="m-line" data-line="notice" aria-live="polite">
                            {ui.notice}
                        </div>
                    )}
                    <KeyBar ctrl={ctrl} ui={ui} />
                    <Compose ctrl={ctrl} connection={ui.connection} />
                </div>
                {ui.overlay !== null && <CopyOverlay ctrl={ctrl} text={ui.overlay} />}
            </Fragment>
        );
    }
}
