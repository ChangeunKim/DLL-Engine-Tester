"""Memory profiling runner for repeated DLL execution.

Loads the target DLL once, calls the exported function N times with the exact same
input JSON, and samples process memory around every call. Emits one NDJSON event
per line so the web UI can draw the growth curve live.

Why a dedicated runner instead of reusing runner.py / runner_persistent.py:
  * A leak measurement needs a *fresh* process, so the baseline is not polluted by
    a previous run's allocations.
  * The C++ DLL usually writes to stdout (printf / std::cout) directly through
    file descriptor 1, which would corrupt an NDJSON stream. We therefore dup the
    real stdout onto a private channel and point fd 1 / fd 2 at a temp log file
    before the DLL is ever loaded, so the DLL's CRT attaches to the log instead.
  * The harness itself must not allocate per iteration, or its own growth shows up
    as a leak. Samples are accumulated in fixed-width `array` buffers (8 bytes per
    entry) and streamed out immediately rather than collected into dicts.
"""

import array
import ctypes
import gc
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from ctypes import (POINTER, WinDLL, byref, c_char_p, c_double, c_void_p,
                    c_wchar_p, windll, wintypes)

import psutil

# --- Leak verdict thresholds ------------------------------------------------
# Private-bytes noise for a Python process settles well under 1 KB/iteration once
# gc.collect() runs before each sample, so that is the "no growth" floor.
NOISE_FLOOR_BPI = 1024          # bytes/iteration treated as measurement noise
STRONG_SLOPE_BPI = 32 * 1024    # growth this steep is a leak even if noisy
R2_CONFIDENT = 0.85             # linear fit this tight means monotonic growth
SMALL_TOTAL_GROWTH = 64 * 1024  # absolute growth below this is not conclusive

MAX_LOG_TAIL = 64 * 1024        # bytes of DLL stdout/stderr returned to the UI

_channel = None                 # real stdout, reserved for NDJSON
_logfile = None                 # fd 1 / fd 2 sink (DLL + Python prints)


def _setup_channels():
    """Reserve the real stdout for NDJSON and redirect fd 1/2 to a temp log."""
    global _channel, _logfile
    _channel = os.fdopen(os.dup(1), 'w', encoding='utf-8', newline='\n', buffering=1)
    path = os.path.join(tempfile.gettempdir(), f'fnp_dll_profile_{os.getpid()}.log')
    _logfile = open(path, 'w+b')
    os.dup2(_logfile.fileno(), 1)
    os.dup2(_logfile.fileno(), 2)


def emit(obj):
    _channel.write(json.dumps(obj) + '\n')


def read_log_tail():
    """Return the tail of everything the DLL and Python wrote to fd 1/fd 2."""
    if _logfile is None:
        return ''
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    try:
        _logfile.flush()
        size = _logfile.seek(0, os.SEEK_END)
        _logfile.seek(max(0, size - MAX_LOG_TAIL))
        raw = _logfile.read()
        text = raw.decode('utf-8', errors='replace')
        if size > MAX_LOG_TAIL:
            text = f'... [{size - MAX_LOG_TAIL} earlier bytes truncated]\n' + text
        return text.strip()
    except Exception:
        return ''


# --- Windows memory + module introspection ---------------------------------

class MODULEINFO(ctypes.Structure):
    _fields_ = [('lpBaseOfDll', ctypes.c_void_p),
                ('SizeOfImage', wintypes.DWORD),
                ('EntryPoint', ctypes.c_void_p)]


def module_footprint(handle):
    """Static image size of the loaded DLL - the memory the module itself maps."""
    try:
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetModuleInformation.argtypes = [wintypes.HANDLE, wintypes.HMODULE,
                                               POINTER(MODULEINFO), wintypes.DWORD]
        psapi.GetModuleInformation.restype = wintypes.BOOL
        windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        info = MODULEINFO()
        ok = psapi.GetModuleInformation(windll.kernel32.GetCurrentProcess(),
                                        wintypes.HMODULE(handle),
                                        byref(info), ctypes.sizeof(info))
        if not ok:
            return None
        return {'base': hex(info.lpBaseOfDll or 0), 'image_size': int(info.SizeOfImage)}
    except Exception:
        return None


_proc = psutil.Process()


def mem():
    """One GetProcessMemoryInfo call: private bytes (commit) + working set."""
    m = _proc.memory_info()
    return int(getattr(m, 'private', m.rss)), int(m.rss)


def mem_event():
    p, r = mem()
    return {'private': p, 'rss': r}


class HEAP_SUMMARY(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD),
                ('cbAllocated', ctypes.c_size_t),
                ('cbCommitted', ctypes.c_size_t),
                ('cbReserved', ctypes.c_size_t),
                ('cbMaxReserve', ctypes.c_size_t)]


