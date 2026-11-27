/* ==========================================================================
   Symbols (PDB) field.

   The leak-site tracker and the speed profiler turn raw addresses into function
   names, files and lines through the DLL's PDB. A PDB from a different build would
   silently produce wrong names, so the field validates the DLL/PDB pair as soon as
   either path changes and says plainly which of these it is:

     match     the PDB belongs to this exact DLL build
     mismatch  a PDB was found, but from another build (or misnamed)
     missing   no PDB located next to the DLL or at the path it was linked with
     nodebug   the DLL carries no debug record at all (linked without /DEBUG)
   ========================================================================== */

(function () {
    'use strict';

    var KEY = 'fnp_pdb_path';
    var timer = null;
    var seq = 0;
    var last = null;

    function $(id) { return document.getElementById(id); }

    function dllDir() {
        var v = ($('dll-path').value || '').trim();
        var i = Math.max(v.lastIndexOf('\\'), v.lastIndexOf('/'));
        return i > 0 ? v.slice(0, i) : '';
    }

    function paint(res) {
        var badge = $('sym-status');
        var detail = $('sym-detail');
        if (!res) {
            badge.style.display = 'none';
            detail.textContent = '';
            detail.className = 'field-hint';
            return;
        }
        var map = {
            match: ['success', 'PDB matched'],
            mismatch: ['error', 'PDB mismatch'],
            missing: ['', 'No PDB found'],
            nodebug: ['error', 'No debug info'],
            error: ['error', 'Cannot read DLL']
        };
        var m = map[res.state] || ['', res.state];
        badge.className = 'status-badge' + (m[0] ? ' ' + m[0] : '');
        badge.textContent = m[1];
        badge.style.display = 'inline-block';

        var text = res.message || '';
        if (res.machine && res.machine !== 'x64') {
            text += (text ? ' ' : '') + 'Note: this DLL is ' + res.machine +
                ', but the tester runs 64-bit Python and can only load x64 DLLs.';
        }
        detail.textContent = text;
        detail.className = 'field-hint' + (res.state === 'match' ? '' : ' is-warn');
        detail.title = res.pdb ? 'PDB: ' + res.pdb : '';
    }

    function check() {
        var dll = ($('dll-path').value || '').trim();
        var pdb = ($('pdb-path').value || '').trim();
        if (!dll) { last = null; paint(null); return Promise.resolve(null); }
        var mine = ++seq;
        return fetch('/api/symbol_check?dll=' + encodeURIComponent(dll) +
            '&pdb=' + encodeURIComponent(pdb))
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (mine !== seq) return null;   // a newer check superseded this one
                last = res;
                paint(res);
                return res;
            })
            .catch(function () { return null; });
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(check, 400);
    }

    function save() {
        try { localStorage.setItem(KEY, $('pdb-path').value); } catch (e) { /* private mode */ }
    }

    window.FnpSymbols = {
        dllDir: dllDir,
        check: check,
        current: function () { return last; },
        path: function () { return ($('pdb-path').value || '').trim(); }
    };

    window.addEventListener('load', function () {
        try {
            var saved = localStorage.getItem(KEY);
            if (saved) $('pdb-path').value = saved;
        } catch (e) { /* ignore */ }

        ['dll-path', 'pdb-path'].forEach(function (id) {
            var node = $(id);
            node.addEventListener('input', schedule);
            node.addEventListener('change', schedule);
        });
        $('pdb-path').addEventListener('input', save);
        $('pdb-path').addEventListener('change', save);

        // The native Browse dialog sets .value directly, which fires no event.
        var original = window.openFileBrowser;
        if (typeof original === 'function') {
            window.openFileBrowser = function (inputId) {
                var out = original.apply(this, arguments);
                return Promise.resolve(out).then(function (r) {
                    if (inputId === 'pdb-path') save();
                    if (inputId === 'dll-path' || inputId === 'pdb-path') check();
                    return r;
                });
            };
        }
        check();
    });
})();
