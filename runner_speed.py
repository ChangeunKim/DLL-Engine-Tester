"""Speed profiling runner: how long a DLL call takes, and where the time goes.

Two phases, in one fresh process (the DLL is loaded once):

  1. timing    N calls with nothing else attached. Gives clean wall/CPU durations,
               percentiles and the first-call cost. Nothing perturbs these numbers.
  2. sampling  M more calls with fnp_sampler.exe attached. The sampler runs in a
               separate process (suspending a thread that holds a heap lock and then
               allocating in the same process would deadlock) and takes a stack
               trace of the calling thread every interval. Samples whose stack passes
               through the DLL become a flat profile and a call tree.

The phases are separate because sampling suspends the thread for ~50-150 us per
sample, which would inflate the timing statistics if they shared a run.

Emits NDJSON on a private channel exactly like runner_profile.py.
"""

import gc
import json
import os
import sys
import tempfile
import threading
import time
from ctypes import WinDLL, windll

import runner_profile as rp


def main():
    rp._setup_channels()
    try:
        windll.kernel32.SetErrorMode(0x0001 | 0x0002)
    except Exception:
        pass

    try:
        req = json.loads(sys.stdin.read() or '{}')
    except Exception as e:
        rp.emit({'event': 'error', 'message': f'Bad request payload: {e}'})
        return

    dll_path = req.get('dll_path')
    json_path = req.get('json_path')
    func_name = req.get('function_name')
    arg_type_str = req.get('arg_type', 'c_wchar_p')
    res_type_str = req.get('res_type', 'c_wchar_p')
    iterations = max(1, min(int(req.get('iterations', 30)), 10000))
    warmup = max(0, min(int(req.get('warmup', 3)), iterations - 1))
    free_mode = req.get('free_mode', 'none')
    sample = bool(req.get('sample', True))
    sample_calls = max(1, min(int(req.get('sample_calls', iterations)), 10000))
    interval_us = max(200, min(int(req.get('interval_us', 1000)), 100000))
    symbol_path = req.get('symbol_path', '') or ''

    notes = []
    sampler = None
    dll = None
    out_path = os.path.join(tempfile.gettempdir(), f'fnp_speed_{os.getpid()}.json')

    try:
        with open(json_path, 'r', encoding='UTF-8') as f:
            input_str = json.dumps(json.load(f))

        clock = rp.CycleClock()
        t_load = time.perf_counter()
        dll = WinDLL(dll_path)
        load_ms = (time.perf_counter() - t_load) * 1000.0
        call = rp.build_caller(dll, func_name, arg_type_str, res_type_str, input_str,
                               free_mode, clock=clock if clock.available else None)

        sampler_ok = False
        if sample:
            from native_tools import SAMPLER_EXE, BUILD_HINT
            sampler_ok = os.path.isfile(SAMPLER_EXE)
            if not sampler_ok:
                notes.append('Hot-spot sampling is unavailable: bin\\fnp_sampler.exe is missing. '
                             + BUILD_HINT)

        rp.emit({'event': 'start',
                 'iterations': iterations,
                 'warmup': warmup,
                 'sample': bool(sample and sampler_ok),
                 'sample_calls': sample_calls if sample and sampler_ok else 0,
                 'interval_us': interval_us,
                 'input_bytes': len(input_str),
                 'load_ms': round(load_ms, 3),
                 'symbols': req.get('symbols'),
                 'cpu_clock': clock.available})

        # --- Phase 1: timing ------------------------------------------------------
        rp.emit({'event': 'phase', 'phase': 'timing'})
        walls, cpus = [], []
        out_size = 0
        gc.collect()
        gc.disable()    # a collection landing inside a call would read as a slow call
        try:
            for i in range(iterations):
                digest, size, _ = call()
                walls.append(call.last[0])
                cpus.append(call.last[1])
                out_size = size
                rp.emit({'event': 'iter', 'phase': 'timing', 'i': i + 1, 'warmup': i < warmup,
                         'ms': round(call.last[0], 4), 'cpu_ms': round(call.last[1], 4),
                         'hash': digest})
        finally:
            gc.enable()

        m_wall = walls[warmup:] or walls
        m_cpu = cpus[warmup:] or cpus
        timing = rp.duration_stats(m_wall, m_cpu if clock.available else None)
        timing['first_ms'] = walls[0]
        timing['total_ms'] = sum(walls)
        timing['cpu_available'] = clock.available
        timing['cpu_total_ms'] = sum(m_cpu) if clock.available else None
        timing['measured'] = len(m_wall)
        timing['warmup'] = warmup

        # --- Phase 2: sampling ----------------------------------------------------
        sampling = None
        if sample and sampler_ok:
            from native_tools import SamplerProcess
            rp.emit({'event': 'phase', 'phase': 'sampling', 'sample_calls': sample_calls})
            sampler = SamplerProcess(threading.get_native_id(), os.path.basename(dll_path),
                                     symbol_path, out_path, interval_us)
            err = sampler.wait_ready()
            if err:
                notes.append(err)
                sampler.kill()
                sampler = None
            else:
                sampled_ms = []
                sampled_cpu = []
                for i in range(sample_calls):
                    call()
                    sampled_ms.append(call.last[0])
                    sampled_cpu.append(call.last[1])
                    rp.emit({'event': 'iter', 'phase': 'sampling', 'i': i + 1,
                             'ms': round(call.last[0], 4)})
                rep = sampler.stop()
                sampler = None
                if isinstance(rep, str):
                    notes.append(rep)
                else:
                    in_dll = rep.get('samples_in_dll', 0)
                    achieved = rep.get('achieved_interval_us') or interval_us
                    total_ms = sum(sampled_ms)
                    covered_ms = in_dll * achieved / 1000.0
                    rep['sampled_calls'] = sample_calls
                    rep['sampled_call_ms'] = total_ms
                    rep['sampled_cpu_ms'] = sum(sampled_cpu) if clock.available else None
                    rep['coverage'] = (covered_ms / total_ms) if total_ms else 0.0
                    rep['sampled_avg_ms'] = total_ms / sample_calls
                    sampling = rep
                    if in_dll < 50:
                        notes.append(
                            f'Only {in_dll} samples landed in the DLL. The profile is statistical; '
                            'raise "Sampled calls" or lower the interval for a steadier picture.')
                    if rep.get('symbols', {}).get('sym_type', -1) not in (1, 2, 3, 6, 7):
                        notes.append('Function names were not resolved from a PDB, so frames show '
                                     'module+offset. Check the Symbols status in Configuration.')
                    if not rep.get('target_found', True):
                        notes.append('The sampler could not find the DLL inside the process.')

        if sample and sampler_ok and sampling is not None:
            notes.append('Timing statistics come from phase 1 (no sampler attached); the flame '
                         'graph comes from phase 2, whose calls run a few percent slower while '
                         'being sampled.')
        if len(m_wall) < 5:
            notes.append(f'Only {len(m_wall)} measured calls after warmup - percentiles need more.')
        if timing.get('stdev_ms', 0) > 0.25 * timing.get('avg_ms', 1) and len(m_wall) >= 5:
            notes.append('Call time varies a lot between calls (stdev above 25% of the mean). '
                         'Look at p95/p99 and the per-call chart; background load or lazy work '
                         'inside the DLL can cause this.')

        rp.emit({'event': 'done',
                 'summary': {'timing': timing, 'sampling': sampling, 'output_bytes': out_size,
                             'load_ms': round(load_ms, 3), 'notes': notes},
                 'logs': rp.read_log_tail()})

    except Exception as e:
        import traceback
        rp.emit({'event': 'error', 'message': f'{type(e).__name__}: {e}',
                 'traceback': traceback.format_exc(), 'logs': rp.read_log_tail()})
    finally:
        if sampler is not None:
            sampler.kill()
        try:
            if rp._channel:
                rp._channel.flush()
        except Exception:
            pass
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass


if __name__ == '__main__':
    main()