class HeapMeter:
    """Live vs committed bytes across every heap in the process.

    Private bytes mixes heap pages with stacks, VirtualAlloc regions and Python's own
    arenas, and the allocator hands pages back to the OS on its own schedule, so a
    steady leak can read as a staircase. HeapSummary reports what the heaps actually
    *hold allocated* right now (cbAllocated) separately from what they merely keep
    committed (cbCommitted), which is the question a leak hunt is really asking.

    Everything is preallocated: a measurement must not allocate per call.
    """

    MAX_HEAPS = 512

    def __init__(self, exclude=()):
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetProcessHeaps.argtypes = [wintypes.DWORD, POINTER(wintypes.HANDLE)]
        k32.GetProcessHeaps.restype = wintypes.DWORD
        k32.HeapSummary.argtypes = [wintypes.HANDLE, wintypes.DWORD, POINTER(HEAP_SUMMARY)]
        k32.HeapSummary.restype = wintypes.BOOL
        self._k32 = k32
        self._handles = (wintypes.HANDLE * self.MAX_HEAPS)()
        self._sum = HEAP_SUMMARY()
        self._exclude = set(int(x) for x in exclude if x)
        self.available = False
        try:
            a, c, ok = self._read()
            self.available = ok > 0
        except Exception:
            self.available = False

    def _read(self):
        n = min(self._k32.GetProcessHeaps(self.MAX_HEAPS, self._handles), self.MAX_HEAPS)
        alloc = commit = ok = 0
        s = self._sum
        for i in range(n):
            h = self._handles[i]
            if h is None or int(h) in self._exclude:
                continue
            s.cb = ctypes.sizeof(s)
            if self._k32.HeapSummary(h, 0, ctypes.byref(s)):
                alloc += s.cbAllocated
                commit += s.cbCommitted
                ok += 1
        return alloc, commit, ok

    def read(self):
        """-> (allocated, committed) summed over all readable heaps."""
        a, c, _ = self._read()
        return a, c


class CycleClock:
    """Per-thread CPU time from QueryThreadCycleTime.

    GetThreadTimes / time.thread_time() only advance in 15.6 ms scheduler ticks, which
    reads 0 ms for most DLL calls. The cycle counter is exact; it is converted to
    milliseconds with a factor calibrated against the wall clock on a busy spin.
    """

    def __init__(self):
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetCurrentThread.restype = wintypes.HANDLE
        k32.QueryThreadCycleTime.argtypes = [wintypes.HANDLE, POINTER(ctypes.c_ulonglong)]
        k32.QueryThreadCycleTime.restype = wintypes.BOOL
        self._k32 = k32
        self._thread = k32.GetCurrentThread()
        self._buf = ctypes.c_ulonglong()
        self.cycles_per_ms = 0.0
        self.available = False
        try:
            c0 = self.cycles()
            t0 = time.perf_counter()
            while time.perf_counter() - t0 < 0.04:
                pass
            dc = self.cycles() - c0
            dt = (time.perf_counter() - t0) * 1000.0
            if dc > 0 and dt > 0:
                self.cycles_per_ms = dc / dt
                self.available = True
        except Exception:
            pass

    def cycles(self):
        self._k32.QueryThreadCycleTime(self._thread, ctypes.byref(self._buf))
        return self._buf.value

    def to_ms(self, cycles):
        return cycles / self.cycles_per_ms if self.cycles_per_ms else 0.0


def percentile(sorted_vals, q):
    """Linear-interpolated percentile of an already sorted sequence."""
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    if n == 1:
        return float(sorted_vals[0])
    pos = (n - 1) * q
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo))


def duration_stats(durs, cpus=None):
    """Distribution of per-call wall (and CPU) time, in ms."""
    vals = sorted(durs)
    n = len(vals)
    if n == 0:
        return {}
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / n if n > 1 else 0.0
    out = {'avg_ms': mean, 'min_ms': vals[0], 'max_ms': vals[-1],
           'p50_ms': percentile(vals, 0.50), 'p90_ms': percentile(vals, 0.90),
           'p95_ms': percentile(vals, 0.95), 'p99_ms': percentile(vals, 0.99),
           'stdev_ms': var ** 0.5, 'count': n}
    if cpus:
        out['cpu_avg_ms'] = sum(cpus) / len(cpus)
    return out


