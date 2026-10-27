// The Models page's search box highlights instead of filtering (2026-10-10, Kyle): the match rule that picks the
// models ringed in gold (ui/shared/leaderboard.js modelMatcher). It has to hit exactly the models the old filter kept.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// the browser module, with its DOM-facing import stubbed (as test/models.test.js loads it)
async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

// catalog entries as lib/models.js listModels() shapes them (the fields the rule reads)
const MODELS = [
    { key: 'local:qwen3.8-27b:q4_k_xl', display: 'Qwen3.8-27B Q4_K_XL', family: 'Qwen3.8-27B', quant: 'Q4_K_XL' },
    { key: 'local:qwen3.8-flash-next:q2_k_xl', display: 'Qwen3.8-Flash-Next Q2_K_XL', family: 'Qwen3.8-Flash-Next', quant: 'Q2_K_XL' },
    { key: 'cloud:anthropic:claude-sonnet-5-5@medium/solo', display: 'Claude Sonnet 5.5 (medium, solo)', family: 'Claude Sonnet 5.5', quant: null },
    { key: 'cloud:anthropic:claude-haiku-5-5@medium/solo+advisor:claude-sonnet-5-5', display: 'Claude Haiku 5.5 (medium, solo+advisor:claude-sonnet-5-5)', family: 'Claude Haiku 5.5', quant: null },
    { key: 'cloud:google:gemini-3.8-flash@low', display: 'Gemini 3.8 Flash (low)', quant: undefined },   // no family at all
];
// the filter this replaces, as ui/models/index.js visibleModels() had it until 2026-10-10
const oldFilter = (models, search) => {
    const s = search.trim().toLowerCase();
    return models.filter((m) => !s
        || m.display.toLowerCase().includes(s) || m.key.toLowerCase().includes(s)
        || (m.family || '').toLowerCase().includes(s) || (m.quant || '').toLowerCase().includes(s));
};

test('modelMatcher: a term highlights exactly the models the old filter kept', async () => {
    const { modelMatcher } = await loadLb();
    for (const term of ['sonnet', 'SONNET', '  Sonnet ', 'q4_k', 'flash', 'local:', '27b', 'claude-sonnet-5-5', '@low', 'haiku 5.5', 'nothing-has-this', '(', '.']) {
        const got = MODELS.filter(modelMatcher(term)).map((m) => m.key);
        assert.deepStrictEqual(got, oldFilter(MODELS, term).map((m) => m.key), `term ${JSON.stringify(term)}`);
    }
    assert.deepStrictEqual(MODELS.filter(modelMatcher('sonnet')).map((m) => m.display),
        ['Claude Sonnet 5.5 (medium, solo)', 'Claude Haiku 5.5 (medium, solo+advisor:claude-sonnet-5-5)'], 'the key counts: an advisor names its model there');
});

test('modelMatcher: no term highlights nothing (the old filter kept everything; nothing is hidden now)', async () => {
    const { modelMatcher } = await loadLb();
    for (const term of ['', '   ', null, undefined]) assert.strictEqual(MODELS.filter(modelMatcher(term)).length, 0, `term ${JSON.stringify(term)}`);
    assert.strictEqual(modelMatcher('qwen')(null), false, 'a row with no model is not a match');
    assert.strictEqual(modelMatcher('qwen')(undefined), false);
});

test('the highlight is gold and needs no DOM to load', async () => {
    const lb = await loadLb();
    assert.strictEqual(lb.HIGHLIGHT, '#f5c542');
    assert.doesNotThrow(() => lb.ensureHighlightStyle(), 'a no-op without a document');
    // the search box no longer filters: the page module has no filtered model list left
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.ok(!/visibleModels|Filter models/.test(page), 'ui/models/index.js still filters');
    assert.ok(page.includes('Highlight models…'));
});
