import os
import sys
import json
import logging
import subprocess
import threading
from flask import Flask, render_template, request, jsonify, Response, stream_with_context

import native_tools
import symbols as pdb_symbols

app = Flask(__name__)
# Force Flask NOT to sort JSON keys alphabetically (preserves C++ original insertion order)
app.config['JSON_SORT_KEYS'] = False
try:
    app.json.sort_keys = False
except AttributeError:
    pass
    
logging.basicConfig(level=logging.INFO)

@app.route('/')
def index():
    return render_template('index.html')



@app.route('/api/browse')
def native_browse():
    # Opens native Windows File Explorer using a subprocess so it doesn't block Flask threads
    ext = request.args.get('ext', '*')
    initialdir = request.args.get('initialdir', '')

    # Always hand the dialog an explicit folder. With none, Windows reopens wherever
    # the previous dialog of this program was (the DLL's folder when picking a JSON).
    if not initialdir or not os.path.isdir(initialdir):
        project_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'JSON')
        if ext == '.json' and os.path.isdir(project_json):
            initialdir = project_json
        else:
            initialdir = os.path.dirname(os.path.abspath(__file__))
    
    filetypes_code = "()"
    if ext == '.dll':
        filetypes_code = "(('DLL files', '*.dll'), ('All files', '*.*'))"
    elif ext == '.json':
        filetypes_code = "(('JSON files', '*.json'), ('All files', '*.*'))"
    elif ext == '.pdb':
        filetypes_code = "(('PDB symbol files', '*.pdb'), ('All files', '*.*'))"
        
    cmd = f"""import tkinter as tk, tkinter.filedialog as fd
root = tk.Tk()
root.attributes('-topmost', True) # Bring to front
root.withdraw()
path = fd.askopenfilename(initialdir={repr(initialdir)}, filetypes={filetypes_code})
print(path)
"""
    result = subprocess.run([sys.executable, "-c", cmd], capture_output=True, text=True)
    path = result.stdout.strip()
    return jsonify({"status": "success", "path": path})

@app.route('/api/browse_save_as')
def browse_save_as():
    # Native Windows Save As dialog using subprocess to avoid Flask/Tkinter threading conflicts
    initial_dir = os.getcwd()
    cmd = f"""import tkinter as tk, tkinter.filedialog as fd
root = tk.Tk()
root.attributes('-topmost', True) 
root.withdraw()
path = fd.asksaveasfilename(defaultextension=".json", filetypes=[("JSON files", "*.json")], initialdir={repr(initial_dir)})
print(path)
"""
    result = subprocess.run([sys.executable, "-c", cmd], capture_output=True, text=True)
    path = result.stdout.strip()
    
    if path:
        return jsonify({"status": "success", "path": path})
    return jsonify({"status": "error", "message": "No path chosen"})

@app.route('/api/read_json')
def read_json():
    path = request.args.get('path', '')
    if not path or not os.path.exists(path):
        return jsonify({"status": "error", "message": "File not found"})
    try:
        with open(path, 'r', encoding='utf-8') as f:
            # Let it fail gracefully if not valid json, or return raw
            data = f.read()
            # Try parsing for pretty print
            try:
                parsed = json.loads(data)
                data = json.dumps(parsed, indent=2)
            except json.JSONDecodeError:
                pass
        return jsonify({"status": "success", "content": data})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route('/api/save_json', methods=['POST'])