class PeakSampler(threading.Thread):
    """Polls memory while a DLL call runs, to catch its transient high-water mark.

    ctypes releases the GIL for the duration of a foreign call, so this thread
    really does get scheduled while the DLL is working.
    """

    daemon = True

    def __init__(self, interval):
        super().__init__()
        self.interval = interval
        self.peak_private = 0
        self.peak_rss = 0
        self.samples = 0
        self._go = threading.Event()
        self._done = threading.Event()
        self._armed = threading.Event()

    def run(self):
        while not self._done.is_set():
            if not self._armed.wait(0.05):
                continue
            p, r = mem()
            if p > self.peak_private:
                self.peak_private = p
            if r > self.peak_rss:
                self.peak_rss = r
            self.samples += 1
            self._go.wait(self.interval)

    def arm(self):
        self._armed.set()

    def disarm(self):
        self._armed.clear()

    def shutdown(self):
        self._done.set()
        self._armed.set()
        self._go.set()


# --- Statistics -------------------------------------------------------------

def linreg(ys, x0=0):
    """Least-squares fit over evenly spaced samples -> (slope per step, r-squared).

    r-squared is None when the samples have no variance: a dead-flat series gives
    a fit nothing to explain, and reporting 1.0 there would read as a perfect leak
    trend when the truth is that there is no trend at all.
    """
    n = len(ys)
    if n < 2:
        return 0.0, None
    xs = range(x0, x0 + n)
    mx = (x0 + x0 + n - 1) / 2.0
    my = sum(ys) / float(n)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    syy = sum((y - my) ** 2 for y in ys)
    if syy == 0:
        return slope, None
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    return slope, max(0.0, min(1.0, 1.0 - ss_res / syy))


def classify(slope, r2, net_growth, n):
    """Turn slope + fit quality into a verdict the UI can badge."""
    if n < 4:
        return 'insufficient'
    if slope <= NOISE_FLOOR_BPI:
        return 'clean'
    if net_growth <= SMALL_TOTAL_GROWTH and slope < STRONG_SLOPE_BPI:
        return 'clean'
    if (r2 is not None and r2 >= R2_CONFIDENT) or slope >= STRONG_SLOPE_BPI:
        return 'leak'
    return 'suspect'


# --- Main -------------------------------------------------------------------

def build_caller(dll, func_name, arg_type_str, res_type_str, input_str, free_mode,
                 on_release=None, clock=None):
    """Return a zero-argument callable that performs exactly one DLL invocation.

    on_release(address) is told about every buffer this harness frees on the DLL's
    behalf, so the allocation tracker can drop it before the allocator reuses it.
    clock (a CycleClock) makes the callable record, in call.last, the wall and CPU
    milliseconds of the foreign call alone - without the digest/copy/free work the
    harness does around it: call.last == [dll_wall_ms, dll_cpu_ms]."""
    last = [0.0, 0.0]
    perf = time.perf_counter
    type_map = {'c_wchar_p': c_wchar_p, 'c_char_p': c_char_p, 'c_double': c_double}
    func = dll[func_name]

    if arg_type_str == 'c_wchar_p_ptr':
        func.argtypes = [c_wchar_p, POINTER(c_wchar_p)]
    else:
        func.argtypes = [type_map.get(arg_type_str, c_wchar_p)]
    # A string returned by value (restype c_wchar_p / c_char_p) is copied by ctypes
    # and the DLL-allocated original is never freed, so the harness itself would
    # leak one buffer per call. When a release strategy is chosen, take the raw
    # pointer (c_void_p), copy the text out ourselves, then free the original.
    return_release = (arg_type_str != 'c_wchar_p_ptr'
                      and free_mode != 'none'
                      and res_type_str in ('c_wchar_p', 'c_char_p'))
    if return_release:
        func.restype = c_void_p
    else:
        func.restype = type_map.get(res_type_str, c_wchar_p)

    # Encode the payload once: every iteration must send byte-identical input, and
    # the encoding cost should not be attributed to the DLL.
    input_bytes = input_str.encode('utf-8')

    oleaut32 = None
    ole32 = None
    if free_mode == 'sysfree':
        oleaut32 = ctypes.WinDLL('oleaut32')
        oleaut32.SysFreeString.argtypes = [ctypes.c_void_p]
        oleaut32.SysFreeString.restype = None
    elif free_mode == 'cotaskmem':
        ole32 = ctypes.WinDLL('ole32')
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree.restype = None

    def release_raw(raw):
        """Hand a DLL-allocated buffer (raw address) back to its allocator."""
        if not raw:
            return
        if on_release is not None:
            on_release(raw)
        if oleaut32 is not None:
            oleaut32.SysFreeString(raw)
        elif ole32 is not None:
            ole32.CoTaskMemFree(raw)

    def release(ptr_obj):
        """Hand the DLL-allocated out buffer back to its allocator, if asked."""
        release_raw(ctypes.cast(ptr_obj, ctypes.c_void_p).value)

    def timed(*args):
        """The foreign call itself, with its wall and CPU time left in `last`."""
        if clock is not None:
            c0 = clock.cycles()
            t0 = perf()
            r = func(*args)
            t1 = perf()
            last[1] = clock.to_ms(clock.cycles() - c0)
            last[0] = (t1 - t0) * 1000.0
        else:
            t0 = perf()
            r = func(*args)
            last[0] = (perf() - t0) * 1000.0
        return r

    def call():
        """Invoke once and return a short digest of the result, nothing retained."""
        if arg_type_str == 'c_wchar_p_ptr':
            out = c_wchar_p()
            res = timed(input_str, byref(out))
            text = out.value or ''
            digest = hashlib.sha1(text.encode('utf-8', 'replace')).hexdigest()[:12]
            size = len(text)
            if free_mode != 'none':
                release(out)
            return digest, size, res
        if arg_type_str == 'c_char_p':
            res = timed(input_bytes)
        else:
            res = timed(input_str)
        if return_release:
            # res is the raw address of the DLL-allocated string (or None).
            if not res:
                payload = ''
            elif res_type_str == 'c_wchar_p':
                payload = ctypes.wstring_at(res)
            else:
                payload = ctypes.string_at(res).decode('utf-8', errors='replace')
            release_raw(res)
        elif res_type_str == 'c_double':
            payload = repr(float(res) if res is not None else 0.0)
        elif isinstance(res, bytes):
            payload = res.decode('utf-8', errors='replace')
        else:
            payload = res or ''
        digest = hashlib.sha1(payload.encode('utf-8', 'replace')).hexdigest()[:12]
        return digest, len(payload), res

    call.last = last
    return call


