/* ==========================================================================
   Function Name history dropdown (combobox)

   Remembers the function names that were actually run and offers them in a
   dropdown under the Function Name field, most recent first:
     * opens on focus / click / the arrow button / ArrowDown
     * typing filters the list; Up/Down move, Enter picks, Esc closes
     * the x on a row removes that entry from the history

   A name is recorded when Execute DLL, Run Memory Profile or Run Speed Profile
   is started with it (so half-typed text never pollutes the list). The history
   lives in localStorage, shared by all three actions.
   ========================================================================== */

(function () {
    'use strict';

    var KEY = 'fnp_func_history';
    var MAX = 30;

    var input = document.getElementById('func-name');
    var list = document.getElementById('func-list');
    var toggle = document.getElementById('func-toggle');
    if (!input || !list || !toggle) return;

    var items = load();
    var shown = [];          // entries currently rendered
    var active = -1;         // keyboard-highlighted row
    var open = false;
    var showAllMode = true;   // true: list everything (opened by focus/arrow), false: filter by typed text

    function load() {
        try {
            var raw = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(raw) ? raw.filter(function (x) { return typeof x === 'string' && x; }) : [];
        } catch (e) {
            return [];
        }
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* private mode */ }
    }

    function remember(name) {
        name = (name || '').trim();
        if (!name) return;
        items = items.filter(function (x) { return x !== name; });
        items.unshift(name);
        if (items.length > MAX) items.length = MAX;
        save();
    }

    // --- Rendering ---------------------------------------------------------------

    function filtered(showAll) {
        var q = input.value.trim().toLowerCase();
        if (showAll || !q) return items.slice();
        return items.filter(function (x) { return x.toLowerCase().indexOf(q) >= 0; });
    }

    function render(showAll) {
        showAllMode = showAll;
        shown = filtered(showAll);
        list.textContent = '';
        if (!shown.length) {
            var empty = document.createElement('li');
            empty.className = 'combo-empty';
            empty.textContent = items.length ? 'No matching function names' : 'No previously used function names yet';
            list.appendChild(empty);
            active = -1;
            return;
        }
        shown.forEach(function (name, i) {
            var li = document.createElement('li');
            li.className = 'combo-item' + (i === active ? ' is-active' : '') + (name === input.value.trim() ? ' is-current' : '');
            li.setAttribute('role', 'option');
            li.id = 'func-opt-' + i;

            var label = document.createElement('span');
            label.className = 'combo-label';
            label.textContent = name;
            li.appendChild(label);

            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'combo-del';
            del.tabIndex = -1;
            del.title = 'Remove from history';
            del.setAttribute('aria-label', 'Remove ' + name + ' from history');
            del.textContent = '×';
            li.appendChild(del);

            // mousedown (not click) so the input keeps focus and never blurs mid-pick
            li.addEventListener('mousedown', function (e) {
                e.preventDefault();
                if (e.target === del) {
                    items = items.filter(function (x) { return x !== name; });
                    save();
                    render(showAllMode);   // keep the current filter after a delete
                } else {
                    choose(name);
                }
            });
            li.addEventListener('mousemove', function () { setActive(i); });
            list.appendChild(li);
        });
    }

    function setActive(i) {
        active = i;
        Array.prototype.forEach.call(list.children, function (li, k) {
            li.classList.toggle('is-active', k === i);
        });
        if (i >= 0 && list.children[i]) {
            list.children[i].scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', list.children[i].id);
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function show(showAll) {
        active = -1;
        render(showAll);
        list.hidden = false;
        open = true;
        input.setAttribute('aria-expanded', 'true');
    }

    function hide() {
        list.hidden = true;
        open = false;
        active = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function choose(name) {
        input.value = name;
        // script.js persists the field on these events
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        hide();
    }

    // --- Events ---------------------------------------------------------------------

    input.addEventListener('focus', function () { show(true); });
    input.addEventListener('click', function () { if (!open) show(true); });
    input.addEventListener('input', function () { show(false); });
    input.addEventListener('blur', function () { hide(); });

    toggle.addEventListener('mousedown', function (e) {
        e.preventDefault();   // keep focus on the input
        if (open) { hide(); return; }
        input.focus();
        show(true);
    });

    input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { show(true); return; }
            if (!shown.length) return;
            var next = e.key === 'ArrowDown' ? active + 1 : active - 1;
            if (next >= shown.length) next = 0;
            if (next < 0) next = shown.length - 1;
            setActive(next);
        } else if (e.key === 'Enter') {
            if (open && active >= 0 && shown[active]) {
                e.preventDefault();
                choose(shown[active]);
            } else {
                hide();
            }
        } else if (e.key === 'Escape') {
            if (open) { e.preventDefault(); hide(); }
        } else if (e.key === 'Tab') {
            hide();
        }
    });

    // --- Record the name when a run starts ------------------------------------------------

    function wrap(name) {
        var original = window[name];
        if (typeof original !== 'function') return;
        window[name] = function () {
            remember(input.value);
            return original.apply(this, arguments);
        };
    }

    ['executeDll', 'runMemoryProfile', 'runSpeedProfile'].forEach(wrap);
})();
