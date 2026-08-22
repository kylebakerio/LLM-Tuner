const BLOCK_SIZE = 60;

const buffers = { promptTps: [], genTps: [], ctxUsed: [] };

let latest = {
  promptTps: 0,
  genTps: 0,
  promptTokens: 0,
  genTokens: 0,
  ctxUsed: 0,
  active: false,
  completed: []
};

let ctxSize = 0;
function setCtxSize(n) { ctxSize = n; }

// Per-task timing accumulation (same pattern as server4.js taskTimingsByTaskId)
const taskTimings = new Map();

// Line-buffering to prevent regex misses when stdout chunks split a line
let logLineBuffer = '';

function push(key, val) {
  buffers[key].push(val);
  if (buffers[key].length > BLOCK_SIZE) buffers[key].shift();
}

function parseChunk(chunk) {
  const text = chunk.toString();
  logLineBuffer += text;
  const bufferedLines = logLineBuffer.split('\n');
  logLineBuffer = bufferedLines.pop() || '';

  for (const line of bufferedLines) {
    // Prefill progress: "prompt processing, n_tokens = 128, progress = 0.50, 450.2 tokens per second"
    if (line.includes('prompt processing, n_tokens =')) {
      const nTokensMatch = line.match(/n_tokens =\s*(\d+)/);
      const progressMatch = line.match(/progress = (0\.\d+|1\.00)/);
      const tpsMatch = line.match(/(\d+\.?\d*)\s*tokens per second/);
      if (progressMatch && tpsMatch) {
        latest.promptTps = parseFloat(tpsMatch[1]);
        latest.promptTokens = nTokensMatch ? parseInt(nTokensMatch[1], 10) : 0;
        latest.active = true;
        latest.ctxUsed = latest.promptTokens + latest.genTokens;
        push('promptTps', latest.promptTps);
        push('ctxUsed', latest.ctxUsed);
      }
    }
    // Generation progress: "print_timing: ... n_decoded = 256 ... tg = 120.5 t/s"
    else if (line.includes('print_timing:') && line.includes('n_decoded')) {
      const nDecodedMatch = line.match(/n_decoded\s*=\s*(\d+)/);
      const tpsMatch = line.match(/tg\s*=\s*(\d+\.?\d*)\s*t\/s/);
      if (nDecodedMatch && tpsMatch) {
        latest.genTps = parseFloat(tpsMatch[1]);
        latest.genTokens = parseInt(nDecodedMatch[1], 10);
        latest.active = true;
        latest.ctxUsed = latest.promptTokens + latest.genTokens;
        push('genTps', latest.genTps);
        push('ctxUsed', latest.ctxUsed);
      }
    }
    // Per-request completion: "id 0 | task 1 | prompt eval time = 1234.5 ms / 128 tokens (103.6 tokens per second)"
    else if (line.includes('print_timing:')) {
      const idTaskMatch = line.match(/id\s+(\d+)\s*\|\s*task\s+(\d+)/);
      if (idTaskMatch) {
        const taskId = idTaskMatch[2];
        const segments = line.split('|');
        const lastSegment = segments[segments.length - 1].trim();

        if (lastSegment.startsWith('prompt eval time')) {
          const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
          if (m) {
            const existing = taskTimings.get(taskId) || {};
            taskTimings.set(taskId, { ...existing, promptMs: parseFloat(m[1]), promptTokens: parseInt(m[2], 10), promptTps: parseFloat(m[3]) });
          }
        } else if (lastSegment.startsWith('eval time')) {
          const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
          if (m) {
            const existing = taskTimings.get(taskId) || {};
            taskTimings.set(taskId, { ...existing, genMs: parseFloat(m[1]), genTokens: parseInt(m[2], 10), genTps: parseFloat(m[3]) });
          }
        } else if (lastSegment.startsWith('total time')) {
          const timing = taskTimings.get(taskId) || {};
          taskTimings.delete(taskId);
          const m = lastSegment.match(/=\s*([\d.]+)\s*ms/);
          if (m || timing.promptTps || timing.genTps) {
            if (timing.promptTps) push('promptTps', timing.promptTps);
            if (timing.genTps) push('genTps', timing.genTps);
            latest.completed.push({
              ...timing,
              wallTimeMs: m ? parseFloat(m[1]) : 0,
              time: Date.now()
            });
            if (latest.completed.length > 20) latest.completed.shift();
            latest.active = false;
          }
        }
      }
    }
  }
}

function get() {
  return { buffers, latest };
}

function reset() {
  for (const key of Object.keys(buffers)) buffers[key] = [];
  latest = { promptTps: 0, genTps: 0, promptTokens: 0, genTokens: 0, ctxUsed: 0, active: false, completed: [] };
  taskTimings.clear();
  logLineBuffer = '';
}

function getCtxSize() { return ctxSize; }

module.exports = { parseChunk, get, reset, setCtxSize, getCtxSize };