def install_crash_probe(tracker=None):
    """Load fnp_tracker.dll just for its exception recorder (when it is built).

    Returns the Tracker instance (shared with allocation tracking if one exists) or
    None. A missing/unloadable helper must never stop a profile run."""
    try:
        if tracker is None:
            from native_tools import Tracker
            tracker = Tracker()
        tracker.crash_install()
        return tracker
    except Exception:
        return None


def collect_crash(probe, symbol_path, dll=None):
    """Symbolized description of the last hardware exception, or None."""
    if probe is None:
        return None
    try:
        if dll is not None:
            probe.dll.fnp_tracker_set_target(dll._handle)
        return probe.crash_report(symbol_path or '')
    except Exception:
        return None


def describe_crash(crash):
    """One line naming the fault, e.g. 'read access violation at 0x... in Foo (file:12)'."""
    if not crash:
        return ''
    kinds = {0: 'reading', 1: 'writing', 8: 'executing'}
    code = crash.get('code', '')
    what = {'0xC0000005': 'Access violation', '0xC0000374': 'Heap corruption detected',
            '0xC0000409': 'Fast-fail (stack buffer overrun / CFG)', '0xC00000FD': 'Stack overflow',
            '0xC0000094': 'Integer divide by zero', '0xC000001D': 'Illegal instruction',
            '0xC0000006': 'In-page error'}.get(code, 'Exception ' + code)
    if code in ('0xC0000005', '0xC0000006'):
        what += ' ' + kinds.get(crash.get('kind'), 'accessing') + ' ' + crash.get('address', '')
    frames = crash.get('frames') or []
    top = frames[0] if frames else None
    where = ''
    if top:
        where = ' in ' + top.get('module', '?') + '!' + top.get('func', '?')
        if top.get('file'):
            where += ' (' + top['file'].replace('/', '\\').split('\\')[-1] + ':' + str(top.get('line', 0)) + ')'
    return what + where


VERDICT_RANK = {'insufficient': 0, 'clean': 1, 'suspect': 2, 'leak': 3}


def decide_verdict(n, priv_fit, heap_fits):
    """Combine the private-bytes fit with the heap fits into one verdict.

    priv_fit / heap_fits entries are (slope, r2, net_growth). The heap is the
    authority when it is readable: *live allocated* bytes and *non-heap* private
    bytes (VirtualAlloc, mapped views) are the two places memory can really be held.
    Growth in private bytes that neither of them explains is committed-but-free
    memory the allocator has not returned: fragmentation, not a leak.

    Returns (verdict, basis).
    """
    p_slope, p_r2, p_net = priv_fit
    v_priv = classify(p_slope, p_r2, p_net, n)
    if heap_fits is None:
        return v_priv, 'private bytes'

    v_live = classify(*heap_fits['live'], n)
    v_non = classify(*heap_fits['nonheap'], n)
    worst, basis = max(((v_live, 'live heap allocations'), (v_non, 'non-heap memory')),
                       key=lambda t: VERDICT_RANK[t[0]])
    if VERDICT_RANK[worst] >= VERDICT_RANK['suspect']:
        return worst, basis
    if v_live == 'insufficient':
        return 'insufficient', basis
    if VERDICT_RANK[v_priv] >= VERDICT_RANK['suspect']:
        return 'suspect', 'committed memory only'
    return 'clean', 'live heap allocations'


