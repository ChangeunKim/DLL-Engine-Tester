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

def build_caller(dll, func_name, arg_type_str, res_type_str, input_str, free_mode):
    """Return a zero-argument callable that performs exactly one DLL invocation."""
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
        if oleaut32 is not None:
            oleaut32.SysFreeString(raw)
        elif ole32 is not None:
            ole32.CoTaskMemFree(raw)

    def release(ptr_obj):
        """Hand the DLL-allocated out buffer back to its allocator, if asked."""
        release_raw(ctypes.cast(ptr_obj, ctypes.c_void_p).value)

    def call():
        """Invoke once and return a short digest of the result, nothing retained."""
        if arg_type_str == 'c_wchar_p_ptr':
            out = c_wchar_p()
            res = func(input_str, byref(out))
            text = out.value or ''
            digest = hashlib.sha1(text.encode('utf-8', 'replace')).hexdigest()[:12]
            size = len(text)
            if free_mode != 'none':
                release(out)
            return digest, size, res
        if arg_type_str == 'c_char_p':
            res = func(input_bytes)
        else:
            res = func(input_str)
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

    return call


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

    notes = []
    sampler = None
    dll = None

    try:
        with open(json_path, 'r', encoding='UTF-8') as f:
            input_str = json.dumps(json.load(f))

        pre_load = mem_event()
        t_load = time.perf_counter()
        dll = WinDLL(dll_path)
        load_ms = (time.perf_counter() - t_load) * 1000.0
        footprint = module_footprint(dll._handle)

        call = build_caller(dll, func_name, arg_type_str, res_type_str,
                            input_str, free_mode)

        gc.collect()
        baseline = mem_event()

        emit({'event': 'start',
              'iterations': iterations,
              'warmup': warmup,
              'input_bytes': len(input_str),
              'load_ms': round(load_ms, 3),
              'pre_load': pre_load,
              'baseline': baseline,
              'module': footprint,
              'free_mode': free_mode})

        # Fixed-width buffers: the harness must stay allocation-flat per iteration
        # or its own growth would be indistinguishable from the DLL's.
        priv = array.array('q', bytes(8 * iterations))
        rss = array.array('q', bytes(8 * iterations))
        peaks = array.array('q', bytes(8 * iterations))
        durations = array.array('d', bytes(8 * iterations))

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
            sampler.arm()
            t0 = time.perf_counter()
            digest, size, _ = call()
            elapsed = (time.perf_counter() - t0) * 1000.0
            imm_private, imm_rss = mem()
            sampler.disarm()

            call_peak = max(sampler.peak_private, imm_private)
            call_peak_rss = max(sampler.peak_rss, imm_rss)
            gc.collect()
            held_private, held_rss = mem()

            priv[i] = held_private
            rss[i] = held_rss
            peaks[i] = call_peak
            durations[i] = elapsed
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
                  'peak': call_peak,
                  'transient': max(0, call_peak - held_private),
                  'ms': round(elapsed, 3),
                  'out_bytes': size,
                  'hash': digest})

        sampler.shutdown()
        sampler = None

        final = {'private': priv[iterations - 1], 'rss': rss[iterations - 1]}

        after_unload = None
        if unload:
            windll.kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
            windll.kernel32.FreeLibrary.restype = wintypes.BOOL
            windll.kernel32.FreeLibrary(dll._handle)
            dll = None
            gc.collect()
            time.sleep(0.05)
            after_unload = mem_event()

        # Regression runs on the post-warmup segment only: lazy singletons, caches
        # and heap-arena warmup make the opening calls grow for legitimate reasons.
        measured = priv[warmup:]
        slope, r2 = linreg(measured, warmup)
        net_growth = int(measured[-1] - measured[0]) if len(measured) >= 2 else 0
        verdict = classify(slope, r2, net_growth, len(measured))

        transients = [max(0, peaks[i] - priv[i]) for i in range(iterations)]
        durs = durations[warmup:] or durations

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
        if verdict == 'clean' and slope > NOISE_FLOOR_BPI:
            notes.append(
                'Total growth is small enough to be inconclusive rather than '
                'proven clean. Raise the iteration count to confirm.')
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
                  'duration': {
                      'avg_ms': sum(durs) / len(durs),
                      'min_ms': min(durs),
                      'max_ms': max(durs),
                      'total_ms': sum(durations),
                  },
                  'output': {
                      'distinct': len(hashes),
                      'distinct_capped': len(hashes) >= 64,
                      'stable': len(hashes) == 1,
                      'bytes': out_size,
                  },
                  'verdict': verdict,
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
        emit({'event': 'error',
              'message': f'{type(e).__name__}: {e}',
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
