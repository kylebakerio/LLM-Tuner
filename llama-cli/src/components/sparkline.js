import React from 'react';
import { Text } from 'ink';
import { BLOCKS } from '../format.js';

// Auto-scaled block sparkline over the last `width` data points.
export function Sparkline({ data, width = 30, color = 'cyan' }) {
  if (!data || data.length === 0) {
    return <Text color="gray">{'\u2591'.repeat(width)}</Text>;
  }
  const slice = data.slice(-width);
  const max = Math.max(...slice, 1e-6);
  const chars = slice.map((v) => BLOCKS[Math.min(Math.floor(((v || 0) / max) * 8.999), 8)]).join('');
  return <Text color={color}>{chars}</Text>;
}

// Threshold sparkline: solid block when the value crosses `pctOfMax` of max,
// dim block when it has any value, blank otherwise. Used for VRAM/ctx gauges.
export function SparkPct({ data, max, width = 30, color = 'cyan', dim = 'gray' }) {
  if (!data || data.length === 0 || !max) {
    return <Text color="gray">{'\u2591'.repeat(width)}</Text>;
  }
  const slice = data.slice(-width);
  const chars = slice.map((v) => {
    const p = (v || 0) / max;
    if (p > 0.5) return '\u2588';
    if (p > 0) return '\u2591';
    return ' ';
  }).join('');
  return <Text color={color}>{chars}</Text>;
}

// btop-style horizontal bar with green/yellow/red thresholds.
export function Bar({ value, max, width = 25 }) {
  if (!max || max <= 0) {
    return <Text color="gray">{'\u2591'.repeat(width)}</Text>;
  }
  const pct = Math.max(0, Math.min(1, (value || 0) / max));
  const filled = Math.round(pct * width);
  const color = pct > 0.9 ? 'red' : pct > 0.7 ? 'yellow' : 'green';
  return (
    <Text>
      <Text color={color}>{'\u2588'.repeat(filled)}</Text>
      <Text color="gray">{'\u2591'.repeat(width - filled)}</Text>
    </Text>
  );
}