def fit_triple(series, warmup):
    seg = series[warmup:]
    slope, r2 = linreg(seg, warmup)
    net = int(seg[-1] - seg[0]) if len(seg) >= 2 else 0
    return slope, r2, net


_PLUMBING_PREFIXES = ('operator new', 'operator delete', 'std::', 'malloc', 'free', 'calloc',
                      'realloc', '_aligned', '_malloc', '_calloc', '_recalloc', '_strdup', '_wcsdup',
                      'HeapAlloc', 'HeapFree', 'SysAllocString', 'CoTaskMemAlloc')
_PLUMBING_PATHS = ('\\vctools\\', '\\vc\\tools\\msvc\\', '\\windows kits\\', '\\ucrt\\',
                   '\\vcruntime\\', '\\vcstartup\\')


def is_plumbing_frame(fr):
    """True for allocator / C++ runtime / STL frames that are not the DLL's own logic."""
    func = fr.get('func') or ''
    if func.startswith(_PLUMBING_PREFIXES):
        return True
    path = (fr.get('file') or '').lower()
    return any(p in path for p in _PLUMBING_PATHS)


def run_tracker_report(tracker, symbol_path, warmup, measured_count, top_sites, target_name):
    """Ask the tracker for the surviving allocation sites and enrich them."""
    tracker.set_symbol_path(symbol_path or '')
    fd, path = tempfile.mkstemp(prefix='fnp_leaks_', suffix='.json')
    os.close(fd)
    try:
        rc = tracker.report(path, warmup + 1, top_sites)
        if rc != 0:
            return {'error': f'Tracker report failed (code {rc})'}
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    tname = (data.get('target') or target_name or '').lower()
    recurring_min = max(2, int(0.8 * measured_count))
    for site in data.get('sites', []):
        frames = site.get('frames', [])
        # The allocation site worth reading is the first DLL frame that is the DLL's own
        # code: operator new, malloc wrappers and STL container internals sit above it
        # in every stack and say nothing about who asked for the memory.
        origin = None
        first_in_dll = None
        for k, fr in enumerate(frames):
            if (fr.get('module') or '').lower() != tname:
                continue
            if first_in_dll is None:
                first_in_dll = k
            if not is_plumbing_frame(fr):
                origin = k
                break
        if origin is None:
            origin = first_in_dll if first_in_dll is not None else 0
        # Keep the frames up to the outermost one inside the DLL: what lies beyond is
        # the harness (ctypes / Python internals), which only buries the answer.
        last_in_dll = max((k for k, fr in enumerate(frames)
                           if (fr.get('module') or '').lower() == tname), default=None)
        if last_in_dll is not None and last_in_dll + 1 < len(frames):
            site['frames'] = frames[:last_in_dll + 2]    # plus the caller that entered the DLL
            site['frames_trimmed'] = len(frames) - len(site['frames'])
        site['origin'] = origin if frames else None
        # A leak repeats on (almost) every call; a one-off after warmup is a lazy init
        site['recurring'] = site.get('calls', 0) >= recurring_min
        site['per_call_blocks'] = site['count'] / measured_count if measured_count else 0
        site['per_call_bytes'] = site['bytes'] / measured_count if measured_count else 0
    data['measured_calls'] = measured_count
    return data


