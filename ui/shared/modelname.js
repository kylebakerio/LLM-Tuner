// Model file names as the UI shows them. ONE helper for every place a model name is drawn from a
// gguf file name or path: the launch select and model picker (via /api/models' `name`), the Monitor
// and History request tables, session summaries, profile lists, bench / A-B labels, the Bench tab's
// config lines, the server's own labels (lib/modelscan.js, server4.js, lib/tps.js) and dash-cli.
//
// A multi-part gguf is named `X-00001-of-00003.gguf` on disk and llama.cpp is given that part-1
// path, so it is what gets logged; the "-00001-of-00003" is an artifact of the download, not part of
// the model's name, and is dropped at display time (logged rows keep the stored name).
//
// A classic script, not an ES module, for the same reason as ui/livechat/model.js: Node 20's
// require() cannot load ESM. It always sets `globalThis.ModelName` (script.js reads it; ES modules
// `import '../shared/modelname.js'` for the side effect and read it there too) and, under Node's
// CommonJS loader, `module.exports` as well.
(function (root) {
    'use strict';

    const SPLIT_TAIL = /-\d{5}-of-\d{5}(\.gguf)?$/i;
    // inside free text: a split suffix followed by .gguf, whitespace, punctuation or the end
    const SPLIT_ANY = /-\d{5}-of-\d{5}(?=\.gguf\b|[\s)\]}·,;:'"]|$)/gi;

    const baseOf = (s) => {
        const t = String(s == null ? '' : s).trim().replace(/\\/g, '/');
        return t.slice(t.lastIndexOf('/') + 1);
    };

    /** "X-UD-Q2_K_XL-00001-of-00003.gguf" -> "X-UD-Q2_K_XL.gguf" (also without .gguf); others unchanged. */
    function stripSplit(name) {
        return String(name == null ? '' : name).replace(SPLIT_TAIL, '$1');
    }

    /**
     * The shown name of a model from its path or file name: the basename without the split suffix.
     * opts.ext false also drops ".gguf". An empty input gives ''.
     */
    function modelName(pathOrName, opts) {
        let b = stripSplit(baseOf(pathOrName));
        if (opts && opts.ext === false) b = b.replace(/\.gguf$/i, '');
        return b;
    }

    /** Drop every split suffix inside a longer label ("run X-00001-of-00003.gguf · 64k" -> "run X.gguf · 64k"). */
    function stripSplitIn(text) {
        return String(text == null ? '' : text).replace(SPLIT_ANY, '');
    }

    // Below this, a .gguf is not a model's weights: vocab files, chat-template carriers. The smallest
    // real model here is ~0.4 GB and a split model's size is its total, not part 1's ~11 MB header.
    const MIN_MODEL_BYTES = 50 * 1024 * 1024;

    /**
     * What a .gguf is, for the lists that should only offer models:
     *   'mmproj'  a multimodal projector (lib/mmproj.js pairs these with models)
     *   'draft'   a speculative-decoding draft: an `mtp-*` head, or a draft / dflash / eagle / dspark model
     *   'other'   not weights at all: a chat-template or vocab carrier, or anything under MIN_MODEL_BYTES
     *   'model'   everything else -- including a full model with MTP layers baked in
     *             ("Ornith-1.5-35B-A3B-APEX-MTP-I-Quality.gguf")
     * `bytes` (the whole model's, all parts) is optional; without it only the name decides.
     */
    function modelFileKind(pathOrName, bytes) {
        const b = baseOf(pathOrName);
        const stem = stripSplit(b).replace(/\.gguf$/i, '');
        if (/mmproj/i.test(b)) return 'mmproj';
        if (/^mtp[-_.]/i.test(b) || /(^|[-_.])(draft|dflash|eagle3?|dspark)(?=[-_.]|$)/i.test(stem)) return 'draft';
        if (/chat[-_]?template/i.test(b) || /(^|[-_.])vocab(?=[-_.]|$)/i.test(stem)) return 'other';
        if (bytes != null && Number.isFinite(Number(bytes)) && Number(bytes) < MIN_MODEL_BYTES) return 'other';
        return 'model';
    }

    const api = { stripSplit, modelName, stripSplitIn, modelFileKind, MIN_MODEL_BYTES };
    root.ModelName = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
