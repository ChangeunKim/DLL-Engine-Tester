"""Locating and driving the native helpers in bin/ (built by native/build.bat)."""

import ctypes
import os
import subprocess
import sys
import time
from ctypes import POINTER, c_int, c_uint32, c_uint64, c_void_p, c_wchar_p

ROOT = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(ROOT, 'bin')
TRACKER_DLL = os.path.join(BIN, 'fnp_tracker.dll')
SAMPLER_EXE = os.path.join(BIN, 'fnp_sampler.exe')
TEST_DLL = os.path.join(BIN, 'fnp_testdll.dll')
BUILD_HINT = 'Run native\\build.bat once (Visual Studio 2022 C++ tools) to build the helpers.'


def native_status():
    return {
        'tracker': os.path.isfile(TRACKER_DLL),
        'sampler': os.path.isfile(SAMPLER_EXE),
        'test_dll': TEST_DLL if os.path.isfile(TEST_DLL) else '',
        'bin': BIN,
        'hint': BUILD_HINT,
    }


def pe_machine(path):
    """-> 'x64' / 'x86' / None for a PE file."""
    try:
        with open(path, 'rb') as f:
            head = f.read(4096)
        if head[:2] != b'MZ':
            return None
        off = int.from_bytes(head[0x3C:0x40], 'little')
        machine = int.from_bytes(head[off + 4:off + 6], 'little')
        return {0x8664: 'x64', 0x14C: 'x86', 0xAA64: 'arm64'}.get(machine)
    except Exception:
        return None


class Tracker:
    """ctypes front for fnp_tracker.dll (runs inside the profile runner process)."""

    def __init__(self):
        self.dll = ctypes.CDLL(TRACKER_DLL)
        d = self.dll
        d.fnp_tracker_init.restype = c_int
        d.fnp_tracker_heap.restype = c_void_p
        d.fnp_tracker_attach.argtypes = [c_void_p]
        d.fnp_tracker_attach.restype = c_int
        d.fnp_tracker_begin_call.argtypes = [c_uint32]
        d.fnp_tracker_begin_call.restype = None
        d.fnp_untrack.argtypes = [c_void_p]
        d.fnp_untrack.restype = None
        d.fnp_tracker_set_symbol_path.argtypes = [c_wchar_p]
        d.fnp_tracker_set_symbol_path.restype = None
        d.fnp_tracker_report.argtypes = [c_wchar_p, c_uint32, c_int]
        d.fnp_tracker_report.restype = c_int
        d.fnp_tracker_stats.argtypes = [POINTER(c_uint64)] * 4
        d.fnp_tracker_stats.restype = None
        d.fnp_tracker_set_target.argtypes = [c_void_p]
        d.fnp_tracker_set_target.restype = None
        d.fnp_crash_install.restype = None
        d.fnp_crash_clear.restype = None
        d.fnp_crash_report.argtypes = [c_wchar_p]
        d.fnp_crash_report.restype = c_int
        if not d.fnp_tracker_init():
            raise RuntimeError('fnp_tracker_init failed')
        self.heap = d.fnp_tracker_heap()
        self.attached = 0

    def crash_install(self, hmodule=None):
        """Record where hardware exceptions happen (see collect_crash)."""
        if hmodule:
            self.dll.fnp_tracker_set_target(hmodule)
        self.dll.fnp_crash_install()

    def crash_report(self, symbol_path=''):
        """-> dict describing the last fatal exception (with symbolized stack), or None."""
        import json
        import tempfile
        self.set_symbol_path(symbol_path)
        fd, path = tempfile.mkstemp(prefix='fnp_crash_', suffix='.json')
        os.close(fd)
        try:
            rc = self.dll.fnp_crash_report(path)
            if rc != 0:
                return None
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def attach(self, hmodule):
        self.attached = self.dll.fnp_tracker_attach(hmodule)
        return self.attached

    def begin_call(self, n):
        self.dll.fnp_tracker_begin_call(n)

    def untrack(self, ptr):
        self.dll.fnp_untrack(ptr)

    def set_symbol_path(self, path):
        self.dll.fnp_tracker_set_symbol_path(path or '')

    def report(self, out_path, min_call, top_n=30):
        return self.dll.fnp_tracker_report(out_path, min_call, top_n)

    def stats(self):
        v = [c_uint64() for _ in range(4)]
        self.dll.fnp_tracker_stats(*[ctypes.pointer(x) for x in v])
        return {'allocs': v[0].value, 'frees': v[1].value,
                'live_blocks': v[2].value, 'live_bytes': v[3].value}


class SamplerProcess:
    """fnp_sampler.exe attached to one thread of this process."""

    def __init__(self, tid, module_name, symbol_path, out_path, interval_us=1000):
        self.out_path = out_path
        self.proc = subprocess.Popen(
            [SAMPLER_EXE, '--pid', str(os.getpid()), '--tid', str(tid),
             '--module', module_name, '--symbols', symbol_path or '',
             '--out', out_path, '--interval-us', str(int(interval_us))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)

    def wait_ready(self, timeout=30.0):
        """Blocks until symbols are initialised. Returns an error string or ''."""
        import threading
        result = {}

        def reader():
            result['line'] = self.proc.stdout.readline()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            return 'The sampler did not start within %.0fs' % timeout
        if result.get('line', '').strip() != 'ready':
            err = ''
            try:
                err = self.proc.stderr.read()
            except Exception:
                pass
            return 'The sampler failed to start: %s' % (err.strip() or 'exit code %s' % self.proc.poll())
        return ''

    def stop(self, timeout=60.0):
        """Ends sampling and returns the parsed report dict (or an error string)."""
        import json
        try:
            self.proc.stdin.write('stop\n')
            self.proc.stdin.flush()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return 'The sampler took too long to symbolize the samples'
        if self.proc.returncode != 0:
            err = ''
            try:
                err = self.proc.stderr.read()
            except Exception:
                pass
            return 'The sampler exited with code %s: %s' % (self.proc.returncode, err.strip())
        try:
            with open(self.out_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            return 'Could not read the sampler report: %s' % e

    def kill(self):
        try:
            if self.proc.poll() is None:
                self.proc.kill()
        except Exception:
            pass
