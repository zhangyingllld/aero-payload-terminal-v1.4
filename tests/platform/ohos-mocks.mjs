// The native adapter runs unchanged. Only the OS APIs are mapped onto Node;
// bytes actually traverse loopback TCP. This is NOT a substitute for board tests.
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
const servers = new Set();
const clients = new Set();
let clientId = 0;
class Connection extends EventEmitter {
  constructor(stream = new net.Socket()) {
    super(); this.stream = stream; this.clientId = ++clientId; clients.add(this);
    stream.on('data', chunk => this.emit('message', { message: Uint8Array.from(chunk).buffer }));
    stream.on('close', () => { clients.delete(this); this.emit('close'); });
    stream.on('error', error => this.emit('error', error));
  }
  async bind(address) { this.localAddress = address.address; this.localPort = address.port; }
  async connect(options) {
    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.connect({ host: options.address.address, port: options.address.port,
        localAddress: this.localAddress, localPort: this.localPort }, () => {
        this.stream.off('error', reject); resolve();
      });
    });
  }
  async send({ data }) { await new Promise((resolve, reject) => this.stream.write(data, error => error ? reject(error) : resolve())); }
  async close() { this.stream.destroy(); }
}
class Server extends EventEmitter {
  constructor() {
    super(); this.server = net.createServer(stream => this.emit('connect', new Connection(stream)));
    this.server.on('error', error => this.emit('error', error)); servers.add(this.server);
  }
  async listen(address) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(address.port, address.address, () => { this.server.off('error', reject); resolve(); });
    });
  }
}
export const mockSocket = { constructTCPSocketInstance: () => new Connection(), constructTCPSocketServerInstance: () => new Server() };
export const mockUtil = {
  TextDecoder: { create: (encoding, options) => ({ decodeToString: bytes => new TextDecoder(encoding, options).decode(bytes) }) },
  TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } }
};
export const mockTime = { TimeType: { STARTUP: 0 }, getUptime: () => performance.now() };
export const mockLog = { info: () => {} };
export const mockFs = {
  OpenMode: { CREATE: 64, READ_WRITE: 2, TRUNC: 512 },
  openSync: path => ({ fd: fs.openSync(path, 'w+') }),
  writeSync: (fd, text) => fs.writeSync(fd, text),
  closeSync: file => fs.closeSync(typeof file === 'number' ? file : file.fd),
  renameSync: fs.renameSync,
  accessSync: fs.existsSync,
  readTextSync: path => fs.readFileSync(path, 'utf8')
};
export async function shutdown() {
  for (const client of clients) await client.close();
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(() => resolve()))));
  servers.clear();
}
export async function unusedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
