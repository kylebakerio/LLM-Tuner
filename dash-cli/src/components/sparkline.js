import { Text } from 'ink';
import { h } from '../h.js';

// Braille sparkline (btop-style): one braille cell = TWO samples (left and
// right dot columns), five levels each (0..4 dots, bottom-up), so a line of
// `width` characters shows the last width*2 data points at 4x the density of
// block glyphs.
//
// Braille cell bits (Unicode base U+2800):
//   left column bottom->top:  dot7 0x40, dot3 0x04, dot2 0x02, dot1 0x01
//   right column bottom->top: dot8 0x80, dot6 0x20, dot5 0x10, dot4 0x08
const LEFT_MASKS = [0x00, 0x40, 0x44, 0x46, 0x47];
const RIGHT_MASKS = [0x00, 0x80, 0xa0, 0xb0, 0xb8];
const BRAILLE = [];
for (let l = 0; l < 5; l++) {
  BRAILLE[l] = [];
  for (let r = 0; r < 5; r++) {
    BRAILLE[l][r] = String.fromCodePoint(0x2800 | LEFT_MASKS[l] | RIGHT_MASKS[r]);
  }
}

function level(p) {
  // p in [0,1] -> 0..4 (a non-zero value always shows at least one dot)
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.min(4, Math.max(1, Math.round(p * 4)));
}

// Auto-scaled braille sparkline over the last `width*2` data points.
// Pass `max` to scale against a fixed ceiling instead of the window max
// (e.g. VRAM against total -- then the shape reads as "how full", not
// "relative to recent peaks").
export function Sparkline({ data, width = 30, color = 'cyan', max = null }) {
  const n = width * 2;
  if (!data || data.length === 0) {
    return h(Text, { color: 'gray' }, BRAILLE[0][0].repeat(width));
  }
  const slice = data.slice(-n);
  const padCount = Math.max(0, n - slice.length);
  const scaleMax = max || Math.max(...slice, 1e-6);
  let out = '';
  for (let i = 0; i < width; i++) {
    const li = i * 2, ri = i * 2 + 1;
    const lv = level((li >= padCount ? (slice[li - padCount] || 0) : 0) / scaleMax);
    const rv = level((ri >= padCount ? (slice[ri - padCount] || 0) : 0) / scaleMax);
    out += BRAILLE[lv][rv];
  }
  return h(Text, { color }, out);
}

// Threshold sparkline: solid block when the value crosses half of max,
// dim block for any value, blank otherwise. Used for VRAM/ctx gauges.
export function SparkPct({ data, max, width = 30, color = 'cyan' }) {
  if (!data || data.length === 0 || !max) {
    return h(Text, { color: 'gray' }, '\u2591'.repeat(width));
  }
  const slice = data.slice(-width);
  const chars = slice.map((v) => {
    const p = (v || 0) / max;
    if (p > 0.5) return '\u2588';
    if (p > 0) return '\u2591';
    return ' ';
  }).join('');
  return h(Text, { color }, chars);
}

// btop-style horizontal bar, color-graded along its length: cells are
// green in the first half, yellow through 80%, red beyond -- so the fill
// itself shows how close to the ceiling the value is, at a glance.
export function Bar({ value, max, width = 25 }) {
  if (!max || max <= 0) {
    return h(Text, { color: 'gray' }, '\u2591'.repeat(width));
  }
  const pct = Math.max(0, Math.min(1, (value || 0) / max));
  const filled = Math.round(pct * width);
  const cells = [];
  for (let i = 0; i < filled; i++) {
    const at = (i + 1) / width;
    cells.push(h(Text, { key: i, color: at > 0.8 ? 'red' : at > 0.5 ? 'yellow' : 'green' }, '\u2588'));
  }
  cells.push(h(Text, { key: 'empty', color: 'gray' }, '\u2591'.repeat(width - filled)));
  return h(Text, null, ...cells);
}
