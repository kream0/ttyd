// Small reverse proxy: serves a backend under /m/ with the prefix stripped, websocket included.
const http = require('http');
const net = require('net');

function startProxy(listen, target, prefix = '/m') {
    const strip = url => (url.startsWith(prefix) ? url.slice(prefix.length) || '/' : null);
    const server = http.createServer((req, res) => {
        const url = strip(req.url);
        if (url === null) {
            res.writeHead(404);
            res.end();
            return;
        }
        const up = http.request(
            { port: target, host: '127.0.0.1', path: url, method: req.method, headers: req.headers },
            r => {
                res.writeHead(r.statusCode, r.headers);
                r.pipe(res);
            }
        );
        up.on('error', () => res.destroy());
        req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
        const url = strip(req.url);
        if (url === null) {
            socket.destroy();
            return;
        }
        const up = net.connect(target, '127.0.0.1', () => {
            const lines = [`${req.method} ${url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2)
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            up.write(lines.join('\r\n') + '\r\n\r\n');
            up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
    });
    return new Promise(resolve => server.listen(listen, '127.0.0.1', () => resolve(server)));
}

module.exports = { startProxy };
