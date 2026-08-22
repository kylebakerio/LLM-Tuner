const http = require('http');

let lastNet = { bytes: null, ts: null };
let currentMetrics = { master: null, worker: null };
let pollInFlight = false;
let onUpdate = null;

const buffers = {
  masterUtil: [], masterVRAM: [], masterTemp: [], masterPwr: [],
  workerUtil: [], workerVRAM: [], workerTemp: [], workerPwr: [],
  netMbps: []
};
const BUFFER_SIZE = 40;

function pushToBuffer(key, val) {
  buffers[key].push(val);
  if (buffers[key].length > BUFFER_SIZE) buffers[key].shift();
}

function poll() {
  if (pollInFlight) return; // skip if previous poll hasn't returned yet
  pollInFlight = true;

  const body = JSON.stringify({ worker_ssh: '', local_second_gpu: 'amd' });
  const req = http.request({
    hostname: 'localhost',
    port: 8081,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Connection': 'close'
    },
    timeout: 15000
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      pollInFlight = false;
      try {
        const json = JSON.parse(data);
        const m = json.master;
        const w = json.worker || {};
        if (!m) return;

        currentMetrics = { master: m, worker: w };

        const now = Date.now();
        const totalBytes = (m.net_bytes || 0) + (w.net_bytes || 0);
        let mbps = 0;
        if (lastNet.bytes !== null) {
          const dt = (now - lastNet.ts) / 1000;
          mbps = dt > 0.2 ? Math.max(0, ((totalBytes - lastNet.bytes) / dt) / (1024 * 1024)) : 0;
        }
        lastNet = { bytes: totalBytes, ts: now };

        pushToBuffer('masterUtil', m.gpu_util || 0);
        pushToBuffer('masterVRAM', m.vram_used || 0);
        pushToBuffer('masterTemp', m.gpu_temp || 0);
        pushToBuffer('masterPwr', m.gpu_pwr || 0);
        pushToBuffer('netMbps', mbps);

        if (w && w.gpu_name !== 'Offline') {
          pushToBuffer('workerUtil', w.gpu_util || 0);
          pushToBuffer('workerVRAM', w.vram_used || 0);
          pushToBuffer('workerTemp', w.gpu_temp || 0);
          pushToBuffer('workerPwr', w.gpu_pwr || 0);
        }
        if (onUpdate) process.nextTick(onUpdate);
      } catch { /* parse error */ }
    });
  });

  req.on('error', () => { pollInFlight = false; });
  req.on('timeout', () => { pollInFlight = false; req.destroy(); });
  req.write(body);
  req.end();
}

function start(intervalMs = 5000) {
  poll();
  return setInterval(poll, intervalMs);
}

function stop(id) {
  if (id) clearInterval(id);
}

function get() {
  return { current: currentMetrics, buffers };
}

function setUpdateCallback(fn) {
  onUpdate = fn;
}

module.exports = { start, stop, get, setUpdateCallback };
