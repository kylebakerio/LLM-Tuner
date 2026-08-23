import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';

// Subsequence fuzzy match: returns a sort score (lower is better) or null.
// Case-insensitive.
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let end = -1;
  for (let ti = 0; ti < t.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      end = ti;
      if (qi === q.length) break;
    }
  }
  return qi === q.length ? end : null;
}

// Selectable, type-to-filter list. `items` is [{ label, hint?, value }].
// Keys: up/down (or j/k) move, Enter selects, Esc/q cancels, printable keys
// filter, Backspace edits the filter.
export function FuzzyList({ title, items, height = 12, onSelect, onCancel }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.map((it, i) => ({ it, i, score: 0 }));
    return items
      .map((it, i) => {
        const score = fuzzyScore(query, `${it.label} ${it.hint || ''}`);
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
    // Note: 'q' deliberately does NOT cancel here -- it's a filter character
    // (the model list is full of Qwen* names). Esc cancels.
    if (key.up || (input === 'k' && !key.ctrl)) return setSel((s) => (s - 1 + n) % n);
    if (key.down || (input === 'j' && !key.ctrl)) return setSel((s) => (s + 1) % n);
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
  const top = Math.max(0, Math.min(sel - Math.floor(visible / 2), Math.max(filtered.length - visible, 0)));

  const rows = filtered.slice(top, top + visible).map((f, row) => {
    const idx = top + row;
    const selected = idx === sel;
    return h(Text, { key: f.i, bold: selected, color: selected ? 'green' : undefined },
      `  ${selected ? '\u276F ' : '  '}${f.it.label}`,
      f.it.hint ? h(Text, { dimColor: true }, `  ${f.it.hint}`) : null,
    );
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, title),
    h(Text, { dimColor: true }, `  filter: ${query || '(none)'}  \u00B7  ${filtered.length} match${filtered.length === 1 ? '' : 'es'}`),
    filtered.length === 0
      ? h(Text, { color: 'yellow' }, '  no matches')
      : rows,
    h(Text, { dimColor: true }, '  \u2191/\u2193 move \u00B7 Enter select \u00B7 Esc cancel \u00B7 type to filter'),
  );
}
