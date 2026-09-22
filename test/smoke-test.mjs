import { spawn } from 'node:child_process';
import path from 'node:path';

const PROJECT_ROOT = path.join(import.meta.dirname, '..');
const child = spawn('node', ['src/server.js'], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      console.log('<--', JSON.stringify(msg).slice(0, 2000));
    } catch {
      console.log('<-- (no-json)', line.slice(0, 300));
    }
  }
});
child.stderr.on('data', (d) => console.error('[stderr]', d.toString()));
child.on('error', (e) => console.error('[spawn error]', e));

function send(msg) {
  const s = JSON.stringify(msg) + '\n';
  console.log('-->', s.trim().slice(0, 300));
  child.stdin.write(s);
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0.0.1' } } });

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}, 400);

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check', arguments: {} } });
}, 900);

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_models', arguments: {} } });
}, 1500);

setTimeout(() => {
  child.kill();
  process.exit(0);
}, 4000);
