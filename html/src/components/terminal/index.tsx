import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';
import { isMobile } from './mobile/config';
import { MobileController } from './mobile/controller';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;
    private mobile?: MobileController;

    constructor(props: Props) {
        super();
        this.mobile = isMobile() ? new MobileController(props) : undefined;
        this.xterm = new Xterm(this.mobile ? { ...props, mobile: this.mobile } : props, this.showModal);
    }

    async componentDidMount() {
        if (this.mobile) {
            await this.mobile.start(this.xterm, this.container);
            return;
        }
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
    }

    componentWillUnmount() {
        this.xterm.dispose();
    }

    render({ id }: Props, { modal }: State) {
        return (
            <div id={id} ref={c => (this.container = c as HTMLElement)}>
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
            </div>
        );
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