def save_json():
    data = request.json
    path = data.get('path', '')
    content = data.get('content', '')
    
    if not path:
        return jsonify({"status": "error", "message": "No path provided"})
        
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({"status": "success", "message": "File saved successfully"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

# Global references for subprocess management
debug_process = None
last_single_shot_process = None
profile_process = None
profile_lock = threading.Lock()

def cleanup_children():
    """Ensure all child processes are killed when app exists or restarts."""
    global debug_process, last_single_shot_process, profile_process
    for p in [debug_process, last_single_shot_process, profile_process]:
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=1)
            except:
                try: p.kill()
                except: pass

import atexit
atexit.register(cleanup_children)

@app.route('/api/toggle_debug', methods=['POST'])
def toggle_debug():
    global debug_process
    data = request.json
    start = data.get('start', False)
    
    if start:
        if debug_process is None or debug_process.poll() is not None:
            runner_path = os.path.join(os.path.dirname(__file__), 'runner_persistent.py')
            # Use unbuffered output or Popen with text=True and flush guarantees
            debug_process = subprocess.Popen(
                [sys.executable, "-u", runner_path], 
                stdin=subprocess.PIPE, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )
            try:
                # Read the very first line which is the PID
                pid_line = debug_process.stdout.readline()
                pid = int(pid_line.strip())
            except Exception:
                pid = debug_process.pid
            return jsonify({"status": "success", "pid": pid})
        else:
            return jsonify({"status": "success", "pid": debug_process.pid})
    else:
        if debug_process is not None and debug_process.poll() is None:
            try:
                debug_process.stdin.write(json.dumps({"command": "exit"}) + "\n")
                debug_process.stdin.flush()
                debug_process.wait(timeout=2)
            except Exception:
                debug_process.terminate()
            debug_process = None
        return jsonify({"status": "success", "message": "Persistent debugger stopped. DLL Unlocked."})

@app.route('/api/execute', methods=['POST'])
def execute():
    try:
        data = request.json
        dll_path = data.get('dll_path')
        json_path = data.get('json_path')
        func_name = data.get('function_name')
        arg_type = data.get('arg_type', 'c_wchar_p')
        res_type = data.get('res_type', 'c_wchar_p')
        debug_mode = data.get('debug_mode', False)
        
        # Basic validation
        if not os.path.exists(dll_path):
            return jsonify({"status": "error", "message": "DLL file not found"})
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSON file not found"})
            
        # Run the runner.py via subprocess to execute the DLL safely
        runner_path = os.path.join(os.path.dirname(__file__), 'runner.py')
        
        input_payload = {
            "dll_path": dll_path,
            "json_path": json_path,
            "function_name": func_name,
            "arg_type": arg_type,
            "res_type": res_type,
            "debug_mode": debug_mode
        }
        
        global debug_process
        if debug_mode and debug_process is not None and debug_process.poll() is None:
            # Continuous Debug Mode: Route payload to the open persistent process via STDIN
            input_payload["command"] = "execute"
            payload_str = json.dumps(input_payload) + "\n"
            
            try:
                debug_process.stdin.write(payload_str)
                debug_process.stdin.flush()
                # Aggregate stdout line by line until our specialized delimiter to handle intermediate C++ prints
                output_lines = []
                while True:
                    line = debug_process.stdout.readline()
                    if not line or line.strip() == "---END_OF_EXECUTION---":
                        break
                    output_lines.append(line)
                
                if not output_lines:
                    return jsonify({"status": "error", "message": "Persistent runner died unexpectedly. The DLL might have crashed."})
                    
                json_line = output_lines[-1].strip()
                cpp_logs = "".join(output_lines[:-1]).strip()
                
                output_data = json.loads(json_line)
                if cpp_logs:
                    output_data["stdout"] = cpp_logs
                return jsonify(output_data)
                
            except json.JSONDecodeError:
                return jsonify({
                    "status": "success",
                    "is_raw": True,
                    "output": "".join(output_lines).strip()
                })
            except Exception as e:
                return jsonify({"status": "error", "message": f"Persistent Execution Failed: {str(e)}"})
        
        else:
            # Traditional Single-Shot Execution Mode (No memory locks)
            global last_single_shot_process
            
            # Kill previous "zombie" process if it hasn't finished yet
            if last_single_shot_process and last_single_shot_process.poll() is None:
                try:
                    last_single_shot_process.terminate()
                    last_single_shot_process.wait(timeout=1)
                except:
                    pass

            # Use Popen instead of run to have granular control/killability
            last_single_shot_process = subprocess.Popen(
                [sys.executable, runner_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            try:
                # Send input and wait for completion
                stdout, stderr = last_single_shot_process.communicate(
                    input=json.dumps(input_payload),
                    timeout=None if debug_mode else 600
                )
                return_code = last_single_shot_process.returncode
            except subprocess.TimeoutExpired:
                last_single_shot_process.kill()
                return jsonify({"status": "error", "message": "Execution timed out (60s limit for non-debug mode)."})
            
            if return_code != 0:
                return jsonify({
                    "status": "error",
                    "message": f"DLL Execution Failed (Crash or exit code {return_code})",
                    "stdout": stdout,
                    "stderr": stderr
                })
                
            try:
                # Handle scenarios where DLL logs directly to standard out before runner.py prints final JSON
                std_lines = stdout.strip().split('\n')
                if not std_lines:
                    raise json.JSONDecodeError("Empty output", "", 0)
                    
                json_part = std_lines[-1].strip()
                cpp_logs = "\n".join(std_lines[:-1]).strip()
                
                output_data = json.loads(json_part)
                if cpp_logs:
                    output_data["stdout"] = cpp_logs
                return jsonify(output_data)
            except json.JSONDecodeError:
                return jsonify({
                    "status": "success",
                    "is_raw": True,
                    "output": stdout.strip()
                })
            
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Execution timed out."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

def stop_profile_process():
    """Terminate any in-flight memory profile run. Returns True if one was killed."""
    global profile_process
    with profile_lock:
        p = profile_process
        if p is None or p.poll() is not None:
            return False
        try:
            p.terminate()
            p.wait(timeout=2)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        return True

def ndjson_error(message):
    """Single-event NDJSON body, so the client parses failures the same way."""
    return Response(json.dumps({"event": "error", "message": message}) + "\n",
                    mimetype='application/x-ndjson')

def resolve_symbols(data):
    """Validate the DLL/PDB pair once, up front, for whichever profiler is starting."""
    check = pdb_symbols.check_symbols(data.get('dll_path') or '', data.get('pdb_path') or '')
    return check, check.get('symbol_path', '')


def stream_runner(runner_file, payload):
    """Start a profile runner subprocess and stream its NDJSON events to the browser.

    Only one profile run exists at a time (memory and speed share the slot): two runs
    would sample each other's noise.
    """
    global profile_process

    stop_profile_process()

    runner_path = os.path.join(os.path.dirname(__file__), runner_file)
    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", runner_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1
        )
    except Exception as e:
        return ndjson_error(f"Could not start the profile runner: {e}")

    with profile_lock:
        profile_process = proc

    try:
        proc.stdin.write(json.dumps(payload))
        proc.stdin.close()
    except Exception as e:
        stop_profile_process()
        return ndjson_error(f"Could not send the request to the profile runner: {e}")

    def generate():
        try:
            for raw in iter(proc.stdout.readline, ''):
                yield raw
            code = proc.wait()
            # The runner points the DLL's fd 1/2 at a temp log, so anything on
            # stderr here happened before that redirect (an import failure) or is
            # a hard crash message. Either way it is the only clue we get.
            try:
                tail = (proc.stderr.read() or '').strip()
            except Exception:
                tail = ''
            yield json.dumps({"event": "exit", "returncode": code, "stderr": tail}) + "\n"
        except GeneratorExit:
            # Browser hung up (tab closed, fetch aborted) - do not orphan the DLL.
            stop_profile_process()
            raise
        finally:
            for stream in (proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass

    return Response(
        stream_with_context(generate()),
        mimetype='application/x-ndjson',
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        }
    )


def common_profile_args(data):
    """Validate the fields both profilers share. Returns (error, dll, json, func)."""
    dll_path = data.get('dll_path')
    json_path = data.get('json_path')
    func_name = data.get('function_name')
    if not dll_path or not os.path.exists(dll_path):
        return "DLL file not found", None, None, None
    if not json_path or not os.path.exists(json_path):
        return "Input JSON file not found", None, None, None
    if not func_name:
        return "Function name is required", None, None, None
    machine = native_tools.pe_machine(dll_path)
    if machine and machine != 'x64' and sys.maxsize > 2 ** 32:
        return (f"This DLL is {machine} but the tester runs 64-bit Python; it cannot be loaded. "
                "Build the DLL for x64."), None, None, None
    return None, dll_path, json_path, func_name


@app.route('/api/native_status')
def native_status():
    """Which native helpers (allocation tracker, sampler) are built."""
    return jsonify(native_tools.native_status())


@app.route('/api/symbol_check')
def symbol_check():
    """Does a PDB exist for this DLL, and is it the one the DLL was linked with?"""
    dll_path = request.args.get('dll', '')
    pdb_path = request.args.get('pdb', '')
    res = pdb_symbols.check_symbols(dll_path, pdb_path)
    res['machine'] = native_tools.pe_machine(dll_path) if dll_path and os.path.isfile(dll_path) else None
    return jsonify(res)


@app.route('/api/profile', methods=['POST'])
def profile():
    """Run the DLL N times on one input and stream memory samples as NDJSON.

    The response is streamed rather than returned whole because a run of a few
    thousand iterations can take minutes, and the UI charts each sample as it
    lands. runner_profile.py keeps its own stdout clean of DLL output, so every
    line here is expected to be a JSON event.
    """
    data = request.json or {}
    err, dll_path, json_path, func_name = common_profile_args(data)
    if err:
        return ndjson_error(err)

    try:
        iterations = int(data.get('iterations', 20))
        warmup = int(data.get('warmup', 3))
    except (TypeError, ValueError):
        return ndjson_error("Iterations and warmup must be whole numbers")

    if iterations < 1 or iterations > 10000:
        return ndjson_error("Iterations must be between 1 and 10000")
    if warmup < 0 or warmup >= iterations:
        return ndjson_error("Warmup must be at least 0 and less than the iteration count")

    track = bool(data.get('track_allocs', False))
    if track and not native_tools.native_status()['tracker']:
        return ndjson_error("Allocation tracking needs bin\\fnp_tracker.dll. "
                            + native_tools.BUILD_HINT)
    check, symbol_path = resolve_symbols(data)

    payload = {
        "dll_path": dll_path,
        "json_path": json_path,
        "function_name": func_name,
        "arg_type": data.get('arg_type', 'c_wchar_p'),
        "res_type": data.get('res_type', 'c_wchar_p'),
        "iterations": iterations,
        "warmup": warmup,
        "free_mode": data.get('free_mode', 'none'),
        "unload_after": bool(data.get('unload_after', True)),
        "sample_interval_ms": data.get('sample_interval_ms', 5),
        "track_allocs": track,
        "top_sites": data.get('top_sites', 30),
        "symbol_path": symbol_path,
        "symbols": check,
    }
    return stream_runner('runner_profile.py', payload)


@app.route('/api/speed_profile', methods=['POST'])
def speed_profile():
    """Time the DLL (clean phase) and sample where the time goes (second phase)."""
    data = request.json or {}
    err, dll_path, json_path, func_name = common_profile_args(data)
    if err:
        return ndjson_error(err)

    try:
        iterations = int(data.get('iterations', 30))
        warmup = int(data.get('warmup', 3))
        sample_calls = int(data.get('sample_calls', iterations))
        interval_us = int(data.get('interval_us', 1000))
    except (TypeError, ValueError):
        return ndjson_error("Iterations, warmup, sampled calls and interval must be whole numbers")

    if iterations < 1 or iterations > 10000:
        return ndjson_error("Iterations must be between 1 and 10000")
    if warmup < 0 or warmup >= iterations:
        return ndjson_error("Warmup must be at least 0 and less than the iteration count")
    if sample_calls < 1 or sample_calls > 10000:
        return ndjson_error("Sampled calls must be between 1 and 10000")
    if interval_us < 200 or interval_us > 100000:
        return ndjson_error("Sampling interval must be between 0.2 ms and 100 ms")

    sample = bool(data.get('sample', True))
    check, symbol_path = resolve_symbols(data)

    payload = {
        "dll_path": dll_path,
        "json_path": json_path,
        "function_name": func_name,
        "arg_type": data.get('arg_type', 'c_wchar_p'),
        "res_type": data.get('res_type', 'c_wchar_p'),
        "iterations": iterations,
        "warmup": warmup,
        "free_mode": data.get('free_mode', 'none'),
        "sample": sample,
        "sample_calls": sample_calls,
        "interval_us": interval_us,
        "symbol_path": symbol_path,
        "symbols": check,
    }
    return stream_runner('runner_speed.py', payload)

@app.route('/api/profile_cancel', methods=['POST'])
def profile_cancel():
    killed = stop_profile_process()
    return jsonify({"status": "success", "killed": killed})

if __name__ == '__main__':
    # Listen on all interfaces to allow Docker mapping.
    # threaded=True lets /api/profile_cancel be served while a profile run streams.
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True)
