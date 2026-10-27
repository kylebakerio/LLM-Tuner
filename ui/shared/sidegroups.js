// Launch-sidebar groups (index.html <details class="side-group" data-key=...>): remember each
// group's open/closed state, and keep the one-line summary in its header current so a closed
// group still says what it's set to. Plain script, loaded after script.js.
//
// The summaries poll as well as listen: profile loads and "Last settings" set field values from
// script.js without firing input events, and a 1.5 s read of a dozen fields costs nothing.
(function sideGroups() {
    const groups = document.querySelectorAll('details.side-group[data-key]');
    for (const d of groups) {
        const key = 'side_group_' + d.dataset.key;
        try {
            const saved = localStorage.getItem(key);
            if (saved === '1') d.open = true;
            else if (saved === '0') d.open = false;
        } catch { /* storage blocked: keep the markup default */ }
        d.addEventListener('toggle', () => {
            try { localStorage.setItem(key, d.open ? '1' : '0'); } catch { /* ignore */ }
        });
    }

    const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    const on = (id) => !!document.getElementById(id)?.checked;
    // 262144 -> 256k, 110000 -> 110k, 128000 -> 128k: the one context rule (ui/shared/ctxlabel.js, globalThis.CtxLabel,
    // loaded before this file; 2026-10-25 -- this file had its own, which read 128000 "125k"); a blank field '?'
    const k = (n) => globalThis.CtxLabel.ctxLabel(n) || n || '?';

    const HINTS = {
        runtime: () => [`${k(val('server-ctx'))} ctx`, `KV ${val('server-cache-k')}${val('server-cache-v') !== val('server-cache-k') ? '/' + val('server-cache-v') : ''}`, on('server-fa') ? 'FA' : '']
            .filter(Boolean).join(' · '),
        spec: () => {
            const types = [...document.querySelectorAll('.spec-type-cb:checked')].map((cb) => cb.value);
            if (!types.length) return 'off';
            return types.length === 1 ? `${types[0]} · n${val('mtp-draft-n')}` : `${types.length} strategies`;
        },
        strata: () => {
            const base = val('strata-base').split('/').pop().replace(/^strata-/, '').replace(/\.json$/, '');
            // the overrides that are set (blank = the base file's value); 2026-10-17: + spec, pipeline windows, GPUs
            return [base, val('strata-max-context') ? `${k(val('strata-max-context'))} ctx` : '', val('strata-rope-scaling') === 'yarn' ? `yarn${val('strata-rope-scale') ? '×' + val('strata-rope-scale') : ''}` : '',
                val('strata-spec') ? `spec ${val('strata-spec')}` : '', val('strata-pipeline-windows') ? `pw ${val('strata-pipeline-windows')}` : '', val('strata-gpu') ? `GPU ${val('strata-gpu')}` : '']
                .filter(Boolean).join(' · ');
        },
        sampling: () => `temp ${val('server-temp')} · top-k ${val('server-top-k')}`,
        templates: () => [on('jinja-toggle') ? 'jinja' : '', on('mmproj-toggle') ? 'vision' : ''].filter(Boolean).join(' · '),
        advanced: () => (val('extra-args') ? 'extra args' : ''),
    };
    function refresh() {
        for (const el of document.querySelectorAll('.side-hint[data-hint]')) {
            const f = HINTS[el.dataset.hint];
            if (!f) continue;
            let text = '';
            try { text = f(); } catch { /* a field not rendered yet */ }
            if (el.textContent !== text) el.textContent = text;
        }
    }
    const aside = document.getElementById('launch-sidebar');
    aside?.addEventListener('input', refresh);
    aside?.addEventListener('change', refresh);
    setInterval(refresh, 1500);
    refresh();
})();