def main():
    _setup_channels()
    # A crash-prone DLL must kill the process outright instead of parking on a
    # Windows Error Reporting dialog that would hang the run forever.
    try:
        windll.kernel32.SetErrorMode(0x0001 | 0x0002)
    except Exception:
        pass

    try:
        req = json.loads(sys.stdin.read() or '{}')
    except Exception as e:
        emit({'event': 'error', 'message': f'Bad request payload: {e}'})
        return

    dll_path = req.get('dll_path')
    json_path = req.get('json_path')
    func_name = req.get('function_name')
    arg_type_str = req.get('arg_type', 'c_wchar_p')
    res_type_str = req.get('res_type', 'c_wchar_p')
    iterations = max(1, min(int(req.get('iterations', 20)), 10000))
    warmup = max(0, min(int(req.get('warmup', 3)), iterations - 1))
    interval = max(0.001, float(req.get('sample_interval_ms', 5)) / 1000.0)
    free_mode = req.get('free_mode', 'none')
    unload = bool(req.get('unload_after', True))
    track = bool(req.get('track_allocs', False))
    measure_heap = bool(req.get('measure_heap', True))
    symbol_path = req.get('symbol_path', '') or ''
    top_sites = max(1, min(int(req.get('top_sites', 30)), 200))

    notes = []
    sampler = None
    dll = None
    tracker = None
    crash_probe = None
    # Which step was running when something failed: the DLL call itself, or the
    # harness measuring around it. An exception text alone cannot tell them apart.
    stage = 'loading the input'

    try:
        with open(json_path, 'r', encoding='UTF-8') as f:
            input_str = json.dumps(json.load(f))

        if track:
            try:
                from native_tools import Tracker
                tracker = Tracker()
            except Exception as e:
                notes.append(f'Allocation tracking is unavailable ({type(e).__name__}: {e}). '
                             'Run native\\build.bat to build bin\\fnp_tracker.dll.')
                track = False

        crash_probe = install_crash_probe(tracker)
        heap_meter = HeapMeter(exclude=[tracker.heap] if tracker else [])
        if not measure_heap:
            heap_meter.available = False
            notes.append('Live heap metering is off: the verdict uses private bytes only.')
        clock = CycleClock()

        stage = 'loading the DLL'
        pre_load = mem_event()
        t_load = time.perf_counter()
        dll = WinDLL(dll_path)
        load_ms = (time.perf_counter() - t_load) * 1000.0
        footprint = module_footprint(dll._handle)

        hooked = 0
        if tracker is not None:
            hooked = tracker.attach(dll._handle)
            if hooked < 0:
                notes.append('The allocation tracker could not patch this DLL (it must be a 64-bit '
                             f'image; code {hooked}). No call stacks will be reported.')
            elif hooked == 0:
                notes.append('No allocation imports were found to hook. The DLL probably links the '
                             'CRT statically (/MT) or allocates only through delay-loaded imports, '
                             'so allocation call stacks are unavailable for it.')

        call = build_caller(dll, func_name, arg_type_str, res_type_str,
                            input_str, free_mode,
                            on_release=tracker.untrack if tracker is not None else None,
                            clock=clock if clock.available else None)

        gc.collect()
        baseline = mem_event()
        base_heap = None
        if heap_meter.available:
            ha, hc = heap_meter.read()
            base_heap = {'alloc': ha, 'commit': hc}

        emit({'event': 'start',
              'iterations': iterations,
              'warmup': warmup,
              'input_bytes': len(input_str),
              'load_ms': round(load_ms, 3),
              'pre_load': pre_load,
              'baseline': baseline,
              'baseline_heap': base_heap,
              'module': footprint,
              'free_mode': free_mode,
              'tracking': {'requested': bool(req.get('track_allocs', False)),
                           'active': tracker is not None and hooked > 0,
                           'hooked': hooked},
              'symbols': req.get('symbols'),
              'cpu_clock': clock.available})

        # Fixed-width buffers: the harness must stay allocation-flat per iteration
        # or its own growth would be indistinguishable from the DLL's.
        priv = array.array('q', bytes(8 * iterations))
        rss = array.array('q', bytes(8 * iterations))
        peaks = array.array('q', bytes(8 * iterations))
        h_alloc = array.array('q', bytes(8 * iterations))
        h_commit = array.array('q', bytes(8 * iterations))
        durations = array.array('d', bytes(8 * iterations))    # foreign call only
        totals = array.array('d', bytes(8 * iterations))       # call + harness work
        cpus = array.array('d', bytes(8 * iterations))

        hashes = {}
        out_size = 0
        after_first = None
        peak_private = baseline['private']
        peak_rss = baseline['rss']

        sampler = PeakSampler(interval)
        sampler.start()

        for i in range(iterations):
            sampler.peak_private = 0
            sampler.peak_rss = 0
            if tracker is not None:
                tracker.begin_call(i + 1)
            stage = f'DLL call {i + 1}'
            sampler.arm()
            t0 = time.perf_counter()
            digest, size, _ = call()
            total = (time.perf_counter() - t0) * 1000.0
            stage = f'memory measurement after call {i + 1}'
            imm_private, imm_rss = mem()
            sampler.disarm()

            call_peak = max(sampler.peak_private, imm_private)
            call_peak_rss = max(sampler.peak_rss, imm_rss)
            gc.collect()
            held_private, held_rss = mem()
            if heap_meter.available:
                stage = f'heap measurement after call {i + 1}'
                held_alloc, held_commit = heap_meter.read()
            else:
                held_alloc = held_commit = 0

            elapsed, cpu_ms = call.last
            priv[i] = held_private
            rss[i] = held_rss
            peaks[i] = call_peak
            h_alloc[i] = held_alloc
            h_commit[i] = held_commit
            durations[i] = elapsed
            totals[i] = total
            cpus[i] = cpu_ms
            out_size = size
            peak_private = max(peak_private, call_peak)
            peak_rss = max(peak_rss, call_peak_rss)

            if len(hashes) < 64 or digest in hashes:
                hashes[digest] = hashes.get(digest, 0) + 1
            if i == 0:
                after_first = {'private': held_private, 'rss': held_rss}

            emit({'event': 'iter',
                  'i': i + 1,
                  'warmup': i < warmup,
                  'private': held_private,
                  'rss': held_rss,
                  'heap_alloc': held_alloc,
                  'heap_commit': held_commit,
                  'peak': call_peak,
                  'transient': max(0, call_peak - held_private),
                  'ms': round(elapsed, 3),
                  'cpu_ms': round(cpu_ms, 3),
                  'out_bytes': size,
                  'hash': digest})

        sampler.shutdown()
        sampler = None
        stage = 'analysing the results'

        final = {'private': priv[iterations - 1], 'rss': rss[iterations - 1]}
        final_heap = ({'alloc': h_alloc[iterations - 1], 'commit': h_commit[iterations - 1]}
                      if heap_meter.available else None)

        # Regression runs on the post-warmup segment only: lazy singletons, caches
        # and heap-arena warmup make the opening calls grow for legitimate reasons.
        measured = priv[warmup:]
        slope, r2 = linreg(measured, warmup)
        net_growth = int(measured[-1] - measured[0]) if len(measured) >= 2 else 0

        heap_fits = None
        heap_summary = None
        if heap_meter.available:
            nonheap = array.array('q', (priv[k] - h_commit[k] for k in range(iterations)))
            heap_fits = {
                'live': fit_triple(h_alloc, warmup),
                'commit': fit_triple(h_commit, warmup),
                'nonheap': fit_triple(nonheap, warmup),
            }
            heap_summary = {
                'baseline': base_heap,
                'final': final_heap,
                'slope_alloc': heap_fits['live'][0], 'r2_alloc': heap_fits['live'][1],
                'net_alloc': heap_fits['live'][2],
                'slope_commit': heap_fits['commit'][0], 'r2_commit': heap_fits['commit'][1],
                'net_commit': heap_fits['commit'][2],
                'slope_nonheap': heap_fits['nonheap'][0], 'r2_nonheap': heap_fits['nonheap'][1],
                'net_nonheap': heap_fits['nonheap'][2],
                'verdict_live': classify(*heap_fits['live'], len(measured)),
                'verdict_nonheap': classify(*heap_fits['nonheap'], len(measured)),
                'verdict_private': classify(slope, r2, net_growth, len(measured)),
            }
        verdict, basis = decide_verdict(len(measured), (slope, r2, net_growth), heap_fits)

        # Surviving allocation sites, collected while the DLL is still loaded so the
        # PDB can be matched against its image.
        leaks = None
        if tracker is not None and hooked > 0:
            leaks = run_tracker_report(tracker, symbol_path, warmup, len(measured), top_sites,
                                       os.path.basename(dll_path))
            if 'error' not in leaks:
                leaks['stats'] = tracker.stats()
                recurring = [s for s in leaks.get('sites', []) if s.get('recurring')]
                if verdict == 'clean' and recurring:
                    # Heap-level thresholds can hide a small steady leak; the stacks cannot.
                    verdict, basis = 'suspect', 'allocation tracker'
                    notes.append('Memory looks flat overall, but the allocation tracker found '
                                 f'{len(recurring)} call site(s) that keep a block alive on almost '
                                 'every call. See "Leak sites" below.')
                if leaks.get('symbols', {}).get('sym_type', -1) not in (1, 2, 3, 6, 7) and leaks.get('sites'):
                    notes.append('Function names were not resolved from a PDB. Check the Symbols '
                                 'status in Configuration - frames show module+offset until it matches.')

        after_unload = None
        if unload:
            windll.kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
            windll.kernel32.FreeLibrary.restype = wintypes.BOOL
            windll.kernel32.FreeLibrary(dll._handle)
            dll = None
            gc.collect()
            time.sleep(0.05)
            after_unload = mem_event()

        transients = [max(0, peaks[i] - priv[i]) for i in range(iterations)]
        durs = list(durations[warmup:]) or list(durations)
        cpu_durs = list(cpus[warmup:]) or list(cpus)
        tot_durs = list(totals[warmup:]) or list(totals)
        dstats = duration_stats(durs, cpu_durs if clock.available else None)
        dstats['total_ms'] = sum(durations)
        dstats['first_ms'] = durations[0]
        dstats['harness_avg_ms'] = (sum(tot_durs) - sum(durs)) / len(durs)
        dstats['cpu_available'] = clock.available

        if arg_type_str == 'c_wchar_p_ptr' and free_mode == 'none':
            notes.append(
                'Out-pointer mode with no release strategy: the buffer the DLL '
                'allocates for every call is never freed by this harness, so any '
                'growth shown may be the test, not the DLL. Re-run with '
                'SysFreeString (BSTR) or CoTaskMemFree to measure the DLL alone.')
        if (arg_type_str != 'c_wchar_p_ptr' and free_mode == 'none'
                and res_type_str in ('c_wchar_p', 'c_char_p')):
            notes.append(
                'Returned-string mode with no release strategy: ctypes copies the '
                'returned text and the buffer the DLL allocated is never freed by '
                'this harness, so any growth shown may be the test, not the DLL. '
                'If the DLL returns a BSTR (or CoTaskMemAlloc memory), re-run with '
                'SysFreeString or CoTaskMemFree to measure the DLL alone.')
        if warmup == 0 and iterations > 3:
            notes.append(
                'Warmup is 0, so first-call lazy initialisation is included in the '
                'regression and inflates the slope. A warmup of 2-3 is usually right.')
        if len(measured) < 4:
            notes.append(
                f'Only {len(measured)} measured iterations after warmup - too few '
                'for a reliable slope. Raise the iteration count.')
        if verdict == 'clean' and slope > NOISE_FLOOR_BPI and heap_fits is None:
            notes.append(
                'Total growth is small enough to be inconclusive rather than '
                'proven clean. Raise the iteration count to confirm.')
        if basis == 'committed memory only':
            notes.append(
                'Private bytes keep growing but live heap allocations do not: the heap is '
                'holding freed pages committed (fragmentation or allocator caching). This is '
                'usually not a leak; raise the iteration count to see whether it plateaus.')
        if heap_summary is None and measure_heap:
            notes.append('HeapSummary was not readable, so the verdict uses private bytes only.')
        if tracker is not None:
            notes.append('Allocation tracking is on: it slows every allocation and keeps '
                         'bookkeeping per live block, so durations from this run are not '
                         'representative. Use the Speed Profiler for timing.')
        if len(hashes) > 1:
            notes.append(
                f'{len(hashes)} distinct output digests across {iterations} runs - '
                'the DLL is not deterministic for this input, so retained memory '
                'may legitimately differ per call.')

        emit({'event': 'done',
              'summary': {
                  'iterations': iterations,
                  'warmup': warmup,
                  'measured_count': len(measured),
                  'module': footprint,
                  'load_ms': round(load_ms, 3),
                  'pre_load': pre_load,
                  'baseline': baseline,
                  'after_first': after_first,
                  'final': final,
                  'after_unload': after_unload,
                  'first_call_cost': (after_first['private'] - baseline['private'])
                                     if after_first else 0,
                  'peak_private': peak_private,
                  'peak_rss': peak_rss,
                  'slope_bytes_per_iter': slope,
                  'r2': r2,
                  'net_growth': net_growth,
                  'projection_10k': int(slope * 10000),
                  'transient_avg': int(sum(transients) / len(transients)) if transients else 0,
                  'transient_max': max(transients) if transients else 0,
                  'heap': heap_summary,
                  'duration': dstats,
                  'output': {
                      'distinct': len(hashes),
                      'distinct_capped': len(hashes) >= 64,
                      'stable': len(hashes) == 1,
                      'bytes': out_size,
                  },
                  'verdict': verdict,
                  'verdict_basis': basis,
                  'leaks': leaks,
                  'thresholds': {
                      'noise_floor_bpi': NOISE_FLOOR_BPI,
                      'strong_slope_bpi': STRONG_SLOPE_BPI,
                      'r2_confident': R2_CONFIDENT,
                  },
                  'notes': notes,
              },
              'logs': read_log_tail()})

    except Exception as e:
        import traceback
        crash = collect_crash(crash_probe, symbol_path, dll)
        emit({'event': 'error',
              'message': f'{type(e).__name__}: {e}',
              'stage': stage,
              'crash': crash,
              'crash_summary': describe_crash(crash),
              'traceback': traceback.format_exc(),
              'logs': read_log_tail()})
    finally:
        if sampler is not None:
            sampler.shutdown()
        try:
            if _channel:
                _channel.flush()
        except Exception:
            pass


if __name__ == '__main__':
    main()
