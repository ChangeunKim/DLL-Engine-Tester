/* ==========================================================================
   Memory Profiler front end

   Streams NDJSON samples from /api/profile and draws them as they land. Charts
   are hand-rolled inline SVG - no chart library - so the tool keeps working
   with no network access.

   Color roles come from the CSS custom properties on .profile-panel, which hold
   the validated data-viz palette stepped for the #0f111a terminal surface. One
   entity keeps one hue across all three charts: private bytes = blue,
   working set = orange, transient = aqua.
   ========================================================================== */

(function () {
    'use strict';

    // --- Palette (mirrors the CSS custom properties on .profile-panel) ------
    var VIZ = {
        private: '#3987e5',
        rss: '#d95926',
        transient: '#199e70',
        live: '#a78bfa',       // live heap allocations
        commit: '#7c879c',     // heap committed (a quieter companion series)
        retained: '#e66767',   // diverging: positive delta
        released: '#3987e5',   // diverging: negative delta
        grid: '#232735',
        axis: '#333846',
        ink: '#f8fafc',
        inkMuted: '#8b93a5',
        surface: '#0f111a'
    };

    // padB fits two stacked rows: the tick numbers, then the axis title
    var GEO = { padL: 68, padR: 20, padT: 12, padB: 44, plotH: 190 };
    var MAX_LINE_PTS = 2000;   // stride-sample longer runs; the path stays smooth
    var MIN_BAR_PX = 6;        // a column plus its 2px surface gap needs this much
    var MIN_PT_PX = 2;         // a line vertex can sit this close and still read

    var VERDICTS = {
        clean: {
            cls: 'verdict-clean', icon: '✓', title: 'No leak detected',
            detail: 'Retained memory is flat across the measured calls. The DLL gives back what it takes.'
        },
        suspect: {
            cls: 'verdict-suspect', icon: '!', title: 'Possible leak',
            detail: 'Memory grows, but not linearly enough to be conclusive. Re-run with more iterations to separate a real leak from heap arena growth.'
        },
        leak: {
            cls: 'verdict-leak', icon: '✕', title: 'Leak detected',
            detail: 'Retained memory grows consistently with every call. Each call keeps memory it never releases.'
        },
        insufficient: {
            cls: 'verdict-unknown', icon: '?', title: 'Not enough data',
            detail: 'Too few measured calls after warmup to fit a trend. Raise the iteration count.'
        }
    };

    // --- Run state ----------------------------------------------------------
    var state = {
        running: false,
        controller: null,
        start: null,        // the "start" event
        samples: [],        // one entry per completed call
        summary: null,
        logs: '',
        noise: [],          // any non-JSON lines the runner leaked
        planned: 0,
        warmup: 0,
        hover: null,
        tableOpen: false,
        renderQueued: false,
        lastRender: 0,
        finished: false
    };

    var charts = [];        // registered chart instances, for synced hover

    function $(id) { return document.getElementById(id); }

    /* HeapSummary may be unreadable (the start event then carries no heap baseline);
       every heap-derived view hides itself in that case instead of drawing zeros. */
    function hasHeap() {
        return !!(state.start && state.start.baseline_heap);
    }

    // --- Formatting ---------------------------------------------------------

    function unitFor(maxAbs) {
        if (maxAbs >= 1073741824) return { d: 1073741824, s: 'GB' };
        if (maxAbs >= 1048576) return { d: 1048576, s: 'MB' };
        if (maxAbs >= 1024) return { d: 1024, s: 'KB' };
        return { d: 1, s: 'B' };
    }

    function fmtBytes(n, signed) {
        if (n === null || n === undefined || isNaN(n)) return '--';
        var sign = n < 0 ? '−' : (signed && n > 0 ? '+' : '');
        var v = Math.abs(n);
        var u = unitFor(v);
        v = v / u.d;
        var dp = u.d === 1 ? 0 : (v < 10 ? 2 : (v < 100 ? 1 : 0));
        return sign + v.toFixed(dp) + ' ' + u.s;
    }

    function fmtInt(n) {
        if (n === null || n === undefined || isNaN(n)) return '--';
        return Math.round(n).toLocaleString('en-US');
    }

    function fmtMs(ms) {
        if (ms === null || ms === undefined || isNaN(ms)) return '--';
        if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
        if (ms >= 1) return ms.toFixed(1) + ' ms';
        return ms.toFixed(3) + ' ms';
    }

    // --- Scales -------------------------------------------------------------

    function niceStep(raw) {
        var mag = Math.pow(10, Math.floor(Math.log10(raw)));
        var norm = raw / mag;
        var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
        return mult * mag;
    }

    /* Nice ticks chosen in the axis's own display unit, so labels read as
       "12.50 MB / 12.75 MB" instead of decimal-nice-but-ugly byte counts. */
    function byteScale(lo, hi, target) {
        var u = unitFor(Math.max(Math.abs(lo), Math.abs(hi), 1));
        var loU = lo / u.d, hiU = hi / u.d;
        if (!(hiU > loU)) { hiU = loU + 1; }
        var step = niceStep((hiU - loU) / (target || 4));
        var min = Math.floor(loU / step) * step;
        var max = Math.ceil(hiU / step) * step;
        var ticks = [];
        for (var v = min; v <= max + step * 1e-9; v += step) ticks.push(v);
        // Enough decimals to state the step exactly: a 0.25 step must print
        // "0.25", not a rounded "0.3" that misnames where the gridline sits.
        var dp = 0;
        while (dp < 3 && Math.abs(parseFloat(step.toFixed(dp)) - step) > step * 1e-6) dp++;
        return {
            min: min * u.d,
            max: max * u.d,
            ticks: ticks,
            unit: u,
            label: function (tU) { return tU.toFixed(dp) + ' ' + u.s; }
        };
    }

    // --- Statistics ---------------------------------------------------------

    /* Least squares over evenly spaced samples. Mirrors linreg() in
       runner_profile.py so the live trendline matches the final verdict.
       r2 is null when the samples have no variance at all - a dead-flat series
       has nothing for a fit to explain, and reporting "1.000" there would read
       as a perfect leak trend when the truth is no trend. */
    function linreg(ys, x0) {
        var n = ys.length;
        if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, r2: null };
        var mx = x0 + (n - 1) / 2, my = 0, i;
        for (i = 0; i < n; i++) my += ys[i];
        my /= n;
        var sxx = 0, sxy = 0, syy = 0, dx, dy;
        for (i = 0; i < n; i++) {
            dx = (x0 + i) - mx; dy = ys[i] - my;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
        if (sxx === 0) return { slope: 0, intercept: my, r2: null };
        var slope = sxy / sxx;
        var intercept = my - slope * mx;
        if (syy <= 0) return { slope: slope, intercept: intercept, r2: null };
        var res = 0;
        for (i = 0; i < n; i++) {
            var e = ys[i] - (slope * (x0 + i) + intercept);
            res += e * e;
        }
        return {
            slope: slope, intercept: intercept,
            r2: Math.max(0, Math.min(1, 1 - res / syy))
        };
    }

    function fmtR2(r2) {
        return (r2 === null || r2 === undefined) ? 'n/a' : r2.toFixed(4);
    }

    // --- SVG helpers --------------------------------------------------------

    var SVG_NS = 'http://www.w3.org/2000/svg';

    function el(name, attrs) {
        var node = document.createElementNS(SVG_NS, name);
        if (attrs) {
            for (var k in attrs) {
                if (attrs[k] !== null && attrs[k] !== undefined) {
                    node.setAttribute(k, attrs[k]);
                }
            }
        }
        return node;
    }

    function text(x, y, str, attrs) {
        var node = el('text', attrs || {});
        node.setAttribute('x', x);
        node.setAttribute('y', y);
        node.textContent = str;   // untrusted values never go through innerHTML
        return node;
    }

    /* Column with a 4px rounded data-end and a square foot on the baseline. */
    function barPath(x, y, w, h, up) {
        var r = Math.min(4, w / 2, h);
        if (r <= 0.5) return 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'Z';
        if (up) {
            return 'M' + x + ' ' + (y + h) +
                'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
                'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) +
                'V' + (y + h) + 'Z';
        }
        return 'M' + x + ' ' + y +
            'V' + (y + h - r) + 'Q' + x + ' ' + (y + h) + ' ' + (x + r) + ' ' + (y + h) +
            'H' + (x + w - r) + 'Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w) + ' ' + (y + h - r) +
            'V' + y + 'Z';
    }

    // --- Chart frame (grid, axes, warmup band, hover overlay) ---------------

    /* opts.xLabelFor(slot) maps a plotted slot back to the call number it stands
       for. Charts that group calls into columns MUST supply it, or the axis would
       label bucket indices while claiming to show call numbers.
       opts.warmupSlots is the same offset expressed in slots.
       opts.bandInset pulls the first and last positions inward by that many
       pixels - column charts need it so a bar centred on the first slot does not
       hang over the y-axis labels. Lines pass 0 and touch both edges. */
    function makeFrame(host, n, yScale, opts) {
        opts = opts || {};
        var xLabelFor = opts.xLabelFor || function (i) { return String(i + 1); };
        var warmupSlots = opts.warmupSlots === undefined ? state.warmup : opts.warmupSlots;
        var inset = opts.bandInset || 0;

        var W = Math.max(320, host.clientWidth || 640);
        var H = GEO.padT + GEO.plotH + GEO.padB;
        var x0 = GEO.padL, x1 = W - GEO.padR;
        var ix0 = x0 + inset, ix1 = x1 - inset;
        var svg = el('svg', { width: W, height: H, role: 'img' });

        function xAt(i) {
            if (n <= 1) return (ix0 + ix1) / 2;
            return ix0 + (ix1 - ix0) * (i / (n - 1));
        }
        // Inverse of xAt, so the hover layer works whatever the scale
        function iAt(px) {
            if (n <= 1) return 0;
            var span = (ix1 - ix0) || 1;
            return Math.max(0, Math.min(n - 1, Math.round((px - ix0) / span * (n - 1))));
        }
        function yAt(v) {
            var span = yScale.max - yScale.min || 1;
            return GEO.padT + GEO.plotH - (v - yScale.min) / span * GEO.plotH;
        }

        // Warmup band: excluded from the regression, so mark it rather than hide it
        if (warmupSlots > 0 && n > 0) {
            var half = n > 1 ? (xAt(1) - xAt(0)) / 2 : (x1 - x0) / 2;
            var bandEnd = Math.min(xAt(Math.min(warmupSlots, n) - 1) + half, x1);
            svg.appendChild(el('rect', {
                x: x0, y: GEO.padT, width: Math.max(0, bandEnd - x0), height: GEO.plotH,
                fill: 'rgba(255,255,255,0.035)'
            }));
            if (bandEnd - x0 > 46) {
                svg.appendChild(text(x0 + 6, GEO.padT + 13, 'warmup', {
                    fill: VIZ.inkMuted, 'font-size': '10', 'font-family': 'Inter, sans-serif'
                }));
            }
        }

        // Gridlines: solid hairlines one step off the surface, recessive
        yScale.ticks.forEach(function (tU) {
            var v = tU * yScale.unit.d, y = yAt(v);
            if (y < GEO.padT - 0.5 || y > GEO.padT + GEO.plotH + 0.5) return;
            svg.appendChild(el('line', {
                x1: x0, y1: y, x2: x1, y2: y, stroke: VIZ.grid, 'stroke-width': 1
            }));
            svg.appendChild(text(x0 - 9, y + 3.5, yScale.label(tU), {
                fill: VIZ.inkMuted, 'font-size': '10.5', 'text-anchor': 'end',
                'font-family': 'Inter, sans-serif', 'font-variant-numeric': 'tabular-nums'
            }));
        });

        // X axis ticks at clean call numbers
        svg.appendChild(el('line', {
            x1: x0, y1: GEO.padT + GEO.plotH, x2: x1, y2: GEO.padT + GEO.plotH,
            stroke: VIZ.axis, 'stroke-width': 1
        }));
        var want = Math.max(2, Math.min(8, Math.floor((x1 - x0) / 90)));
        var slotStep = Math.max(1, Math.round(n / want));
        var slots = [];
        for (var s = 0; s < n - 1; s += slotStep) slots.push(s);
        slots.push(n - 1);
        // Drop a penultimate tick that would crowd the final one
        if (slots.length > 2 && xAt(slots[slots.length - 1]) - xAt(slots[slots.length - 2]) < 44) {
            slots.splice(slots.length - 2, 1);
        }
        slots.forEach(function (slot) {
            svg.appendChild(text(Math.round(xAt(slot)), GEO.padT + GEO.plotH + 17,
                xLabelFor(slot), {
                    fill: VIZ.inkMuted, 'font-size': '10.5', 'text-anchor': 'middle',
                    'font-family': 'Inter, sans-serif', 'font-variant-numeric': 'tabular-nums'
                }));
        });
        svg.appendChild(text((x0 + x1) / 2, H - 6, 'call number', {
            fill: VIZ.inkMuted, 'font-size': '10', 'text-anchor': 'middle',
            'font-family': 'Inter, sans-serif'
        }));

        return { svg: svg, W: W, H: H, x0: x0, x1: x1, xAt: xAt, iAt: iAt, yAt: yAt, n: n };
    }

    /* Crosshair + tooltip. The overlay is the hit target, so the reader aims at a
       call number rather than at a 2px line, and arrow keys do the same job.

       Hover is published in CALL space, not slot space, because the charts do not
       all plot the same number of slots - grouped charts hold ~150 columns for
       1200 calls. Each chart converts with its own slotFor/callFor, so pointing at
       call 800 highlights call 800 everywhere instead of falling off the short
       charts' ends. */
    function attachHover(chart, frame, host, tip, rowsFor, map) {
        var slotFor = (map && map.slotFor) || function (c) { return c; };
        var callFor = (map && map.callFor) || function (s) { return s; };

        var cross = el('line', {
            y1: GEO.padT, y2: GEO.padT + GEO.plotH,
            stroke: 'rgba(255,255,255,0.28)', 'stroke-width': 1, visibility: 'hidden'
        });
        frame.svg.appendChild(cross);

        var overlay = el('rect', {
            x: frame.x0, y: GEO.padT, width: Math.max(0, frame.x1 - frame.x0),
            height: GEO.plotH, fill: 'transparent', style: 'cursor:crosshair'
        });
        frame.svg.appendChild(overlay);

        function callAt(clientX) {
            var box = host.getBoundingClientRect();
            return callFor(frame.iAt(clientX - box.left));
        }

        overlay.addEventListener('pointermove', function (e) { setHover(callAt(e.clientX)); });
        overlay.addEventListener('pointerdown', function (e) { setHover(callAt(e.clientX)); });
        overlay.addEventListener('pointerleave', function () { setHover(null); });

        /* Host-level listeners bind ONCE. renderAll() runs on every streamed
           sample and on resize; re-binding here would pile up handlers, each
           closing over a stale frame. The live frame is read from the host. */
        host.__vizFrame = frame;
        if (!host.__vizBound) {
            host.__vizBound = true;
            host.tabIndex = 0;
            host.setAttribute('role', 'application');
            host.addEventListener('keydown', function (e) {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                var last = state.samples.length - 1;
                if (last < 0) return;
                var cur = state.hover === null ? last : state.hover;
                setHover(Math.max(0, Math.min(last, cur + (e.key === 'ArrowRight' ? 1 : -1))));
            });
            host.addEventListener('focus', function () {
                if (state.hover === null && state.samples.length) {
                    setHover(state.samples.length - 1);
                }
            });
            host.addEventListener('blur', function () { setHover(null); });
        }

        chart.onHover = function (call) {
            var i = call === null ? null : slotFor(call);
            if (i === null || i < 0 || i >= frame.n) {
                cross.setAttribute('visibility', 'hidden');
                tip.classList.remove('visible');
                return;
            }
            var x = frame.xAt(i);
            cross.setAttribute('x1', x);
            cross.setAttribute('x2', x);
            cross.setAttribute('visibility', 'visible');

            var rows = rowsFor(i);
            tip.textContent = '';
            var head = document.createElement('div');
            head.className = 'tt-head';
            head.textContent = rows.head;
            tip.appendChild(head);
            rows.items.forEach(function (r) {
                var row = document.createElement('div');
                row.className = 'tt-row';
                var key = document.createElement('span');
                key.className = 'tt-key';
                key.style.background = r.color || 'transparent';
                var name = document.createElement('span');
                name.className = 'tt-name';
                name.textContent = r.name;
                var val = document.createElement('span');
                val.className = 'tt-val';
                val.textContent = r.value;
                row.appendChild(key);
                row.appendChild(name);
                row.appendChild(val);
                tip.appendChild(row);
            });

            tip.classList.add('visible');
            var tw = tip.offsetWidth || 170;
            var left = x + 14;
            if (left + tw > frame.W - 4) left = x - tw - 14;
            tip.style.left = Math.max(4, left) + 'px';
            tip.style.top = (GEO.padT + 6) + 'px';
        };
    }

    function setHover(i) {
        state.hover = i;
        charts.forEach(function (c) { if (c.onHover) c.onHover(i); });
    }

    function mountChart(hostId, tipId, frame) {
        var host = $(hostId);
        var tip = $(tipId);
        // Keep the tooltip node; replace only the previous svg
        var old = host.querySelector('svg');
        if (old) host.removeChild(old);
        host.insertBefore(frame.svg, tip);
        return { host: host, tip: tip };
    }

    // --- Downsampling -------------------------------------------------------

    /* Stride-sample a level series, always keeping the final value so the
       endpoint the reader sees is the endpoint that was measured. */
    function strideIdx(n, max) {
        if (n <= max) {
            var all = [];
            for (var i = 0; i < n; i++) all.push(i);
            return all;
        }
        var step = n / max, out = [];
        for (var k = 0; k < max; k++) out.push(Math.floor(k * step));
        if (out[out.length - 1] !== n - 1) out.push(n - 1);
        return out;
    }

    /* Slot <-> call mapping for a grouped chart, so synced hover keeps pointing
       at the same call no matter how many columns each chart drew. */
    function binMapper(bins) {
        return {
            callFor: function (slot) { return bins[slot][1]; },
            slotFor: function (call) {
                var lo = 0, hi = bins.length - 1;
                while (lo < hi) {
                    var mid = (lo + hi) >> 1;
                    if (call > bins[mid][1]) lo = mid + 1; else hi = mid;
                }
                return lo;
            }
        };
    }

    /* How many leading slots are entirely inside the warmup window, so the
       shaded band lands in the right place after calls are grouped. */
    function warmupSlotCount(bins) {
        var k = 0;
        while (k < bins.length && bins[k][1] < state.warmup) k++;
        return k;
    }

    /* Contiguous buckets, for aggregating deltas without losing their sum. */
    function buckets(n, max) {
        if (n <= max) {
            var one = [];
            for (var i = 0; i < n; i++) one.push([i, i]);
            return one;
        }
        var out = [], size = n / max;
        for (var k = 0; k < max; k++) {
            var a = Math.floor(k * size), b = Math.floor((k + 1) * size) - 1;
            if (b < a) b = a;
            if (b > n - 1) b = n - 1;
            out.push([a, b]);
        }
        return out;
    }

    // --- Chart 1: memory held after each call -------------------------------

    function renderHeldChart() {
        var host = $('prof-chart-held');
        var n = state.samples.length;
        if (!n || !host) return;

        var idx = strideIdx(n, MAX_LINE_PTS);
        var lo = Infinity, hi = -Infinity;
        state.samples.forEach(function (s) {
            lo = Math.min(lo, s.private, s.rss);
            hi = Math.max(hi, s.private, s.rss);
        });
        // A hair of headroom so the extreme never sits on the frame edge
        var pad = (hi - lo) * 0.12 || Math.max(1024, hi * 0.0005);
        var scale = byteScale(lo - pad, hi + pad, 4);
        var frame = makeFrame(host, n, scale);

        var fit = null;
        if (n - state.warmup >= 2) {
            var ys = state.samples.slice(state.warmup).map(function (s) { return s.private; });
            fit = linreg(ys, state.warmup);
        }

        // Trendline: an annotation, not a series - muted ink, dashed, drawn under
        if (fit) {
            var a = state.warmup, b = n - 1;
            svgAppendTrend(frame, fit, a, b);
        }

        [{ key: 'rss', color: VIZ.rss }, { key: 'private', color: VIZ.private }].forEach(function (s) {
            var d = '';
            idx.forEach(function (i, k) {
                d += (k ? 'L' : 'M') + frame.xAt(i).toFixed(1) + ' ' + frame.yAt(state.samples[i][s.key]).toFixed(1);
            });
            frame.svg.appendChild(el('path', {
                d: d, fill: 'none', stroke: s.color, 'stroke-width': 2,
                'stroke-linejoin': 'round', 'stroke-linecap': 'round'
            }));
            // End marker with a 2px surface ring, so it stays legible on a crossing
            var last = n - 1;
            frame.svg.appendChild(el('circle', {
                cx: frame.xAt(last), cy: frame.yAt(state.samples[last][s.key]), r: 4,
                fill: s.color, stroke: VIZ.surface, 'stroke-width': 2
            }));
        });

        // One direct label, on the extreme of the primary series
        // >= on purpose: a dead-flat series then labels its endpoint rather than
        // parking the label on call 1, where it reads as an arbitrary pick.
        var maxI = 0;
        for (var i = 1; i < n; i++) {
            if (state.samples[i].private >= state.samples[maxI].private) maxI = i;
        }
        placeExtremeLabel(frame, maxI, state.samples[maxI].private);

        var m = mountChart('prof-chart-held', 'prof-tip-held', frame);
        var chart = { id: 'held' };
        attachHover(chart, frame, m.host, m.tip, function (i) {
            var s = state.samples[i];
            return {
                head: 'Call ' + (i + 1) + (i < state.warmup ? ' (warmup)' : '') + ' of ' + state.planned,
                items: [
                    { name: 'Private bytes', color: VIZ.private, value: fmtBytes(s.private) },
                    { name: 'Working set', color: VIZ.rss, value: fmtBytes(s.rss) },
                    { name: 'Change vs previous', color: 'transparent', value: fmtBytes(s.delta, true) },
                    { name: 'Duration', color: 'transparent', value: fmtMs(s.ms) }
                ]
            };
        });
        charts.push(chart);

        var latest = state.samples[n - 1];
        renderLegend('prof-legend-held', [
            { name: 'Private bytes', color: VIZ.private, value: fmtBytes(latest.private) },
            { name: 'Working set', color: VIZ.rss, value: fmtBytes(latest.rss) },
            fit ? { name: 'Trend', color: null, dashed: true, value: fmtBytes(fit.slope, true) + '/call' } : null
        ]);
    }

    // --- Chart 0: live heap allocations vs committed heap -------------------------

    function renderHeapChart() {
        var card = $('prof-heap-card');
        var host = $('prof-chart-heap');
        var n = state.samples.length;
        if (!card || !host) return;
        if (!hasHeap()) { card.hidden = true; return; }
        card.hidden = false;
        if (!n) return;

        var idx = strideIdx(n, MAX_LINE_PTS);
        var lo = Infinity, hi = -Infinity;
        state.samples.forEach(function (s) {
            lo = Math.min(lo, s.live, s.commit);
            hi = Math.max(hi, s.live, s.commit);
        });
        var pad = (hi - lo) * 0.12 || Math.max(1024, hi * 0.0005);
        var scale = byteScale(lo - pad, hi + pad, 4);
        var frame = makeFrame(host, n, scale);

        var fit = null;
        if (n - state.warmup >= 2) {
            fit = linreg(state.samples.slice(state.warmup).map(function (s) { return s.live; }),
                state.warmup);
            svgAppendTrend(frame, fit, state.warmup, n - 1);
        }

        [{ key: 'commit', color: VIZ.commit, w: 1.5 }, { key: 'live', color: VIZ.live, w: 2 }].forEach(function (ser) {
            var d = '';
            idx.forEach(function (i, k) {
                d += (k ? 'L' : 'M') + frame.xAt(i).toFixed(1) + ' ' + frame.yAt(state.samples[i][ser.key]).toFixed(1);
            });
            frame.svg.appendChild(el('path', {
                d: d, fill: 'none', stroke: ser.color, 'stroke-width': ser.w,
                'stroke-linejoin': 'round', 'stroke-linecap': 'round'
            }));
            frame.svg.appendChild(el('circle', {
                cx: frame.xAt(n - 1), cy: frame.yAt(state.samples[n - 1][ser.key]), r: 4,
                fill: ser.color, stroke: VIZ.surface, 'stroke-width': 2
            }));
        });

        var maxI = 0;
        for (var i = 1; i < n; i++) {
            if (state.samples[i].live >= state.samples[maxI].live) maxI = i;
        }
        placeExtremeLabel(frame, maxI, state.samples[maxI].live);

        var m = mountChart('prof-chart-heap', 'prof-tip-heap', frame);
        var chart = { id: 'heap' };
        var base = state.start.baseline_heap.alloc;
        attachHover(chart, frame, m.host, m.tip, function (i) {
            var s = state.samples[i];
            var prev = i > 0 ? state.samples[i - 1].live : base;
            return {
                head: 'Call ' + (i + 1) + (i < state.warmup ? ' (warmup)' : '') + ' of ' + state.planned,
                items: [
                    { name: 'Live heap', color: VIZ.live, value: fmtBytes(s.live) },
                    { name: 'Committed heap', color: VIZ.commit, value: fmtBytes(s.commit) },
                    { name: 'Committed but free', color: 'transparent', value: fmtBytes(Math.max(0, s.commit - s.live)) },
                    { name: 'Live change', color: 'transparent', value: fmtBytes(s.live - prev, true) }
                ]
            };
        });
        charts.push(chart);

        var latest = state.samples[n - 1];
        renderLegend('prof-legend-heap', [
            { name: 'Live heap', color: VIZ.live, value: fmtBytes(latest.live) },
            { name: 'Committed', color: VIZ.commit, value: fmtBytes(latest.commit) },
            fit ? { name: 'Trend', color: null, dashed: true, value: fmtBytes(fit.slope, true) + '/call' } : null
        ]);
    }

    function svgAppendTrend(frame, fit, a, b) {
        var y1 = fit.slope * a + fit.intercept;
        var y2 = fit.slope * b + fit.intercept;
        frame.svg.appendChild(el('line', {
            x1: frame.xAt(a), y1: frame.yAt(y1), x2: frame.xAt(b), y2: frame.yAt(y2),
            stroke: VIZ.inkMuted, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
            'stroke-linecap': 'round'
        }));
    }

    /* Only render the label if it fits inside the plot with padding - a clipped
       label is worse than none, and the value stays in the tooltip and table. */
    function placeExtremeLabel(frame, i, value) {
        var label = fmtBytes(value);
        var w = label.length * 6.2 + 10;
        var x = frame.xAt(i), y = frame.yAt(value) - 12;
        var anchor = 'middle';
        if (x + w / 2 > frame.x1) { anchor = 'end'; x -= 7; }
        else if (x - w / 2 < frame.x0) { anchor = 'start'; x += 7; }
        if (y < GEO.padT + 10) y = frame.yAt(value) + 20;
        if (frame.x1 - frame.x0 < w + 20) return;
        frame.svg.appendChild(text(x, y, label, {
            fill: VIZ.ink, 'font-size': '11', 'font-weight': '600', 'text-anchor': anchor,
            'font-family': 'Inter, sans-serif', 'paint-order': 'stroke',
            stroke: VIZ.surface, 'stroke-width': '3', 'stroke-linejoin': 'round'
        }));
    }

    // --- Chart 2: per-call change in private bytes --------------------------

    function renderDeltaChart() {
        var host = $('prof-chart-delta');
        var n = state.samples.length;
        if (!n || !host) return;

        var W = Math.max(320, host.clientWidth || 640);
        var plotW = W - GEO.padL - GEO.padR;
        var maxBars = Math.max(4, Math.floor(plotW / MIN_BAR_PX));
        var bins = buckets(n, maxBars);

        // Column width and band inset are mutually dependent: size the column
        // against the full width, then re-size it inside the inset band. Two
        // passes settle it because the width is capped at 24px either way.
        var barWidth = plotW, bandInset = 0;
        for (var pass = 0; pass < 2; pass++) {
            var band = bins.length > 1 ? (plotW - 2 * bandInset) / (bins.length - 1) : plotW;
            barWidth = Math.max(1, Math.min(24, band - 2));   // the 2px surface gap
            bandInset = barWidth / 2;
        }

        // Sum inside a bucket: totals stay correct when a long run is compressed
        var vals = bins.map(function (b) {
            var sum = 0;
            for (var i = b[0]; i <= b[1]; i++) sum += state.samples[i].delta;
            return sum;
        });

        var lo = Math.min(0, Math.min.apply(null, vals));
        var hi = Math.max(0, Math.max.apply(null, vals));
        if (lo === 0 && hi === 0) hi = 1024;
        var scale = byteScale(lo, hi + (hi - lo) * 0.1, 4);
        var frame = makeFrame(host, bins.length, scale, {
            xLabelFor: function (k) { return String(bins[k][1] + 1); },
            warmupSlots: warmupSlotCount(bins),
            bandInset: bandInset
        });

        var zeroY = frame.yAt(0);
        var bw = barWidth;

        bins.forEach(function (b, k) {
            var v = vals[k];
            if (v === 0) return;
            var yv = frame.yAt(v);
            var up = v > 0;
            var y = up ? yv : zeroY;
            var h = Math.max(1, Math.abs(zeroY - yv));
            var x = frame.xAt(k) - bw / 2;
            frame.svg.appendChild(el('path', {
                d: barPath(x, y, bw, h, up),
                fill: up ? VIZ.retained : VIZ.released
            }));
        });

        // Zero rule sits above the columns so the polarity split stays readable
        frame.svg.appendChild(el('line', {
            x1: frame.x0, y1: zeroY, x2: frame.x1, y2: zeroY,
            stroke: VIZ.axis, 'stroke-width': 1
        }));

        var m = mountChart('prof-chart-delta', 'prof-tip-delta', frame);
        var chart = { id: 'delta' };
        attachHover(chart, frame, m.host, m.tip, function (k) {
            var b = bins[k], v = vals[k];
            var head = b[0] === b[1]
                ? 'Call ' + (b[0] + 1) + (b[0] < state.warmup ? ' (warmup)' : '')
                : 'Calls ' + (b[0] + 1) + '–' + (b[1] + 1);
            return {
                head: head,
                items: [
                    {
                        name: v >= 0 ? 'Retained' : 'Released',
                        color: v >= 0 ? VIZ.retained : VIZ.released,
                        value: fmtBytes(v, true)
                    },
                    { name: 'Held after', color: VIZ.private, value: fmtBytes(state.samples[b[1]].private) }
                ]
            };
        }, binMapper(bins));
        charts.push(chart);

        var totalPos = 0, totalNeg = 0;
        state.samples.forEach(function (s, i) {
            if (i < state.warmup) return;
            if (s.delta > 0) totalPos += s.delta; else totalNeg += s.delta;
        });
        renderLegend('prof-legend-delta', [
            { name: 'Retained', color: VIZ.retained, swatch: true, value: fmtBytes(totalPos, true) },
            { name: 'Released', color: VIZ.released, swatch: true, value: fmtBytes(totalNeg, true) }
        ], bins.length < n
            ? 'grouped: each column sums ' + Math.round(n / bins.length) + ' calls'
            : null);
    }

    // --- Chart 3: transient memory during each call -------------------------

    function renderTransientChart() {
        var host = $('prof-chart-transient');
        var n = state.samples.length;
        if (!n || !host) return;

        var W = Math.max(320, host.clientWidth || 640);
        var maxPts = Math.max(4, Math.floor((W - GEO.padL - GEO.padR) / MIN_PT_PX));
        var bins = buckets(n, Math.min(MAX_LINE_PTS, maxPts));
        // Max inside a bucket: this series is a high-water mark, so peaks must survive
        var vals = bins.map(function (b) {
            var mx = 0;
            for (var i = b[0]; i <= b[1]; i++) mx = Math.max(mx, state.samples[i].transient);
            return mx;
        });

        var hi = Math.max.apply(null, vals);
        var scale = byteScale(0, hi > 0 ? hi * 1.12 : 1024, 4);
        var frame = makeFrame(host, bins.length, scale, {
            xLabelFor: function (k) { return String(bins[k][1] + 1); },
            warmupSlots: warmupSlotCount(bins)
        });

        var d = '', area = '';
        vals.forEach(function (v, k) {
            var x = frame.xAt(k).toFixed(1), y = frame.yAt(v).toFixed(1);
            d += (k ? 'L' : 'M') + x + ' ' + y;
        });
        if (vals.length) {
            area = d + 'L' + frame.xAt(vals.length - 1).toFixed(1) + ' ' + frame.yAt(0).toFixed(1) +
                'L' + frame.xAt(0).toFixed(1) + ' ' + frame.yAt(0).toFixed(1) + 'Z';
            frame.svg.appendChild(el('path', { d: area, fill: VIZ.transient, 'fill-opacity': 0.1 }));
            frame.svg.appendChild(el('path', {
                d: d, fill: 'none', stroke: VIZ.transient, 'stroke-width': 2,
                'stroke-linejoin': 'round', 'stroke-linecap': 'round'
            }));
            frame.svg.appendChild(el('circle', {
                cx: frame.xAt(vals.length - 1), cy: frame.yAt(vals[vals.length - 1]), r: 4,
                fill: VIZ.transient, stroke: VIZ.surface, 'stroke-width': 2
            }));
        }

        var m = mountChart('prof-chart-transient', 'prof-tip-transient', frame);
        var chart = { id: 'transient' };
        attachHover(chart, frame, m.host, m.tip, function (k) {
            var b = bins[k];
            var head = b[0] === b[1] ? 'Call ' + (b[0] + 1)
                : 'Calls ' + (b[0] + 1) + '–' + (b[1] + 1) + ' (peak)';
            return {
                head: head,
                items: [
                    { name: 'Transient', color: VIZ.transient, value: fmtBytes(vals[k]) },
                    { name: 'In-call peak', color: 'transparent', value: fmtBytes(state.samples[b[1]].peak) },
                    { name: 'Duration', color: 'transparent', value: fmtMs(state.samples[b[1]].ms) }
                ]
            };
        }, binMapper(bins));
        charts.push(chart);

        // One series needs no legend box - the title names it, so this is a readout
        var sum = 0, mx = 0;
        state.samples.forEach(function (s) { sum += s.transient; mx = Math.max(mx, s.transient); });
        renderLegend('prof-legend-transient', [
            { name: 'average', color: null, value: fmtBytes(sum / n) },
            { name: 'peak', color: null, value: fmtBytes(mx) }
        ]);
    }

    // --- Legend / readout ---------------------------------------------------

    function renderLegend(hostId, items, footnote) {
        var host = $(hostId);
        if (!host) return;
        host.textContent = '';
        items.filter(Boolean).forEach(function (it) {
            var row = document.createElement('span');
            row.className = 'legend-item';
            if (it.color) {
                var key = document.createElement('span');
                key.className = 'legend-key' + (it.swatch ? ' swatch' : '');
                key.style.background = it.color;
                row.appendChild(key);
            } else if (it.dashed) {
                var dash = document.createElement('span');
                dash.className = 'legend-key';
                dash.style.background = 'none';
                dash.style.borderTop = '1.5px dashed ' + VIZ.inkMuted;
                row.appendChild(dash);
            }
            var name = document.createElement('span');
            name.textContent = it.name;
            row.appendChild(name);
            if (it.value) {
                var val = document.createElement('span');
                val.className = 'legend-value';
                val.textContent = it.value;
                row.appendChild(val);
            }
            host.appendChild(row);
        });
        if (footnote) {
            var note = document.createElement('span');
            note.className = 'legend-item';
            note.style.color = VIZ.inkMuted;
            note.textContent = footnote;
            host.appendChild(note);
        }
    }

    // --- Headline numbers ---------------------------------------------------

    function renderHero() {
        var n = state.samples.length;
        if (!n) return;
        var heap = hasHeap();
        var key = heap ? 'live' : 'private';
        var slope = 0, r2 = null, measured = 0, privSlope = null;
        if (state.summary) {
            if (heap && state.summary.heap) {
                slope = state.summary.heap.slope_alloc;
                r2 = state.summary.heap.r2_alloc;
                privSlope = state.summary.slope_bytes_per_iter;
            } else {
                slope = state.summary.slope_bytes_per_iter;
                r2 = state.summary.r2;
            }
            measured = state.summary.measured_count;
        } else if (n - state.warmup >= 2) {
            var fit = linreg(state.samples.slice(state.warmup).map(function (s) { return s[key]; }), state.warmup);
            slope = fit.slope;
            r2 = fit.r2;
            measured = n - state.warmup;
        }
        var label = document.querySelector('#prof-body .profile-hero-label');
        if (label) {
            label.textContent = heap ? 'Live heap retained per call, after warmup'
                                     : 'Memory retained per call, after warmup';
        }
        $('prof-hero-value').textContent = fmtBytes(slope, true);
        $('prof-hero-unit').textContent = 'per call';
        $('prof-hero-sub').textContent =
            'linear fit R² ' + fmtR2(r2) + ' over ' + measured + ' measured calls' +
            '  ·  projected ' + fmtBytes(slope * 10000, true) + ' per 10,000 calls' +
            (privSlope !== null ? '  ·  private bytes ' + fmtBytes(privSlope, true) + ' per call' : '');
    }

    function tile(label, value, sub) {
        var t = document.createElement('div');
        t.className = 'stat-tile';
        var l = document.createElement('div');
        l.className = 'stat-label';
        l.textContent = label;
        var v = document.createElement('div');
        v.className = 'stat-value';
        v.textContent = value;
        t.appendChild(l);
        t.appendChild(v);
        if (sub) {
            var s = document.createElement('div');
            s.className = 'stat-sub';
            s.textContent = sub;
            t.appendChild(s);
        }
        return t;
    }

    function renderStats() {
        var host = $('prof-stats');
        var n = state.samples.length;
        if (!host || !n) return;
        var st = state.start || {};
        var sum = state.summary;
        var base = st.baseline ? st.baseline.private : 0;
        var latest = state.samples[n - 1];
        var netGrowth = sum ? sum.net_growth
            : (n > state.warmup ? latest.private - state.samples[state.warmup].private : 0);
        var firstCost = sum ? sum.first_call_cost : (state.samples[0].private - base);
        var peak = 0, tsum = 0;
        state.samples.forEach(function (s) { peak = Math.max(peak, s.peak); tsum += s.transient; });

        host.textContent = '';
        host.appendChild(tile('Held after run', fmtBytes(latest.private - base),
            'on top of a ' + fmtBytes(base) + ' baseline'));
        host.appendChild(tile('Growth after warmup', fmtBytes(netGrowth, true),
            'calls ' + (state.warmup + 1) + '–' + n));
        if (hasHeap()) {
            var liveNet = sum && sum.heap ? sum.heap.net_alloc
                : (n > state.warmup ? latest.live - state.samples[state.warmup].live : 0);
            host.appendChild(tile('Live heap growth', fmtBytes(liveNet, true),
                'allocated, not freed · calls ' + (state.warmup + 1) + '–' + n));
        }
        host.appendChild(tile('First-call init', fmtBytes(firstCost),
            'one-time, not a leak'));
        host.appendChild(tile('Peak in-call memory', fmtBytes(peak),
            'process high-water mark'));
        host.appendChild(tile('Transient per call', fmtBytes(tsum / n),
            'scratch, given back'));
        host.appendChild(tile('DLL module image',
            st.module ? fmtBytes(st.module.image_size) : 'n/a',
            st.module ? 'mapped at ' + st.module.base : ''));
        host.appendChild(tile('Call duration',
            fmtMs(sum ? sum.duration.avg_ms : avgOf('ms')),
            sum ? 'p95 ' + fmtMs(sum.duration.p95_ms) + ' · max ' + fmtMs(sum.duration.max_ms) : 'average'));
        host.appendChild(tile('Output stability',
            sum ? (sum.output.stable ? 'Identical' : sum.output.distinct + ' variants')
                : (state.finished ? 'n/a' : '…'),
            sum ? fmtBytes(sum.output.bytes) + ' per result'
                : (state.finished ? 'run did not finish' : 'collecting')));
    }

    function avgOf(key) {
        var n = state.samples.length;
        if (!n) return 0;
        var s = 0;
        state.samples.forEach(function (x) { s += x[key]; });
        return s / n;
    }

    function detailRow(host, label, value) {
        var row = document.createElement('div');
        row.className = 'detail-row';
        var dt = document.createElement('dt');
        dt.textContent = label;
        var dd = document.createElement('dd');
        dd.textContent = value;
        row.appendChild(dt);
        row.appendChild(dd);
        host.appendChild(row);
    }

    function renderDetails() {
        var host = $('prof-details');
        if (!host) return;
        var st = state.start || {};
        var sum = state.summary;
        host.textContent = '';
        detailRow(host, 'Iterations run', fmtInt(state.samples.length) + ' of ' + fmtInt(state.planned));
        detailRow(host, 'Warmup excluded', fmtInt(state.warmup) + ' calls');
        detailRow(host, 'Input payload', st.input_bytes ? fmtInt(st.input_bytes) + ' chars' : '--');
        detailRow(host, 'DLL load time', st.load_ms !== undefined ? fmtMs(st.load_ms) : '--');
        detailRow(host, 'Private bytes before load', st.pre_load ? fmtBytes(st.pre_load.private) : '--');
        detailRow(host, 'Baseline after load', st.baseline ? fmtBytes(st.baseline.private) : '--');
        if (st.baseline_heap) {
            detailRow(host, 'Live heap at baseline', fmtBytes(st.baseline_heap.alloc));
        }
        if (st.tracking && st.tracking.requested) {
            detailRow(host, 'Allocation tracking',
                st.tracking.active ? st.tracking.hooked + ' imports hooked' : 'not active');
        }
        if (st.symbols && st.symbols.state) {
            detailRow(host, 'Symbols', st.symbols.state + (st.symbols.pdb ? ' · ' + st.symbols.pdb : ''));
        }
        if (sum) {
            detailRow(host, 'Private bytes at end', fmtBytes(sum.final.private));
            detailRow(host, 'Working set at end', fmtBytes(sum.final.rss));
            detailRow(host, 'After FreeLibrary',
                sum.after_unload ? fmtBytes(sum.after_unload.private) : 'not unloaded');
            detailRow(host, 'Reclaimed by unload',
                sum.after_unload ? fmtBytes(sum.final.private - sum.after_unload.private) : '--');
            if (sum.heap) {
                detailRow(host, 'Live heap slope', fmtBytes(sum.heap.slope_alloc, true) + ' / call (R² ' + fmtR2(sum.heap.r2_alloc) + ')');
                detailRow(host, 'Committed heap slope', fmtBytes(sum.heap.slope_commit, true) + ' / call');
                detailRow(host, 'Non-heap memory slope', fmtBytes(sum.heap.slope_nonheap, true) + ' / call');
            }
            detailRow(host, 'Private bytes slope', fmtBytes(sum.slope_bytes_per_iter, true) + ' / call');
            detailRow(host, 'Private bytes fit (R²)', fmtR2(sum.r2));
            if (sum.duration && sum.duration.cpu_available) {
                detailRow(host, 'CPU time per call', fmtMs(sum.duration.cpu_avg_ms));
            }
            detailRow(host, 'Projected at 10k calls', fmtBytes(sum.projection_10k, true));
            detailRow(host, 'Total run time', fmtMs(sum.duration.total_ms));
            detailRow(host, 'Output buffer release', st.free_mode || 'none');
            detailRow(host, 'Noise floor', fmtBytes(sum.thresholds.noise_floor_bpi) + ' / call');
        }
    }

    function renderVerdict() {
        var banner = $('prof-verdict');
        var sum = state.summary;
        var key = sum ? sum.verdict : null;
        var v = VERDICTS[key];

        banner.className = 'verdict-banner ' + (v ? v.cls : 'verdict-unknown');
        if (!v) {
            $('prof-verdict-icon').textContent = '…';
            $('prof-verdict-title').textContent = state.running ? 'Measuring' : 'No verdict';
            $('prof-verdict-detail').textContent = state.running
                ? 'Call ' + state.samples.length + ' of ' + state.planned + '. The verdict lands when the run finishes.'
                : 'The run did not finish, so no leak verdict was computed.';
        } else {
            $('prof-verdict-icon').textContent = v.icon;
            $('prof-verdict-title').textContent = v.title;
            var vs = sum.heap ? sum.heap.slope_alloc : sum.slope_bytes_per_iter;
            var vr = sum.heap ? sum.heap.r2_alloc : sum.r2;
            $('prof-verdict-detail').textContent = v.detail + ' Measured ' +
                fmtBytes(vs, true) + ' per call across ' +
                sum.measured_count + ' calls (R² ' + fmtR2(vr) + ')' +
                (sum.verdict_basis ? ', judged on ' + sum.verdict_basis : '') + '.';
        }

        var notes = $('prof-notes');
        notes.textContent = '';
        (sum && sum.notes ? sum.notes : []).forEach(function (n) {
            var li = document.createElement('li');
            li.textContent = n;
            notes.appendChild(li);
        });
    }

    // --- Table view ---------------------------------------------------------

    var TABLE_ROW_CAP = 1000;

    function renderTable() {
        var body = $('prof-table-body');
        if (!body || !state.tableOpen) return;
        body.textContent = '';
        var rows = state.samples;
        var shown = rows.length > TABLE_ROW_CAP ? rows.slice(rows.length - TABLE_ROW_CAP) : rows;
        var offset = rows.length - shown.length;

        shown.forEach(function (s, k) {
            var i = offset + k;
            var tr = document.createElement('tr');
            if (i < state.warmup) tr.className = 'is-warmup';
            [
                String(i + 1),
                fmtInt(s.private),
                hasHeap() ? fmtInt(s.live) : '--',
                fmtBytes(s.delta, true),
                fmtInt(s.rss),
                fmtInt(s.peak),
                fmtBytes(s.transient),
                fmtMs(s.ms),
                s.hash
            ].forEach(function (val, col) {
                var td = document.createElement('td');
                td.textContent = val;
                if (col === 3) td.className = s.delta > 0 ? 'cell-pos' : (s.delta < 0 ? 'cell-neg' : '');
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });

        if (offset > 0) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 9;
            td.style.textAlign = 'center';
            td.textContent = 'Showing the last ' + TABLE_ROW_CAP + ' of ' + rows.length +
                ' calls. Download the CSV for the full series.';
            tr.appendChild(td);
            body.insertBefore(tr, body.firstChild);
        }
    }

    window.toggleProfileTable = function () {
        state.tableOpen = !state.tableOpen;
        $('prof-table-wrap').hidden = !state.tableOpen;
        $('prof-table-btn').textContent = state.tableOpen ? 'Hide per-call table' : 'Show per-call table';
        renderTable();
    };

    window.downloadProfileCsv = function () {
        if (!state.samples.length) {
            alert('Run a memory profile first.');
            return;
        }
        var lines = ['call,is_warmup,private_bytes,live_heap_bytes,committed_heap_bytes,delta_bytes,working_set_bytes,in_call_peak_bytes,transient_bytes,duration_ms,cpu_ms,output_digest'];
        state.samples.forEach(function (s, i) {
            lines.push([i + 1, i < state.warmup ? 1 : 0, s.private, s.live, s.commit, s.delta, s.rss,
                s.peak, s.transient, s.ms, s.cpu, s.hash].join(','));
        });
        var name = (document.getElementById('func-name').value || 'dll') + '_memory_profile.csv';
        var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 0);
    };

    // --- Leak sites ------------------------------------------------------------

    function baseName(path) {
        var i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        return i >= 0 ? path.slice(i + 1) : path;
    }

    function frameLocation(fr) {
        if (!fr.file) return fr.module || '';
        return baseName(fr.file) + (fr.line ? ':' + fr.line : '');
    }

    function span(cls, txt) {
        var n = document.createElement('span');
        if (cls) n.className = cls;
        n.textContent = txt;
        return n;
    }

    function renderLeaks() {
        var card = $('prof-leaks-card');
        if (!card) return;
        var lk = state.summary && state.summary.leaks;
        if (!lk) { card.hidden = true; return; }
        card.hidden = false;
        var body = $('prof-leaks-body');
        body.textContent = '';

        if (lk.error) {
            body.appendChild(span('leak-empty', lk.error));
            renderLegend('prof-leaks-summary', []);
            return;
        }

        var sites = lk.sites || [];
        var recurring = sites.filter(function (x) { return x.recurring; });
        var retained = recurring.reduce(function (a, x) { return a + x.bytes; }, 0);
        renderLegend('prof-leaks-summary', [
            { name: 'Leaking sites', color: null, value: String(recurring.length) },
            { name: 'Retained by them', color: null, value: fmtBytes(retained) },
            { name: 'Live at end', color: null, value: fmtInt(lk.live_blocks) + ' blocks · ' + fmtBytes(lk.live_bytes) }
        ]);

        if (!sites.length) {
            body.appendChild(span('leak-empty',
                'No allocation made after warmup is still alive. The DLL freed everything it ' +
                'allocated during the measured calls.'));
            return;
        }

        sites.forEach(function (site) {
            var frames = site.frames || [];
            var origin = frames[site.origin || 0] || {};
            var box = document.createElement('div');
            box.className = 'leak-site' + (site.recurring ? ' is-leak' : '');

            var head = document.createElement('div');
            head.className = 'leak-head';
            head.appendChild(span('pill ' + (site.recurring ? 'pill-leak' : 'pill-info'),
                site.recurring ? 'Leaks every call' : 'One-time'));
            var fn = span('leak-func', origin.func || '(unknown)');
            fn.title = origin.func || '';
            head.appendChild(fn);
            var loc = frameLocation(origin);
            if (loc) {
                var l = span('leak-loc', loc);
                l.title = origin.file || '';
                head.appendChild(l);
            }
            var meta = document.createElement('div');
            meta.className = 'leak-meta';
            meta.appendChild(span('leak-bytes', fmtBytes(site.bytes)));
            meta.appendChild(span('', fmtInt(site.count) + (site.count === 1 ? ' block' : ' blocks')));
            meta.appendChild(span('', 'from ' + site.calls + ' of ' + lk.measured_calls + ' calls'));
            if (site.recurring) {
                meta.appendChild(span('', '≈ ' + fmtBytes(site.per_call_bytes) + ' per call'));
            }
            head.appendChild(meta);
            box.appendChild(head);

            if (frames.length) {
                var det = document.createElement('details');
                det.className = 'leak-stack';
                var sum = document.createElement('summary');
                sum.textContent = 'Call stack (' + frames.length + ' frames)';
                det.appendChild(sum);
                var ol = document.createElement('ol');
                frames.forEach(function (fr, k) {
                    var li = document.createElement('li');
                    if (k === site.origin) li.className = 'is-origin';
                    li.appendChild(span('fr-func', fr.func));
                    if (fr.inlined) li.appendChild(span('fr-tag', 'inlined'));
                    var where = frameLocation(fr);
                    if (where) {
                        var w = span('fr-loc', where);
                        w.title = fr.file || '';
                        li.appendChild(w);
                    }
                    if (fr.file && fr.module) li.appendChild(span('fr-mod', fr.module));
                    ol.appendChild(li);
                });
                det.appendChild(ol);
                box.appendChild(det);
            }
            body.appendChild(box);
        });

        if (lk.baseline_live_blocks) {
            body.appendChild(span('leak-foot',
                'Not counted: ' + fmtInt(lk.baseline_live_blocks) + ' blocks (' +
                fmtBytes(lk.baseline_live_bytes) + ') allocated before the measured calls ' +
                '(load time and warmup) and still alive - typically caches and singletons.'));
        }
    }

    // --- Render orchestration ----------------------------------------------

    function renderAll() {
        if (!state.samples.length) return;
        charts.length = 0;             // rebuilt below; hover re-registers
        renderVerdict();
        renderHero();
        renderStats();
        renderHeapChart();
        renderHeldChart();
        renderDeltaChart();
        renderTransientChart();
        renderLeaks();
        renderDetails();
        renderTable();
        if (state.hover !== null) setHover(state.hover);
    }

    var renderTimer = null;
    var renderFrame = null;

    /* Redraw at most ~8x a second: a thousand-iteration run would otherwise
       spend more time in the DOM than the DLL spends working. */
    function queueRender() {
        if (state.renderQueued) return;
        var since = Date.now() - state.lastRender;
        var wait = Math.max(0, 120 - since);
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

    /* The last streamed sample always leaves a render queued. finishRun paints
       the final banner itself, so that pending render has to be dropped - it
       would land afterwards and overwrite the outcome with a stale one. */
    function cancelQueuedRender() {
        if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
        if (renderFrame !== null) { cancelAnimationFrame(renderFrame); renderFrame = null; }
        state.renderQueued = false;
    }

    // --- Status helpers -----------------------------------------------------

    function setBadge(cls, msg) {
        var b = $('prof-badge');
        b.className = 'status-badge' + (cls ? ' ' + cls : '');
        b.textContent = msg;
    }

    function setProgress(text, pct) {
        $('prof-progress-text').textContent = text;
        $('prof-progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    function setRunning(on) {
        state.running = on;
        $('prof-run-btn').disabled = on;
        $('prof-run-btn').querySelector('.btn-text').style.display = on ? 'none' : 'inline';
        $('prof-loader').style.display = on ? 'inline-block' : 'none';
        $('prof-cancel-btn').style.display = on ? 'inline-flex' : 'none';
    }

    function showFatal(message, extra) {
        cancelQueuedRender();
        state.finished = true;
        setBadge('error', 'Failed');
        setProgress('Failed', 0);
        $('prof-results').hidden = false;
        $('prof-empty').hidden = true;
        $('prof-body').hidden = true;   // nothing was measured, so show no charts
        $('prof-verdict').className = 'verdict-banner verdict-leak';
        $('prof-verdict-icon').textContent = '✕';
        $('prof-verdict-title').textContent = 'Profile run failed';
        $('prof-verdict-detail').textContent = message;
        $('prof-notes').textContent = '';
        if (extra) {
            $('prof-logs').hidden = false;
            $('prof-logs-body').textContent = extra;
        }
    }

    // --- The run ------------------------------------------------------------

    function handleEvent(ev) {
        if (ev.event === 'start') {
            state.start = ev;
            state.planned = ev.iterations;
            state.warmup = ev.warmup;
            setBadge('running', 'Measuring');
            return;
        }
        if (ev.event === 'iter') {
            var prev = state.samples.length ? state.samples[state.samples.length - 1].private
                : (state.start && state.start.baseline ? state.start.baseline.private : ev.private);
            state.samples.push({
                private: ev.private,
                rss: ev.rss,
                live: ev.heap_alloc || 0,
                commit: ev.heap_commit || 0,
                cpu: ev.cpu_ms || 0,
                peak: ev.peak,
                transient: ev.transient,
                ms: ev.ms,
                hash: ev.hash || '',
                delta: ev.private - prev
            });
            $('prof-results').hidden = false;
            $('prof-empty').hidden = true;
            setProgress('Call ' + ev.i + ' of ' + state.planned,
                state.planned ? (ev.i / state.planned) * 100 : 0);
            queueRender();
            return;
        }
        if (ev.event === 'done') {
            state.summary = ev.summary;
            state.logs = ev.logs || '';
            return;
        }
        if (ev.event === 'error') {
            state.error = ev.message;
            state.stage = ev.stage || '';
            state.crash = ev.crash || null;
            state.crashSummary = ev.crash_summary || '';
            state.logs = ev.logs || '';
            state.trace = ev.traceback || '';
            return;
        }
        if (ev.event === 'exit') {
            state.exit = ev;
            return;
        }
    }

    window.runMemoryProfile = function () {
        if (state.running) return;

        var dllPath = document.getElementById('dll-path').value;
        var jsonPath = document.getElementById('json-path').value;
        var funcName = document.getElementById('func-name').value;
        if (!dllPath || !jsonPath || !funcName) {
            alert('Set the DLL path, input JSON path and function name in Configuration first.');
            return;
        }

        var iterations = parseInt($('prof-iterations').value, 10);
        var warmup = parseInt($('prof-warmup').value, 10);
        if (!(iterations >= 1) || iterations > 10000) {
            alert('Iterations must be a whole number between 1 and 10000.');
            return;
        }
        if (!(warmup >= 0) || warmup >= iterations) {
            alert('Warmup must be 0 or more, and fewer than the iteration count.');
            return;
        }
        saveProfileConfig();

        // Reset run state; keep the previous render on screen until data arrives
        state.samples = [];
        state.summary = null;
        state.start = null;
        state.logs = '';
        state.error = null;
        state.stage = '';
        state.crash = null;
        state.crashSummary = '';
        state.trace = '';
        state.exit = null;
        state.noise = [];
        state.finished = false;
        state.hover = null;
        state.planned = iterations;
        state.warmup = warmup;
        charts.length = 0;
        $('prof-logs').hidden = true;
        $('prof-logs-body').textContent = '';
        $('prof-leaks-card').hidden = true;

        $('prof-body').hidden = false;
        setRunning(true);
        setBadge('running', 'Starting');
        setProgress('Loading DLL in a fresh process…', 0);

        state.controller = new AbortController();

        fetch('/api/profile', {
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
                free_mode: $('prof-free-mode').value,
                unload_after: true,
                track_allocs: $('prof-track').checked,
                measure_heap: $('prof-heap').checked,
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
                setProgress('Cancelled after ' + state.samples.length + ' calls',
                    state.planned ? (state.samples.length / state.planned) * 100 : 0);
                renderAll();
            } else {
                showFatal(err && err.message ? err.message : String(err));
            }
        }).then(function () {
            setRunning(false);
            state.controller = null;
        });
    };

    function pump(reader) {
        var decoder = new TextDecoder();
        var buf = '';

        function step() {
            return reader.read().then(function (r) {
                if (r.done) {
                    if (buf.trim()) consume(buf.trim());
                    return;
                }
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

    function consume(line) {
        try {
            handleEvent(JSON.parse(line));
        } catch (e) {
            // Only pre-redirect output (an import failure) can land here
            state.noise.push(line);
        }
    }

    function finishRun() {
        cancelQueuedRender();
        state.finished = true;
        var noise = state.noise.join('\n').trim();

        /* No summary means the run never reached the end: the runner reported an
           error, or the process died outright. Either way the samples taken
           before that point are a finding - "it dies on call 8, and here is the
           memory curve up to call 7" - so chart them instead of throwing them
           away behind an error message. */
        if (!state.summary) {
            var done = state.samples.length;
            var code = state.exit ? state.exit.returncode : null;
            var where = done
                ? ' after ' + done + ' of ' + state.planned + ' calls'
                : ' before the first call';
            var tail = done
                ? ' A stop this far in is itself a finding - the run up to that point is charted below.'
                : '';
            var failed = state.stage ? 'The run failed during ' + state.stage : 'The DLL call failed';
            var detail = state.error
                ? failed + where + ': ' +
                  state.error.replace(/[.\s]+$/, '') + '.' +
                  (state.crashSummary ? ' Crash location: ' + state.crashSummary + '.' : '') + tail
                : 'The profile runner exited' + where +
                  (code !== null ? ' (exit code ' + code + ')' : '') + '.' + tail;

            setBadge('error', done ? 'Stopped at call ' + done : 'Failed');
            setProgress(done ? 'Stopped at call ' + done : 'Failed',
                state.planned ? (done / state.planned) * 100 : 0);
            $('prof-results').hidden = false;
            $('prof-empty').hidden = true;
            $('prof-body').hidden = done === 0;
            if (done > 0) renderAll();   // before the banner: renderAll rewrites it

            $('prof-verdict').className = 'verdict-banner verdict-leak';
            $('prof-verdict-icon').textContent = '✕';
            $('prof-verdict-title').textContent = done ? 'Run ended early' : 'Profile run failed';
            $('prof-verdict-detail').textContent = detail;
            $('prof-notes').textContent = '';

            var extra = [crashStackText(), state.trace, state.exit && state.exit.stderr, state.logs, noise]
                .filter(Boolean).join('\n\n');
            $('prof-logs').hidden = !extra;
            $('prof-logs-body').textContent = extra;
            return;
        }

        $('prof-body').hidden = false;
        var v = state.summary.verdict;
        setBadge(v === 'clean' ? 'success' : (v === 'leak' ? 'error' : ''),
            v === 'clean' ? 'No leak' : (v === 'leak' ? 'Leak detected' :
                (v === 'suspect' ? 'Possible leak' : 'Inconclusive')));
        setProgress('Done · ' + state.samples.length + ' calls in ' +
            fmtMs(state.summary.duration.total_ms), 100);
        renderAll();

        var logs = [state.logs, noise].filter(Boolean).join('\n\n');
        $('prof-logs').hidden = !logs;
        $('prof-logs-body').textContent = logs;
    }

    window.cancelMemoryProfile = function () {
        fetch('/api/profile_cancel', { method: 'POST' }).catch(function () { });
        if (state.controller) state.controller.abort();
    };

    // --- Config persistence, matching the existing localStorage pattern -----

    function saveProfileConfig() {
        localStorage.setItem('fnp_prof_iterations', $('prof-iterations').value);
        localStorage.setItem('fnp_prof_warmup', $('prof-warmup').value);
        localStorage.setItem('fnp_prof_free_mode', $('prof-free-mode').value);
        localStorage.setItem('fnp_prof_track', $('prof-track').checked ? '1' : '0');
        localStorage.setItem('fnp_prof_heap', $('prof-heap').checked ? '1' : '0');
    }

    function loadProfileConfig() {
        var it = localStorage.getItem('fnp_prof_iterations');
        if (it) $('prof-iterations').value = it;
        var wu = localStorage.getItem('fnp_prof_warmup');
        if (wu !== null) $('prof-warmup').value = wu;
        var fm = localStorage.getItem('fnp_prof_free_mode');
        if (fm) $('prof-free-mode').value = fm;
        $('prof-track').checked = localStorage.getItem('fnp_prof_track') === '1';
        $('prof-heap').checked = localStorage.getItem('fnp_prof_heap') !== '0';
    }

    /* The exact stack of a hardware exception (access violation etc.), recorded at the
       moment it happened, so a crash points at a function and line instead of a bare
       "OSError: access violation reading 0x...". */
    function crashStackText(crash, summary) {
        crash = crash || state.crash;
        summary = summary || state.crashSummary;
        if (!crash || !crash.frames || !crash.frames.length) return '';
        var frames = crash.frames.slice(0, 18);
        var lines = frames.map(function (f, i) {
            return '  ' + (i < 10 ? ' ' : '') + i + '  ' + f.module + '!' + f.func +
                (f.file ? '   ' + f.file + ':' + f.line : '') + (f.inlined ? '   [inlined]' : '');
        });
        if (crash.frames.length > frames.length) lines.push('  ... ' + (crash.frames.length - frames.length) + ' more frames');
        return 'Crash: ' + summary + '\nStack at the moment of the fault (innermost first):\n' + lines.join('\n');
    }

    // Small, stable surface for the speed profiler (static/speed.js) to reuse.
    window.FnpViz = {
        VIZ: VIZ, fmtBytes: fmtBytes, fmtInt: fmtInt, fmtMs: fmtMs, el: el, text: text,
        niceStep: niceStep, renderLegend: renderLegend, tile: tile, detailRow: detailRow,
        baseName: baseName, span: span, crashStackText: crashStackText
    };

    // --- Boot ---------------------------------------------------------------

    window.addEventListener('load', function () {
        loadProfileConfig();
        ['prof-iterations', 'prof-warmup', 'prof-free-mode', 'prof-track', 'prof-heap'].forEach(function (id) {
            var node = $(id);
            if (node) node.addEventListener('change', saveProfileConfig);
        });

        // Charts are drawn at real pixel sizes, so a width change needs a redraw.
        // Height changes must not retrigger, or the observer would loop.
        if (window.ResizeObserver) {
            var lastW = 0;
            var ro = new ResizeObserver(function (entries) {
                var w = entries[0].contentRect.width;
                if (Math.abs(w - lastW) < 8) return;
                lastW = w;
                if (state.samples.length) queueRender();
            });
            var panel = document.querySelector('.profile-panel');
            if (panel) ro.observe(panel);
        }
    });
})();
