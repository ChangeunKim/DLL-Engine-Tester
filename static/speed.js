/* ==========================================================================
   Speed Profiler front end

   Streams NDJSON from /api/speed_profile. The run has two phases:
     1. timing   - N calls with nothing attached: wall and CPU time per call
     2. sampling - M calls while fnp_sampler.exe snapshots the call stack
   Phase 1 feeds the statistics and the per-call chart; phase 2 feeds the flame
   graph, the module breakdown and the hottest-function table. All charts are
   inline SVG (no library, no network).
   ========================================================================== */

(function () {
    'use strict';

    var V = window.FnpViz;
    if (!V) return;   // profiler.js failed to load; nothing to build on
    var VIZ = V.VIZ, el = V.el, text = V.text, fmtMs = V.fmtMs, fmtInt = V.fmtInt;

    var GEO = { padL: 62, padR: 20, padT: 12, padB: 44, plotH: 190 };
    var FLAME_ROW = 20;
    var FLAME_MAX_ROWS = 48;
    var MIN_BAR_PX = 0.7;

    // Role colors: one hue per kind of code, so the same entity keeps one color in the
    // flame graph, the module bar and the table.
    var ROLE = {
        dll: { color: '#3987e5', name: 'DLL code' },
        runtime: { color: '#199e70', name: 'C/C++ runtime' },
        os: { color: '#d95926', name: 'OS / waits' },
        other: { color: '#7c879c', name: 'Other' }
    };

    var state = {
        running: false, controller: null, start: null,
        calls: [],            // phase-1 timings: {ms, cpu}
        sampleDone: 0, phase: 'timing',
        summary: null, logs: '', noise: [], error: null, trace: '', exit: null,
        planned: 0, warmup: 0, sampleCalls: 0, sampling: false,
        sort: 'self', zoom: null, finished: false,
        renderQueued: false, lastRender: 0
    };

    function $(id) { return document.getElementById(id); }

    // --- Roles --------------------------------------------------------------------

    function roleOf(moduleName) {
        var m = (moduleName || '').toLowerCase();
        var target = state.summary && state.summary.sampling
            ? (state.summary.sampling.target || '').toLowerCase() : '';
        if (target && m === target) return 'dll';
        if (/^(ucrtbase|vcruntime|msvcp|msvcr|api-ms-win-crt|concrt|vcomp|libcmt)/.test(m)) return 'runtime';
        if (/^(ntdll|kernel32|kernelbase|win32u|user32|gdi32|ucrt|combase|ole32|oleaut32|rpcrt4|advapi32|sechost|bcrypt)/.test(m)) return 'os';
        return 'other';
    }

    // --- Statistics helpers --------------------------------------------------------

    function measuredCalls() {
        return state.calls.slice(state.warmup);
    }

    function liveStats() {
        var m = measuredCalls();
        if (!m.length) return null;
        var v = m.map(function (c) { return c.ms; }).sort(function (a, b) { return a - b; });
        function q(p) {
            var pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.min(lo + 1, v.length - 1);
            return v[lo] + (v[hi] - v[lo]) * (pos - lo);
        }
        var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
        return { avg_ms: mean, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), min_ms: v[0],
            max_ms: v[v.length - 1], count: v.length };
    }

    // --- Scales / frame -----------------------------------------------------------------

    function msScale(hi) {
        var step = V.niceStep(Math.max(hi, 1e-6) / 4);
        var max = Math.ceil(hi / step - 1e-9) * step;
        if (max <= 0) max = step;
        var ticks = [];
        for (var v = 0; v <= max + step * 1e-9; v += step) ticks.push(v);
        var dp = 0;
        while (dp < 3 && Math.abs(parseFloat(step.toFixed(dp)) - step) > step * 1e-6) dp++;
        return { min: 0, max: max, ticks: ticks, label: function (t) { return t.toFixed(dp) + ' ms'; } };
    }

    function chartFrame(host, n, scale) {
        var W = Math.max(320, host.clientWidth || 640);
        var H = GEO.padT + GEO.plotH + GEO.padB;
        var x0 = GEO.padL, x1 = W - GEO.padR;
        var svg = el('svg', { width: W, height: H, role: 'img' });
        function xAt(i) { return n <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (i / (n - 1)); }
        function iAt(px) {
            if (n <= 1) return 0;
            return Math.max(0, Math.min(n - 1, Math.round((px - x0) / ((x1 - x0) || 1) * (n - 1))));
        }
        function yAt(v) { return GEO.padT + GEO.plotH - (v - scale.min) / ((scale.max - scale.min) || 1) * GEO.plotH; }

        if (state.warmup > 0 && n > 0) {
            var half = n > 1 ? (xAt(1) - xAt(0)) / 2 : (x1 - x0) / 2;
            var end = Math.min(xAt(Math.min(state.warmup, n) - 1) + half, x1);
            svg.appendChild(el('rect', {
                x: x0, y: GEO.padT, width: Math.max(0, end - x0), height: GEO.plotH,
                fill: 'rgba(255,255,255,0.035)'
            }));
            if (end - x0 > 46) {
                svg.appendChild(text(x0 + 6, GEO.padT + 13, 'warmup', {
                    fill: VIZ.inkMuted, 'font-size': '10', 'font-family': 'Inter, sans-serif'
                }));
            }
        }
        scale.ticks.forEach(function (t) {
            var y = yAt(t);
            svg.appendChild(el('line', { x1: x0, y1: y, x2: x1, y2: y, stroke: VIZ.grid, 'stroke-width': 1 }));
            svg.appendChild(text(x0 - 9, y + 3.5, scale.label(t), {
                fill: VIZ.inkMuted, 'font-size': '10.5', 'text-anchor': 'end',
                'font-family': 'Inter, sans-serif', 'font-variant-numeric': 'tabular-nums'
            }));
        });
        svg.appendChild(el('line', {
            x1: x0, y1: GEO.padT + GEO.plotH, x2: x1, y2: GEO.padT + GEO.plotH,
            stroke: VIZ.axis, 'stroke-width': 1
        }));
        var want = Math.max(2, Math.min(8, Math.floor((x1 - x0) / 90)));
        var step = Math.max(1, Math.round(n / want));
        var slots = [];
        for (var s = 0; s < n - 1; s += step) slots.push(s);
        slots.push(n - 1);
        if (slots.length > 2 && xAt(slots[slots.length - 1]) - xAt(slots[slots.length - 2]) < 44) {
            slots.splice(slots.length - 2, 1);
        }
        slots.forEach(function (slot) {
            svg.appendChild(text(Math.round(xAt(slot)), GEO.padT + GEO.plotH + 17, String(slot + 1), {
                fill: VIZ.inkMuted, 'font-size': '10.5', 'text-anchor': 'middle',
                'font-family': 'Inter, sans-serif', 'font-variant-numeric': 'tabular-nums'
            }));
        });
        svg.appendChild(text((x0 + x1) / 2, H - 6, 'call number', {
            fill: VIZ.inkMuted, 'font-size': '10', 'text-anchor': 'middle', 'font-family': 'Inter, sans-serif'
        }));
        return { svg: svg, W: W, x0: x0, x1: x1, xAt: xAt, iAt: iAt, yAt: yAt, n: n };
    }

    // --- Per-call chart -----------------------------------------------------------------------

    function renderCallsChart() {
        var host = $('spd-chart-calls');
        var tip = $('spd-tip-calls');
        var n = state.calls.length;
        if (!host || !n) return;

        var hi = 0;
        state.calls.forEach(function (c) { hi = Math.max(hi, c.ms, c.cpu || 0); });
        var scale = msScale(hi * 1.1);
        var frame = chartFrame(host, n, scale);
        var haveCpu = !!(state.start && state.start.cpu_clock);

        [{ key: 'ms', color: VIZ.private, w: 2 }].concat(haveCpu ? [{ key: 'cpu', color: VIZ.transient, w: 2 }] : [])
            .forEach(function (ser) {
                var d = '';
                state.calls.forEach(function (c, i) {
                    d += (i ? 'L' : 'M') + frame.xAt(i).toFixed(1) + ' ' + frame.yAt(c[ser.key]).toFixed(1);
                });
                frame.svg.appendChild(el('path', {
                    d: d, fill: 'none', stroke: ser.color, 'stroke-width': ser.w,
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round'
                }));
                frame.svg.appendChild(el('circle', {
                    cx: frame.xAt(n - 1), cy: frame.yAt(state.calls[n - 1][ser.key]), r: 4,
                    fill: ser.color, stroke: VIZ.surface, 'stroke-width': 2
                }));
            });

        var cross = el('line', {
            y1: GEO.padT, y2: GEO.padT + GEO.plotH, stroke: 'rgba(255,255,255,0.28)',
            'stroke-width': 1, visibility: 'hidden'
        });
        frame.svg.appendChild(cross);
        var overlay = el('rect', {
            x: frame.x0, y: GEO.padT, width: Math.max(0, frame.x1 - frame.x0), height: GEO.plotH,
            fill: 'transparent', style: 'cursor:crosshair'
        });
        frame.svg.appendChild(overlay);

        function show(i) {
            if (i === null) { cross.setAttribute('visibility', 'hidden'); tip.classList.remove('visible'); return; }
            var c = state.calls[i];
            var x = frame.xAt(i);
            cross.setAttribute('x1', x); cross.setAttribute('x2', x);
            cross.setAttribute('visibility', 'visible');
            tip.textContent = '';
            var head = document.createElement('div');
            head.className = 'tt-head';
            head.textContent = 'Call ' + (i + 1) + (i < state.warmup ? ' (warmup)' : '') + ' of ' + state.planned;
            tip.appendChild(head);
            var rows = [{ name: 'Wall time', color: VIZ.private, value: fmtMs(c.ms) }];
            if (haveCpu) {
                rows.push({ name: 'CPU time', color: VIZ.transient, value: fmtMs(c.cpu) });
                rows.push({ name: 'Waiting', color: 'transparent', value: fmtMs(Math.max(0, c.ms - c.cpu)) });
            }
            rows.forEach(function (r) {
                var row = document.createElement('div');
                row.className = 'tt-row';
                var key = document.createElement('span');
                key.className = 'tt-key'; key.style.background = r.color;
                var nm = document.createElement('span'); nm.className = 'tt-name'; nm.textContent = r.name;
                var val = document.createElement('span'); val.className = 'tt-val'; val.textContent = r.value;
                row.appendChild(key); row.appendChild(nm); row.appendChild(val);
                tip.appendChild(row);
            });
            tip.classList.add('visible');
            var tw = tip.offsetWidth || 170;
            var left = x + 14;
            if (left + tw > frame.W - 4) left = x - tw - 14;
            tip.style.left = Math.max(4, left) + 'px';
            tip.style.top = (GEO.padT + 6) + 'px';
        }
        function at(ev) {
            var box = host.getBoundingClientRect();
            show(frame.iAt(ev.clientX - box.left));
        }
        overlay.addEventListener('pointermove', at);
        overlay.addEventListener('pointerdown', at);
        overlay.addEventListener('pointerleave', function () { show(null); });

        var old = host.querySelector('svg');
        if (old) host.removeChild(old);
        host.insertBefore(frame.svg, tip);

        var st = state.summary ? state.summary.timing : liveStats();
        V.renderLegend('spd-legend-calls', [
            { name: 'Wall time', color: VIZ.private, value: fmtMs(state.calls[n - 1].ms) },
            haveCpu ? { name: 'CPU time', color: VIZ.transient, value: fmtMs(state.calls[n - 1].cpu) } : null,
            st && st.p50_ms !== undefined ? { name: 'median', color: null, value: fmtMs(st.p50_ms) } : null
        ]);
    }

    // --- Hero, stats, banner ----------------------------------------------------------------------

    function timingNow() {
        return state.summary ? state.summary.timing : liveStats();
    }

    function renderHero() {
        var t = timingNow();
        if (!t) return;
        $('spd-hero-value').textContent = fmtMs(t.p50_ms);
        $('spd-hero-unit').textContent = 'per call';
        $('spd-hero-sub').textContent =
            'mean ' + fmtMs(t.avg_ms) + '  ·  p95 ' + fmtMs(t.p95_ms) + '  ·  p99 ' + fmtMs(t.p99_ms) +
            '  ·  ' + (t.count || 0) + ' measured calls';
    }

    function renderStats() {
        var host = $('spd-stats');
        var t = timingNow();
        if (!host || !t) return;
        host.textContent = '';
        var tile = V.tile;
        host.appendChild(tile('Mean', fmtMs(t.avg_ms),
            'min ' + fmtMs(t.min_ms) + ' · max ' + fmtMs(t.max_ms)));
        host.appendChild(tile('95th percentile', fmtMs(t.p95_ms), '1 call in 20 is slower'));
        host.appendChild(tile('99th percentile', fmtMs(t.p99_ms),
            t.count < 20 ? 'few calls: a rough figure' : '1 call in 100 is slower'));
        if (t.stdev_ms !== undefined) {
            var rel = t.avg_ms ? (t.stdev_ms / t.avg_ms) * 100 : 0;
            host.appendChild(tile('Variability', '± ' + fmtMs(t.stdev_ms), rel.toFixed(1) + '% of the mean'));
        }
        var first = state.summary ? t.first_ms : (state.calls[0] ? state.calls[0].ms : null);
        if (first !== null && first !== undefined) {
            host.appendChild(tile('First call', fmtMs(first),
                t.p50_ms ? (first / t.p50_ms).toFixed(2) + '× the median' : ''));
        }
        if (t.cpu_avg_ms !== undefined && t.avg_ms) {
            var util = Math.min(100, (t.cpu_avg_ms / t.avg_ms) * 100);
            host.appendChild(tile('CPU per call', fmtMs(t.cpu_avg_ms),
                util.toFixed(0) + '% of wall time computing' + (util < 70 ? ' · the rest is waiting' : '')));
        }
        if (state.summary) {
            host.appendChild(tile('Timed run', fmtMs(t.total_ms), (t.count + state.warmup) + ' calls incl. warmup'));
        }
    }

    function topFunction(sampling) {
        var flat = sampling && sampling.flat ? sampling.flat : [];
        return flat.length ? flat[0] : null;
    }

    function renderBanner() {
        var banner = $('spd-banner');
        var sum = state.summary;
        banner.className = 'verdict-banner verdict-unknown';
        var icon = $('spd-banner-icon'), title = $('spd-banner-title'), detail = $('spd-banner-detail');
        if (!sum) {
            icon.textContent = '…';
            if (state.running) {
                title.textContent = state.phase === 'sampling' ? 'Sampling hot spots' : 'Timing';
                detail.textContent = state.phase === 'sampling'
                    ? 'Call ' + state.sampleDone + ' of ' + state.sampleCalls + ' with the sampler attached.'
                    : 'Call ' + state.calls.length + ' of ' + state.planned + '. The statistics land when the run finishes.';
            } else {
                title.textContent = 'No result';
                detail.textContent = 'The run did not finish.';
            }
            return;
        }
        var t = sum.timing;
        icon.textContent = '✓';
        title.textContent = 'Profile complete';
        var bits = ['Median ' + fmtMs(t.p50_ms) + ', p95 ' + fmtMs(t.p95_ms) + ' over ' + t.count + ' calls.'];
        if (t.cpu_avg_ms !== undefined && t.avg_ms && t.cpu_avg_ms / t.avg_ms < 0.7) {
            bits.push(Math.round((1 - t.cpu_avg_ms / t.avg_ms) * 100) +
                '% of the wall time is spent waiting rather than computing.');
        }
        var sp = sum.sampling;
        if (sp && sp.tree && sp.tree.v) {
            var top = topFunction(sp);
            if (top) {
                bits.push('Most time is spent in ' + top.name + ' (' +
                    Math.round(top.self / sp.tree.v * 100) + '% of the call).');
            }
        }
        detail.textContent = bits.join(' ');
    }

    function renderNotes() {
        var ul = $('spd-notes');
        ul.textContent = '';
        ((state.summary && state.summary.notes) || []).forEach(function (n) {
            var li = document.createElement('li');
            li.textContent = n;
            ul.appendChild(li);
        });
    }

    // --- Flame graph -----------------------------------------------------------------------------------

    function fracMs(v, root) {
        var sp = state.summary.sampling;
        return root && root.v ? (v / root.v) * sp.sampled_avg_ms : 0;
    }

    function pct(v, root) {
        return root && root.v ? (v / root.v) * 100 : 0;
    }

    function nodeLabel(n) {
        return n.n;
    }

    function setFlameDetail(n, root) {
        var box = $('spd-flame-detail');
        if (!n) { box.textContent = 'Hover a bar for details.'; return; }
        var parts = [n.n];
        if (n.m) parts.push(n.m);
        if (n.f) parts.push(V.baseName(n.f) + (n.l ? ':' + n.l : ''));
        var role = roleOf(n.m);
        box.textContent = '';
        var strong = document.createElement('strong');
        strong.textContent = parts[0];
        box.appendChild(strong);
        var rest = document.createElement('span');
        rest.textContent = '  ' + parts.slice(1).join('  ·  ') +
            (n.i ? '  ·  inlined' : '') +
            '\n' + pct(n.v, root).toFixed(1) + '% of the call (≈ ' + fmtMs(fracMs(n.v, root)) + ' per call)' +
            '  ·  self ' + pct(n.s, root).toFixed(1) + '% (≈ ' + fmtMs(fracMs(n.s, root)) + ')  ·  ' + ROLE[role].name;
        box.appendChild(rest);
    }

    function renderFlame() {
        var card = $('spd-hot-card');
        var sp = state.summary && state.summary.sampling;
        if (!sp || !sp.tree || !sp.tree.v) { card.hidden = true; return; }
        card.hidden = false;

        var host = $('spd-flame');
        var root = state.zoom || sp.tree;
        var W = Math.max(320, host.clientWidth || 640);
        var rows = [];

        function place(node, depth, x, w) {
            if (depth >= FLAME_MAX_ROWS) return;
            rows.push({ n: node, depth: depth, x: x, w: w });
            var cx = x;
            (node.c || []).forEach(function (ch) {
                var cw = w * (ch.v / (node.v || 1));
                if (cw >= MIN_BAR_PX) place(ch, depth + 1, cx, cw);
                cx += cw;
            });
        }
        place(root, 0, 0, W);

        var maxDepth = 0;
        rows.forEach(function (r) { if (r.depth > maxDepth) maxDepth = r.depth; });
        var H = (maxDepth + 1) * FLAME_ROW + 2;
        var svg = el('svg', { width: W, height: H, role: 'img' });

        rows.forEach(function (r) {
            var n = r.n;
            var isTop = r.depth === 0;
            var role = n.n === '(other)' ? 'other' : (isTop && root === sp.tree ? 'other' : roleOf(n.m));
            var color = isTop && root === sp.tree ? '#4a5266' : ROLE[role].color;
            var y = r.depth * FLAME_ROW;
            var g = el('g', { style: 'cursor:pointer' });
            g.appendChild(el('rect', {
                x: r.x.toFixed(2), y: y, width: Math.max(0.5, r.w - 1).toFixed(2), height: FLAME_ROW - 1,
                rx: 2, fill: color, 'fill-opacity': n.n === '(other)' ? 0.5 : (n.i ? 0.72 : 0.92)
            }));
            var label = isTop && root === sp.tree ? 'all calls (100%)' : nodeLabel(n);
            var chars = Math.floor((r.w - 8) / 6.3);
            if (chars >= 3) {
                var shown = label.length > chars ? label.slice(0, Math.max(1, chars - 1)) + '…' : label;
                g.appendChild(text(r.x + 4, y + 14, shown, {
                    fill: '#fff', 'font-size': '11', 'font-family': 'Inter, sans-serif',
                    'pointer-events': 'none'
                }));
            }
            g.addEventListener('pointerenter', function () { setFlameDetail(n, root); });
            g.addEventListener('click', function () {
                if (isTop) { state.zoom = null; }
                else if (n.n !== '(other)') { state.zoom = n; }
                renderFlame();
            });
            svg.appendChild(g);
        });

        host.textContent = '';
        host.appendChild(svg);
        host.onpointerleave = function () { setFlameDetail(null, root); };

        var items = Object.keys(ROLE).map(function (k) { return { name: ROLE[k].name, color: ROLE[k].color, swatch: true }; });
        V.renderLegend('spd-legend-flame', items, state.zoom
            ? 'zoomed: click the top bar to reset'
            : (sp.coverage < 0.85 ? 'sampler saw ' + Math.round(sp.coverage * 100) + '% of the call time' : null));
        setFlameDetail(null, root);
    }

    // --- Module breakdown ---------------------------------------------------------------------------------------

    function renderModules() {
        var card = $('spd-modules-card');
        var sp = state.summary && state.summary.sampling;
        if (!sp || !sp.modules || !sp.modules.length || !sp.tree.v) { card.hidden = true; return; }
        card.hidden = false;
        var total = sp.modules.reduce(function (a, m) { return a + m.self; }, 0) || 1;
        var bar = $('spd-module-bar');
        bar.textContent = '';
        var track = document.createElement('div');
        track.className = 'module-track';
        sp.modules.forEach(function (m) {
            var share = m.self / total * 100;
            var seg = document.createElement('div');
            seg.className = 'module-seg';
            seg.style.width = share + '%';
            seg.style.background = ROLE[roleOf(m.name)].color;
            seg.title = m.name + ': ' + share.toFixed(1) + '%';
            if (share >= 9) seg.textContent = m.name.replace(/\.dll$/i, '') + ' ' + Math.round(share) + '%';
            track.appendChild(seg);
        });
        bar.appendChild(track);

        var legend = document.createElement('div');
        legend.className = 'module-legend';
        sp.modules.forEach(function (m) {
            var item = document.createElement('span');
            item.className = 'legend-item';
            var key = document.createElement('span');
            key.className = 'legend-key swatch';
            key.style.background = ROLE[roleOf(m.name)].color;
            item.appendChild(key);
            item.appendChild(V.span('', m.name));
            item.appendChild(V.span('legend-value', (m.self / total * 100).toFixed(1) + '%  ·  ' +
                fmtMs(fracMsSelf(m.self, sp, total))));
            legend.appendChild(item);
        });
        bar.appendChild(legend);
        V.renderLegend('spd-legend-modules', []);
    }

    function fracMsSelf(v, sp, total) {
        return total ? (v / total) * sp.sampled_avg_ms : 0;
    }

    // --- Hottest functions ---------------------------------------------------------------------------------------------

    window.setSpeedSort = function (which) {
        state.sort = which;
        $('spd-sort-self').classList.toggle('is-on', which === 'self');
        $('spd-sort-incl').classList.toggle('is-on', which === 'incl');
        renderTop();
    };

    function renderTop() {
        var card = $('spd-top-card');
        var sp = state.summary && state.summary.sampling;
        if (!sp || !sp.flat || !sp.flat.length || !sp.tree.v) { card.hidden = true; return; }
        card.hidden = false;
        var key = state.sort;
        var total = sp.tree.v;
        var rows = sp.flat.slice().sort(function (a, b) { return b[key] - a[key]; })
            .filter(function (f) { return f[key] > 0; }).slice(0, 15);
        var body = $('spd-top-body');
        body.textContent = '';
        rows.forEach(function (f) {
            var tr = document.createElement('tr');

            var tdName = document.createElement('td');
            tdName.className = 'hot-name';
            var dot = document.createElement('span');
            dot.className = 'role-dot';
            dot.style.background = ROLE[roleOf(f.module)].color;
            tdName.appendChild(dot);
            var nm = document.createElement('span');
            nm.textContent = f.name;
            nm.title = f.name;
            tdName.appendChild(nm);
            tr.appendChild(tdName);

            var share = f[key] / total * 100;
            var tdShare = document.createElement('td');
            tdShare.className = 'hot-share';
            var meter = document.createElement('span');
            meter.className = 'hot-meter';
            var fill = document.createElement('span');
            fill.style.width = Math.min(100, share) + '%';
            fill.style.background = ROLE[roleOf(f.module)].color;
            meter.appendChild(fill);
            tdShare.appendChild(meter);
            tdShare.appendChild(V.span('', share.toFixed(1) + '%'));
            tr.appendChild(tdShare);

            var tdMs = document.createElement('td');
            tdMs.textContent = fmtMs(f[key] / total * sp.sampled_avg_ms);
            tr.appendChild(tdMs);

            var tdLoc = document.createElement('td');
            tdLoc.className = 'hot-loc';
            tdLoc.textContent = f.file ? V.baseName(f.file) + (f.line ? ':' + f.line : '') : f.module;
            tdLoc.title = f.file || f.module;
            tr.appendChild(tdLoc);
            body.appendChild(tr);
        });
    }

    // --- Details ----------------------------------------------------------------------------------------------------------------

    function renderDetails() {
        var host = $('spd-details');
        host.textContent = '';
        var st = state.start || {};
        var sum = state.summary;
        V.detailRow(host, 'Timed calls', fmtInt(state.calls.length) + ' of ' + fmtInt(state.planned) +
            ' (warmup ' + fmtInt(state.warmup) + ')');
        V.detailRow(host, 'DLL load time', st.load_ms !== undefined ? fmtMs(st.load_ms) : '--');
        V.detailRow(host, 'Input payload', st.input_bytes ? fmtInt(st.input_bytes) + ' chars' : '--');
        if (st.symbols && st.symbols.state) {
            V.detailRow(host, 'Symbols', st.symbols.state + (st.symbols.pdb ? ' · ' + st.symbols.pdb : ''));
        }
        var sp = sum && sum.sampling;
        if (sp) {
            V.detailRow(host, 'Sampled calls', fmtInt(sp.sampled_calls) + ' (avg ' + fmtMs(sp.sampled_avg_ms) + ')');
            V.detailRow(host, 'Samples in the DLL', fmtInt(sp.samples_in_dll) + ' of ' + fmtInt(sp.samples_total));
            V.detailRow(host, 'Sampling interval',
                (sp.interval_us / 1000).toFixed(2) + ' ms requested · ' +
                (sp.achieved_interval_us / 1000).toFixed(2) + ' ms achieved');
            V.detailRow(host, 'Thread paused per sample', sp.avg_suspend_us.toFixed(0) + ' µs');
            V.detailRow(host, 'Sample coverage', Math.round(sp.coverage * 100) + '% of the call time');
            V.detailRow(host, 'Stack walk failures', fmtInt(sp.walk_failures));
        }
    }

    // --- CSV -------------------------------------------------------------------------------------------------------------------------

    function download(name, body) {
        var blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    }

    function csvCell(v) {
        v = String(v === undefined || v === null ? '' : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }

    window.downloadSpeedCsv = function () {
        if (!state.calls.length) { alert('Run a speed profile first.'); return; }
        var fn = document.getElementById('func-name').value || 'dll';
        var lines = ['call,is_warmup,wall_ms,cpu_ms'];
        state.calls.forEach(function (c, i) {
            lines.push([i + 1, i < state.warmup ? 1 : 0, c.ms, c.cpu].join(','));
        });
        download(fn + '_speed_calls.csv', lines.join('\n'));
        var sp = state.summary && state.summary.sampling;
        if (sp && sp.flat && sp.flat.length) {
            var h = ['function,module,file,line,self_samples,inclusive_samples,self_pct,inclusive_pct,self_ms_per_call,inclusive_ms_per_call'];
            sp.flat.forEach(function (f) {
                var t = sp.tree.v || 1;
                h.push([csvCell(f.name), csvCell(f.module), csvCell(f.file), f.line, f.self, f.incl,
                    (f.self / t * 100).toFixed(2), (f.incl / t * 100).toFixed(2),
                    (f.self / t * sp.sampled_avg_ms).toFixed(4), (f.incl / t * sp.sampled_avg_ms).toFixed(4)].join(','));
            });
            setTimeout(function () { download(fn + '_speed_hotspots.csv', h.join('\n')); }, 250);
        }
    };

    // --- Render orchestration ------------------------------------------------------------------------------------------------------------

    function renderAll() {
        if (!state.calls.length && !state.summary) return;
        renderBanner();
        renderNotes();
        renderHero();
        renderStats();
        renderCallsChart();
        renderFlame();
        renderModules();
        renderTop();
        renderDetails();
    }

    var renderTimer = null, renderFrame = null;

    function queueRender() {
        if (state.renderQueued) return;
        var wait = Math.max(0, 120 - (Date.now() - state.lastRender));
        state.renderQueued = true;
        renderTimer = setTimeout(function () {
            renderTimer = null;
            renderFrame = requestAnimationFrame(function () {
                renderFrame = null;
                state.renderQueued = false;
                state.lastRender = Date.now();
                renderAll();
            });
        }, wait);
    }

    function cancelQueuedRender() {
        if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
        if (renderFrame !== null) { cancelAnimationFrame(renderFrame); renderFrame = null; }
        state.renderQueued = false;
    }

    // --- Status helpers ---------------------------------------------------------------------------------------------------------------------

    function setBadge(cls, msg) {
        var b = $('spd-badge');
        b.className = 'status-badge' + (cls ? ' ' + cls : '');
        b.textContent = msg;
    }

    function setProgress(msg, pct) {
        $('spd-progress-text').textContent = msg;
        $('spd-progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    function setRunning(on) {
        state.running = on;
        $('spd-run-btn').disabled = on;
        $('spd-run-btn').querySelector('.btn-text').style.display = on ? 'none' : 'inline';
        $('spd-loader').style.display = on ? 'inline-block' : 'none';
        $('spd-cancel-btn').style.display = on ? 'inline-flex' : 'none';
    }

    function totalCalls() {
        return state.planned + (state.sampling ? state.sampleCalls : 0);
    }

    function showFailure(title, message, extra) {
        cancelQueuedRender();
        state.finished = true;
        setBadge('error', 'Failed');
        $('spd-results').hidden = false;
        $('spd-empty').hidden = true;
        $('spd-body').hidden = !state.calls.length;
        if (state.calls.length) renderAll();
        $('spd-banner').className = 'verdict-banner verdict-leak';
        $('spd-banner-icon').textContent = '✕';
        $('spd-banner-title').textContent = title;
        $('spd-banner-detail').textContent = message;
        $('spd-notes').textContent = '';
        $('spd-logs').hidden = !extra;
        $('spd-logs-body').textContent = extra || '';
    }

    // --- The run ----------------------------------------------------------------------------------------------------------------------------------

    function handleEvent(ev) {
        if (ev.event === 'start') {
            state.start = ev;
            state.planned = ev.iterations;
            state.warmup = ev.warmup;
            state.sampling = !!ev.sample;
            state.sampleCalls = ev.sample_calls || 0;
            setBadge('running', 'Timing');
            return;
        }
        if (ev.event === 'phase') {
            state.phase = ev.phase;
            setBadge('running', ev.phase === 'sampling' ? 'Sampling' : 'Timing');
            queueRender();
            return;
        }
        if (ev.event === 'iter') {
            if (ev.phase === 'sampling') {
                state.sampleDone = ev.i;
                setProgress('Sampling call ' + ev.i + ' of ' + state.sampleCalls,
                    (state.planned + ev.i) / totalCalls() * 100);
            } else {
                state.calls.push({ ms: ev.ms, cpu: ev.cpu_ms || 0 });
                $('spd-results').hidden = false;
                $('spd-empty').hidden = true;
                setProgress('Timing call ' + ev.i + ' of ' + state.planned, ev.i / totalCalls() * 100);
            }
            queueRender();
            return;
        }
        if (ev.event === 'done') { state.summary = ev.summary; state.logs = ev.logs || ''; return; }
        if (ev.event === 'error') {
            state.error = ev.message; state.logs = ev.logs || ''; state.trace = ev.traceback || '';
            return;
        }
        if (ev.event === 'exit') { state.exit = ev; }
    }

    function consume(line) {
        try { handleEvent(JSON.parse(line)); } catch (e) { state.noise.push(line); }
    }

    function pump(reader) {
        var decoder = new TextDecoder();
        var buf = '';
        function step() {
            return reader.read().then(function (r) {
                if (r.done) { if (buf.trim()) consume(buf.trim()); return; }
                buf += decoder.decode(r.value, { stream: true });
                var nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    var line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line) consume(line);
                }
                return step();
            });
        }
        return step();
    }

    function finishRun() {
        cancelQueuedRender();
        state.finished = true;
        var noise = state.noise.join('\n').trim();
        if (!state.summary) {
            var done = state.calls.length;
            var code = state.exit ? state.exit.returncode : null;
            var msg = state.error
                ? 'The DLL call failed after ' + done + ' calls: ' + state.error.replace(/[.\s]+$/, '') + '.'
                : 'The profile runner exited after ' + done + ' calls' + (code !== null ? ' (exit code ' + code + ')' : '') + '.';
            var extra = [state.trace, state.exit && state.exit.stderr, state.logs, noise].filter(Boolean).join('\n\n');
            showFailure(done ? 'Run ended early' : 'Speed profile failed', msg, extra);
            setProgress(done ? 'Stopped at call ' + done : 'Failed', 0);
            return;
        }
        $('spd-body').hidden = false;
        setBadge('success', 'Done');
        setProgress('Done · ' + state.calls.length + ' timed calls' +
            (state.summary.sampling ? ' + ' + state.summary.sampling.sampled_calls + ' sampled' : ''), 100);
        renderAll();
        var logs = [state.logs, noise].filter(Boolean).join('\n\n');
        $('spd-logs').hidden = !logs;
        $('spd-logs-body').textContent = logs;
    }

    window.runSpeedProfile = function () {
        if (state.running) return;
        var dllPath = document.getElementById('dll-path').value;
        var jsonPath = document.getElementById('json-path').value;
        var funcName = document.getElementById('func-name').value;
        if (!dllPath || !jsonPath || !funcName) {
            alert('Set the DLL path, input JSON path and function name in Configuration first.');
            return;
        }
        var iterations = parseInt($('spd-iterations').value, 10);
        var warmup = parseInt($('spd-warmup').value, 10);
        var sampleCalls = parseInt($('spd-sample-calls').value, 10);
        var intervalMs = parseFloat($('spd-interval').value);
        var sample = $('spd-sample').checked;
        if (!(iterations >= 1) || iterations > 10000) { alert('Iterations must be a whole number between 1 and 10000.'); return; }
        if (!(warmup >= 0) || warmup >= iterations) { alert('Warmup must be 0 or more, and fewer than the iteration count.'); return; }
        if (sample) {
            if (!(sampleCalls >= 1) || sampleCalls > 10000) { alert('Sampled calls must be between 1 and 10000.'); return; }
            if (!(intervalMs >= 0.2) || intervalMs > 100) { alert('Interval must be between 0.2 and 100 ms.'); return; }
        }
        saveConfig();

        state.calls = []; state.sampleDone = 0; state.phase = 'timing';
        state.summary = null; state.start = null; state.logs = ''; state.error = null; state.trace = '';
        state.exit = null; state.noise = []; state.finished = false; state.zoom = null;
        state.planned = iterations; state.warmup = warmup;
        state.sampling = sample; state.sampleCalls = sample ? sampleCalls : 0;
        $('spd-logs').hidden = true;
        $('spd-logs-body').textContent = '';
        $('spd-hot-card').hidden = true;
        $('spd-modules-card').hidden = true;
        $('spd-top-card').hidden = true;
        $('spd-body').hidden = false;
        setRunning(true);
        setBadge('running', 'Starting');
        setProgress('Loading DLL in a fresh process…', 0);

        state.controller = new AbortController();
        fetch('/api/speed_profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dll_path: dllPath,
                json_path: jsonPath,
                function_name: funcName,
                arg_type: document.getElementById('arg-type').value,
                res_type: document.getElementById('res-type').value,
                iterations: iterations,
                warmup: warmup,
                free_mode: $('prof-free-mode') ? $('prof-free-mode').value : 'none',
                sample: sample,
                sample_calls: sampleCalls,
                interval_us: Math.round(intervalMs * 1000),
                pdb_path: window.FnpSymbols ? window.FnpSymbols.path() : ''
            }),
            signal: state.controller.signal
        }).then(function (res) {
            if (!res.ok) throw new Error('Server returned HTTP ' + res.status);
            if (!res.body) throw new Error('This browser cannot stream the response.');
            return pump(res.body.getReader());
        }).then(function () {
            finishRun();
        }).catch(function (err) {
            if (err && err.name === 'AbortError') {
                cancelQueuedRender();
                state.finished = true;
                setBadge('', 'Cancelled');
                setProgress('Cancelled after ' + state.calls.length + ' calls', 0);
                renderAll();
            } else {
                showFailure('Speed profile failed', err && err.message ? err.message : String(err));
            }
        }).then(function () {
            setRunning(false);
            state.controller = null;
        });
    };

    window.cancelSpeedProfile = function () {
        fetch('/api/profile_cancel', { method: 'POST' }).catch(function () { });
        if (state.controller) state.controller.abort();
    };

    // --- Config persistence ------------------------------------------------------------------------------------------------------------------------

    var FIELDS = ['spd-iterations', 'spd-warmup', 'spd-sample-calls', 'spd-interval'];

    function saveConfig() {
        try {
            FIELDS.forEach(function (id) { localStorage.setItem('fnp_' + id, $(id).value); });
            localStorage.setItem('fnp_spd-sample', $('spd-sample').checked ? '1' : '0');
        } catch (e) { /* private mode */ }
    }

    function loadConfig() {
        try {
            FIELDS.forEach(function (id) {
                var v = localStorage.getItem('fnp_' + id);
                if (v !== null && v !== '') $(id).value = v;
            });
            var s = localStorage.getItem('fnp_spd-sample');
            if (s !== null) $('spd-sample').checked = s === '1';
        } catch (e) { /* ignore */ }
    }

    function syncSampleFields() {
        var on = $('spd-sample').checked;
        ['spd-sample-calls', 'spd-interval'].forEach(function (id) { $(id).disabled = !on; });
    }

    window.addEventListener('load', function () {
        loadConfig();
        syncSampleFields();
        FIELDS.concat(['spd-sample']).forEach(function (id) { $(id).addEventListener('change', saveConfig); });
        $('spd-sample').addEventListener('change', syncSampleFields);

        // Charts are drawn at real pixel widths, so a width change needs a redraw.
        if (window.ResizeObserver) {
            var lastW = 0;
            var ro = new ResizeObserver(function (entries) {
                var w = entries[0].contentRect.width;
                if (Math.abs(w - lastW) < 8) return;
                lastW = w;
                if (state.calls.length) queueRender();
            });
            var panel = document.querySelector('.speed-panel');
            if (panel) ro.observe(panel);
        }
    });
})();
