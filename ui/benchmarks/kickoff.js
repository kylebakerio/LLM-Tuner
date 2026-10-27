// Kick off: choose runner / model / tasks / axes, POST /api/codebench/start. A refusal
// (battery already running, sweep running, run.py found by pgrep, bad input) is shown verbatim.
import { esc, api, post, btn, btnPrimary, input } from './util.js';

const RUNNERS = ['opencode', 'claude', 'agy', 'pi'];
const PLACEHOLDER_MODEL = { opencode: 'llama-local/<profile> (the opencode provider/model id)', claude: 'blank = the CLI default', agy: 'required: agy records no model itself', pi: 'llama-local/<profile> (the same ids as opencode)' };
// The scaffold select's options per runner. claude: who else serves the run (advisor or not).
// pi: its extension set (harness/runners/pi.py, CODEBENCH_PI_EXT), recorded as the row's scaffold.
const SCAFFOLD_OPTIONS = {
    claude: `<option value="">unset (= default)</option>
                    <option value="solo">solo — exactly one model (Agent tool and advisor off)</option>
                    <option value="default">default (inherits ~/.claude settings: currently advisor=fable)</option>
                    ${['fable', 'opus', 'sonnet', 'haiku'].map((m) => `<option value="advisor:${m}">advisor:${m}</option>`).join('')}
                    <option value="__other">advisor: other… (type it below)</option>`,
    pi: `<option value="">unset (= none)</option>
                    <option value="none">none — plain pi (no extensions)</option>
                    <option value="sol-pi">sol-pi — pi + SoL-Pi (reducer on the same local model)</option>`,
};

