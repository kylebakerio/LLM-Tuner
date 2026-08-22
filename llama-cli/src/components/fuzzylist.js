import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

// Subsequence fuzzy match: returns the end index of the first match (lower is
// better), or null. Case-insensitive.
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? qi - q.length + (q.length ? t.lastIndexOf(q[0]) : 0) : null;
}

// Selectable, type-to-filter list. `items` is [{ label, hint?, value }].
// Keys: up/down (or j/k) move, Enter selects, Esc/q cancels, printable keys
// filter, Backspace edits the filter.
export function FuzzyList({ title, items, height = 10, onSelect, onCancel }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.map((it, i) => ({ it, i, score: 0 }));
    return items
      .map((it, i) => {
        const hay = `${it.label} ${it.hint || ''}`;
        const score = fuzzyScore(query, hay);
        return score == null ? null : { it, i, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.i - b.i);
  }, [items, query]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useInput((input, key) => {
    const n = Math.max(filtered.length, 1);
    if (key.escape) return onCancel();
    if (input === 'q' && !key.ctrl && !key.meta) return onCancel();
    if (key.up) return setSel((s) => (s - 1 + n) % n);
    if (key.down) return setSel((s) => (s + 1) % n);
    if (input === 'k' && !key.ctrl && !key.meta) return setSel((s) => (s - 1 + n) % n);
    if (input === 'j' && !key.ctrl && !key.meta) return setSel((s) => (s + 1) % n);
    if (key.return) {
      const f = filtered[sel];
      return f ? onSelect(f.it) : null;
    }
    if (key.backspace) return setQuery((q) => q.slice(0, -1));
    if (input && input.length === 1 && !key.ctrl && !key.meta && !key.up && !key.down && input !== ' ') {
      return setQuery((q) => (q + input).slice(0, 80));
    }
  });

  const visible = Math.min(height, filtered.length);
  const top = Math.max(0, Math.min(sel - Math.floor(visible / 2), filtered.length - visible));

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>  filter: {query || '(none)'}  ·  {filtered.length} match{filtered.length === 1 ? '' : 'es'}</Text>
      {filtered.length === 0 ? (
        <Text color="yellow">  no matches</Text>
      ) : (
        filtered.slice(top, top + visible).map((f, row) => {
          const idx = top + row;
          const selected = idx === sel;
          return (
            <Text key={f.i} bold={selected} color={selected ? 'green' : undefined}>
              {'  '}{selected ? '\u276F ' : '  '}{f.it.label}
              {f.it.hint ? <Text dimColor>  {f.it.hint}</Text> : null}
            </Text>
          );
        })
      )}
      <Text dimColor>  ↑/↓ move · Enter select · Esc cancel · type to filter</Text>
    </Box>
  );
}
