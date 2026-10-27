'use strict';
// --- SCORED LAUNCH RECIPES, BY WHAT THEY MEAN (2026-10-13) ---
// The queue's "new item" presets turn a saved `bench · ` profile into the launch command of a benchmark row. Two
// recipes were recognised by their exact device ids -- `ROCm0:75,CUDA0:25` and a lone `ROCm0` -- and a profile on
// `CUDA0` alone was sent to a lane named after one card. A second identical card (ROCm1), another machine's ids, or
// the same recipe after a card moved slots matched nothing. Here a recipe is its SHAPE:
//
//   single card   one local device, the draft model on that same device
//   two cards 3:1 two local devices on two different cards, shares 75 / 25, the draft model on the first
//
// and the ids in the command it produces are the profile's own. For the profiles recorded so far the result is the
// same text as before, character for character (test/recipes.test.js holds that): the first recipe always wrote the
// profile's flags out in full, and the second is the launch variable `$D27MTP` -- which is still used, but only said
// to BE the profile's placement when its `-dev` / `-ts` agree with the profile (see `placementOf`); when they do
// not, the preset carries a note saying so instead of silently standing for another layout.
//
// Machine-specific names come from dashboard.config.json `queue`:
//   stockBuild   the build id `$STOCK` is. Default: the configured build whose path is `$STOCK` in the launch
//                variables file.
//   laneByCard   { "<card name or device id>": "<lane>" }: where a profile confined to that one card is queued.
//                Default: none (everything goes to `local-gpu`).
// Pure (no I/O). Card identity is the device's saved name, else the topology's card for its id, else the id.

const { gpuKey } = require('./devices');
const topo = require('./topology');

const MTP = /^draft-mtp(,ngram-mod)?$/;
const KV = new Set(['q8_0', 'f16']);

const localDevices = (c) => (Array.isArray(c && c.devices) ? c.devices : []).filter((d) => d && d.id && !d.worker && !d.rpcEndpoint && !/^RPC\d*$/i.test(String(d.id)));
function cardKey(d, topology) {
    if (d && d.name) return gpuKey(d.name);
    const c = topology ? topo.cardOfId(topology, d && d.id) : null;
    return c ? gpuKey(c.name) : `id:${d && d.id}`;
}
// two devices are two cards unless they are the same id, or the topology says both ids reach one physical card
function distinctCards(a, b, topology) {
    if (a.id === b.id) return false;
    const ca = topology ? topo.cardOfId(topology, a.id) : null, cb = topology ? topo.cardOfId(topology, b.id) : null;
    return !(ca && cb && ca.key === cb.key);
}

/** `-dev a,b -ts x,y -devd d` out of a launch variable's text -> { ids, ts, draft } (null where it says nothing). */
function placementOf(text) {
    const s = String(text || '');
    const one = (re) => { const m = re.exec(s); return m ? m[1].replace(/['"]/g, '') : null; };
    const ids = one(/(?:^|\s)(?:-dev|--device)\s+(\S+)/), ts = one(/(?:^|\s)(?:-ts|--tensor-split)\s+(\S+)/), draft = one(/(?:^|\s)(?:-devd|--device-draft|--spec-draft-device)\s+(\S+)/);
    return { ids: ids ? ids.split(',') : null, ts: ts ? ts.split(',').map(Number) : null, draft };
}
const sameRatio = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x * b[0] === b[i] * a[0]);

/** The build id `$STOCK` stands for: the configured one, else the build whose binary `$STOCK` is. null = not known. */
function stockBuildId({ vars = {}, builds = [], stockBuild = null } = {}) {
    if (stockBuild) return stockBuild;
    const hit = vars.STOCK ? (builds || []).find((b) => b && b.path === vars.STOCK) : null;
    return hit ? hit.id : null;
}

/**
 * The launch command a `bench · ` llama.cpp profile stands for.
 *   c: the profile config.  ctx: { vars (launch variables), builds ([{ id, path }]), stockBuild, topology }
 * -> { recipe: 'two-card-3-1' | 'single-card' | 'raw' | null, launchCmd, warning }
 * `warning`: the profile matched a recipe whose launch variable no longer describes the profile's own placement.
 */
function launchFor(c, ctx = {}) {
    const local = localDevices(c);
    const all = Array.isArray(c.devices) ? c.devices : [];
    const stock = !!c.build && c.build === stockBuildId(ctx);
    const common = MTP.test(c.specType || '') && Number(c.specDraftNMax) === 2 && !!c.fa && !!c.jinja && Number(c.ngl) === 999;
    const first = local[0];
    if (stock && common && all.length === 2 && local.length === 2 && Number(local[0].share) === 75 && Number(local[1].share) === 25
        && c.cacheK === 'f16' && c.cacheV === 'f16' && c.specDraftDevice === first.id && distinctCards(local[0], local[1], ctx.topology)) {
        const want = { ids: local.map((d) => d.id), ts: [3, 1], draft: first.id };
        const has = placementOf((ctx.vars || {}).D27MTP);
        // the variable says nothing about placement (not defined here, or defined elsewhere): nothing to contradict
        const agrees = !has.ids || (has.ids.join(',') === want.ids.join(',') && (!has.ts || sameRatio(has.ts, want.ts)) && (!has.draft || has.draft === want.draft));
        return { recipe: 'two-card-3-1', launchCmd: `$STOCK -m ${c.modelPath} -c ${c.ctx} $D27MTP`,
            warning: agrees ? null : `$D27MTP now places a model on ${has.ids.join(',')}${has.ts ? ' ' + has.ts.join(':') : ''}, not on this profile's ${want.ids.join(',')} 3:1 -- write the launch command out, or it runs the variable's layout` };
    }
    if (stock && common && all.length === 1 && local.length === 1 && KV.has(c.cacheK) && KV.has(c.cacheV) && c.specDraftDevice === first.id) {
        return { recipe: 'single-card', warning: null,
            launchCmd: `$STOCK -m ${c.modelPath} -c ${c.ctx} -ngl 999 -fa on --cache-type-k ${c.cacheK || 'q8_0'} --cache-type-v ${c.cacheV || 'q8_0'} --spec-type ${c.specType} --spec-draft-n-max 2 -np 1 --spec-draft-device ${c.specDraftDevice} -dev ${first.id} --jinja` };
    }
    if (c.rawCommand) return { recipe: 'raw', warning: null, launchCmd: c.rawCommand.replace(/\s*--(host|port)\s+\S+/g, '').replace(/\s*-p\s+\S+/g, '').trim() };
    return { recipe: null, launchCmd: '', warning: null };
}

/**
 * The lane a profile is queued on: one confined to a single card goes to that card's lane when
 * dashboard.config.json `queue.laneByCard` names one (by card name, or by the device id as saved); anything else, and
 * every profile on a machine that configures none, goes to `fallback`.
 */
function laneFor(c, { laneByCard = null, topology = null, fallback = 'local-gpu' } = {}) {
    const all = Array.isArray(c && c.devices) ? c.devices : [];
    const local = localDevices(c);
    if (!laneByCard || all.length !== 1 || local.length !== 1) return fallback;
    const key = cardKey(local[0], topology);
    for (const [k, lane] of Object.entries(laneByCard)) {
        if (typeof lane !== 'string' || !lane) continue;
        if (k === local[0].id || gpuKey(k) === key) return lane;
    }
    return fallback;
}

module.exports = { launchFor, laneFor, stockBuildId, placementOf, localDevices };