export function createKickoffView(root, { onStarted } = {}) {
    let tasks = []; let source = ''; let note = ''; let loaded = false;
    const selected = new Set();
    const defaultOut = (runner) => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${runner}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

    async function load() {
        if (loaded) return;
        renderForm();
        const j = await api('/api/codebench/tasks');
        if (j.error) { note = j.error; tasks = []; } else { tasks = j.tasks || []; source = j.source; note = j.note || ''; }
        loaded = true; renderForm(); renderTaskList();
    }
    const $ = (id) => root.querySelector('#' + id);
    const repoOf = (t) => (t.repo ? String(t.repo).split('/').filter(Boolean).pop() : (t.id.split('-')[0]));

    function renderForm() {
        const tiers = [...new Set(tasks.map((t) => t.tier).filter(Boolean))].sort();
        const repos = [...new Set(tasks.map(repoOf))].sort();
        const cats = [...new Set(tasks.flatMap((t) => t.category || []))].sort();
        root.innerHTML = `
            <div class="text-xs text-gray-400">Starts <code>harness/run.py --json</code> in codebench's own tree; results land in <code>results/&lt;out name&gt;</code>. One battery at a time, never beside a sweep (B7).</div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mt-2">
                <label class="text-[10px] text-gray-400">Runner<br><select id="cb-runner" class="${input} w-full">${RUNNERS.map((r) => `<option>${r}</option>`).join('')}</select></label>
                <label class="text-[10px] text-gray-400 md:col-span-2">Model<br><input id="cb-model" list="cb-model-ids" class="${input} w-full font-mono" placeholder="${esc(PLACEHOLDER_MODEL.opencode)}"><datalist id="cb-model-ids"></datalist></label>
                <label class="text-[10px] text-gray-400">Out name (results/…)<br><input id="cb-out" class="${input} w-full font-mono" value="${esc(defaultOut('opencode'))}"></label>
                <label class="text-[10px] text-gray-400">Runs per task<br><input id="cb-runs" type="number" min="1" max="20" value="1" class="${input} w-full"></label>
                <label class="text-[10px] text-gray-400">Prompt level<br><select id="cb-prompt" class="${input} w-full"><option>L2</option><option>L1</option><option>L3</option></select></label>
                <label class="text-[10px] text-gray-400">Cap (s, blank = task's)<br><input id="cb-timeout" type="number" min="30" placeholder="3600" class="${input} w-full"></label>
                <label class="text-[10px] text-gray-400 flex items-end gap-1.5 pb-1"><input type="checkbox" id="cb-validate" class="accent-indigo-500"> validate only (no model: premise check at base/fix)</label>
                <label class="text-[10px] text-gray-400">Category (instead of ids)<br><input id="cb-category" list="cb-cats" class="${input} w-full font-mono" placeholder="e.g. tier-t1"><datalist id="cb-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
            </div>
            <!-- The two axes that are NOT the model name. A run labelled "haiku" can be haiku alone,
                 haiku with a Fable advisor, or haiku with an Opus advisor -- three different systems.
                 Both are env vars the claude runner reads; no run.py flag exists for either. -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mt-2 border-t border-gray-800 pt-2">
                <label class="text-[10px] text-gray-400">Effort (claude --effort)<br><select id="cb-effort" class="${input} w-full"><option value="">CLI default</option>${['low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option>${e}</option>`).join('')}</select></label>
                <label class="text-[10px] text-gray-400">Scaffold<br><select id="cb-scaffold" class="${input} w-full">
                    ${SCAFFOLD_OPTIONS.claude}
                </select></label>
                <label class="text-[10px] text-gray-400">Advisor / subagent model (optional)<br><input id="cb-scaffold-other" class="${input} w-full font-mono" placeholder="advisor:&lt;model&gt; when 'other' is picked"></label>
                <label class="text-[10px] text-gray-400">Pin subagent model (optional)<br><input id="cb-subagent" class="${input} w-full font-mono" placeholder="CLAUDE_CODE_SUBAGENT_MODEL"></label>
                <div id="cb-axis-note" class="md:col-span-4 text-[10px] text-gray-500"></div>
            </div>
            <div class="flex flex-wrap items-end gap-2 text-xs mt-3">
                <label class="text-[10px] text-gray-400">Tier<br><select id="cb-f-tier" class="${input}"><option value="">all</option>${tiers.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
                <label class="text-[10px] text-gray-400">Repo<br><select id="cb-f-repo" class="${input}"><option value="">all</option>${repos.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
                <label class="text-[10px] text-gray-400">Search<br><input id="cb-f-q" class="${input} w-40" placeholder="id or category"></label>
                <button type="button" id="cb-sel-all" class="${btn}">select shown</button>
                <button type="button" id="cb-sel-none" class="${btn}">clear</button>
                <span id="cb-sel-count" class="text-gray-400">${selected.size} selected</span>
                <span class="text-[10px] text-gray-500">${loaded ? `${tasks.length} tasks (${esc(source)})${note ? ' — ' + esc(note) : ''}` : 'loading tasks…'}</span>
            </div>
            <div id="cb-tasks" class="mt-2 max-h-72 overflow-auto border border-gray-800 rounded p-1 text-xs"></div>
            <div class="flex items-center gap-2 mt-3">
                <button type="button" id="cb-start" class="${btnPrimary}">Start battery</button>
                <button type="button" id="cb-stop" class="${btn} text-red-300">Stop</button>
                <span id="cb-msg" class="text-xs text-gray-400"></span>
            </div>`;
        const fillModels = async () => {
            const dl = $('cb-model-ids'); dl.innerHTML = '';
            try {
                const r = await fetch(`/api/codebench/models?runner=${encodeURIComponent($('cb-runner').value)}`); const j = await r.json();
                for (const m of (j.models || [])) { const o = document.createElement('option'); o.value = m.id; o.label = m.name || m.id; dl.appendChild(o); }
            } catch (e) { /* free text still works */ }
        };
        // Only the claude runner reads these today: agy bakes the level into the model id
        // (gemini-3.8-flash-low/-medium/-high) and opencode's runner does not pass --variant
        // through yet. Grey them out and say so rather than accepting input that goes nowhere.
        // pi reads the scaffold select only: its extension set, CODEBENCH_PI_EXT (none | sol-pi).
        const syncAxes = () => {
            const r = $('cb-runner').value; const on = r === 'claude'; const pi = r === 'pi';
            const sel = $('cb-scaffold'); const want = pi ? 'pi' : 'claude';
            if (sel.dataset.opts !== want) { sel.innerHTML = SCAFFOLD_OPTIONS[want]; sel.dataset.opts = want; }
            for (const id of ['cb-effort', 'cb-scaffold', 'cb-scaffold-other', 'cb-subagent']) { const en = on || (pi && id === 'cb-scaffold'); const el = $(id); el.disabled = !en; el.classList.toggle('opacity-40', !en); if (!en) el.value = ''; }
            $('cb-axis-note').innerHTML = on
                ? 'Both are env vars for <code>harness/runners/claude.py</code>. <b>default is not "no advisor"</b>: it inherits <code>~/.claude/settings.json</code>, which today sets <code>advisorModel: fable</code> — every claude row before this axis existed ran that way. <code>solo</code> is the only setting that guarantees one model. Haiku still shows up in <code>models_used</code> for background work either way.'
                : pi
                    ? 'pi\'s scaffold is its extension set, <code>CODEBENCH_PI_EXT</code> for <code>harness/runners/pi.py</code>: <code>none</code> is plain pi, <code>sol-pi</code> adds NVIDIA\'s SoL-Pi (action fusion, observation pack, evidence-preserving reducer on the same local model, online context compaction). Recorded on every row, so the two show up as "pi" and "pi + SoL-Pi". Effort is not wired for pi.'
                    : `effort and scaffold are only wired for the claude runner — ${esc(r)} ignores them (agy bakes the level into the model id; opencode's runner does not pass provider effort yet).`;
        };
        $('cb-runner').addEventListener('change', () => { $('cb-model').placeholder = PLACEHOLDER_MODEL[$('cb-runner').value] || ''; $('cb-out').value = defaultOut($('cb-runner').value); fillModels(); syncAxes(); });
        $('cb-scaffold').addEventListener('change', () => { const other = $('cb-scaffold').value === '__other'; $('cb-scaffold-other').classList.toggle('ring-1', other); if (other) $('cb-scaffold-other').focus(); });
        syncAxes();
        fillModels();
        for (const id of ['cb-f-tier', 'cb-f-repo']) $(id).addEventListener('change', renderTaskList);
        $('cb-f-q').addEventListener('input', renderTaskList);
        $('cb-sel-all').addEventListener('click', () => { for (const t of visible()) selected.add(t.id); renderTaskList(); });
        $('cb-sel-none').addEventListener('click', () => { selected.clear(); renderTaskList(); });
        $('cb-start').addEventListener('click', start);
        $('cb-stop').addEventListener('click', async () => { const j = await post('/api/codebench/stop'); msg(j.error ? j.error : (j.running ? `stopping pid ${j.pid}` : 'nothing running'), !!j.error); });
    }
    function visible() {
        const tier = $('cb-f-tier').value, repo = $('cb-f-repo').value, q = $('cb-f-q').value.trim().toLowerCase();
        return tasks.filter((t) => (!tier || t.tier === tier) && (!repo || repoOf(t) === repo) && (!q || t.id.toLowerCase().includes(q) || (t.category || []).some((c) => c.toLowerCase().includes(q))));
    }
    function renderTaskList() {
        const box = $('cb-tasks'); if (!box) return;
        const vis = visible();
        box.innerHTML = vis.map((t) => `
            <label class="flex items-start gap-2 px-1 py-0.5 hover:bg-gray-800/40 rounded cursor-pointer">
                <input type="checkbox" data-id="${esc(t.id)}" ${selected.has(t.id) ? 'checked' : ''} class="accent-indigo-500 mt-0.5">
                <span class="font-mono text-gray-200 w-64 shrink-0 truncate" title="${esc(t.id)}">${esc(t.id)}</span>
                <span class="text-gray-500 w-10 shrink-0">${esc(t.tier || '')}</span>
                <span class="text-gray-500 w-20 shrink-0 truncate">${esc(repoOf(t))}</span>
                <span class="text-gray-500 truncate" title="${esc(t.probes || '')}">${esc((t.category || []).join(', '))}${t.prompt_levels ? ` <span class="text-gray-600">[${esc(t.prompt_levels.join('/'))}]</span>` : ''}</span>
            </label>`).join('') || `<div class="text-gray-500 p-2">${loaded ? 'no tasks match' : 'loading…'}</div>`;
        box.querySelectorAll('input[data-id]').forEach((cb) => cb.addEventListener('change', () => { if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id); $('cb-sel-count').textContent = `${selected.size} selected`; }));
        $('cb-sel-count').textContent = `${selected.size} selected`;
    }
    // "advisor: other…" takes the free-text box; anything else is the select's own value.
    function scaffoldValue() {
        const v = $('cb-scaffold').value;
        if (v !== '__other') return v;
        const t = $('cb-scaffold-other').value.trim();
        return t ? (t.startsWith('advisor:') ? t : `advisor:${t}`) : '';
    }
    function msg(text, bad) { const m = $('cb-msg'); if (m) { m.textContent = text; m.className = 'text-xs ' + (bad ? 'text-red-300' : 'text-green-300'); } }
    async function start() {
        const body = {
            // No "every task" checkbox any more: it said the same thing as "select shown" with
            // no category filter, but invisibly -- the picker showed nothing selected while the
            // battery was about to run all 102. "Select shown" is now the only path, and it is
            // visible in the selection UI. The API still refuses an empty selection.
            runner: $('cb-runner').value, model: $('cb-model').value.trim(), all: false, tasks: [...selected], category: $('cb-category').value.trim(),
            runs: $('cb-runs').value, promptLevel: $('cb-prompt').value, timeoutS: $('cb-timeout').value, outName: $('cb-out').value.trim(), validate: $('cb-validate').checked,
            effort: $('cb-effort').value, scaffold: scaffoldValue(), subagentModel: $('cb-subagent').value.trim(),
        };
        // The API refuses an empty selection (buildArgs), and it should -- but say it here, in
        // the words of the UI that is actually on screen, rather than letting the server's
        // message (which still mentions the removed "every task" tick-box) be the first answer.
        if (!body.tasks.length && !body.category) {
            msg('pick at least one task — "select shown" takes everything the filter currently lists', true);
            return;
        }
        msg('starting…', false);
        const j = await post('/api/codebench/start', body);
        if (j.error) { msg(j.error, true); return; }
        msg(`started pid ${j.pid} → ${j.outDir}`, false);
        $('cb-out').value = defaultOut(body.runner);
        if (onStarted) onStarted(j);
    }
    return { load };
}
