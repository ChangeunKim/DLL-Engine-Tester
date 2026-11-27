import sys
import json
import ctypes
from ctypes import WinDLL, c_wchar_p, c_char_p, windll, wintypes, POINTER, byref, c_double
import time

def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return
            
        args = json.loads(input_data)
        
        dll_path = args['dll_path']
        json_path = args['json_path']
        func_name = args['function_name']
        arg_type_str = args.get('arg_type', 'c_wchar_p')
        res_type_str = args.get('res_type', 'c_wchar_p')
        
        type_map = {
            'c_wchar_p': c_wchar_p,
            'c_char_p': c_char_p,
            'c_double': c_double
        }
        
        # 1. Load the DLL
        dll = WinDLL(dll_path)
        func = dll[func_name]
        
        # 1.5. Debug Mode Pause
        if args.get('debug_mode', False):
            import os
            MB_TOPMOST = 0x40000
            MB_ICONINFORMATION = 0x40
            msg = f"Ready to debug DLL: {os.getpid()}\n\n1. Open Visual Studio\n2. Go to Debug -> Attach to Process\n3. Find and attach to 'python.exe' with PID: {os.getpid()}\n4. After attaching, click OK to resume and hit your breakpoints!"
            ctypes.windll.user32.MessageBoxW(0, msg, "VS Debug Pause", MB_TOPMOST | MB_ICONINFORMATION)
        
        # 2. Set function signature
        if arg_type_str == 'c_wchar_p_ptr':
            func.argtypes = [c_wchar_p, POINTER(c_wchar_p)]
        else:
            func.argtypes = [type_map.get(arg_type_str, c_wchar_p)]
            
        func.restype = type_map.get(res_type_str, c_wchar_p)
        
        # 3. Read Input JSON
        with open(json_path, 'r', encoding='UTF-8') as f:
            jdata = json.load(f)
            
        input_str = json.dumps(jdata)
        
        # 4. Handle execution
        out_ptr = None
        if arg_type_str == 'c_char_p':
            res_val = func(input_str.encode('utf-8'))
        elif arg_type_str == 'c_wchar_p_ptr':
            out_ptr = c_wchar_p()
            res_val = func(input_str, byref(out_ptr))
        else:
            res_val = func(input_str)
            
        # 5. Handle output format mappings
        res_decoded = None
        pointer_decoded = None
        
        # Decode Return value
        if res_type_str == 'c_double':
            res_decoded = float(res_val) if res_val is not None else 0.0
        elif res_val:
            if res_type_str == 'c_char_p':
                try:
                    res_decoded = res_val.decode('utf-8')
                except Exception:
                    res_decoded = res_val.decode('latin-1', errors='replace')
            else:
                res_decoded = res_val
        
        # Decode Pointer value if used
        if out_ptr and out_ptr.value:
            pointer_decoded = out_ptr.value

        # Determine what to return as main output
        return_val = None
        if res_type_str == 'c_double':
            if pointer_decoded:
                try:
                    return_val = json.loads(pointer_decoded)
                    if isinstance(return_val, dict):
                        return_val["_numeric_result"] = res_decoded
                except Exception:
                    return_val = f"Double: {res_decoded}\nPointer: {pointer_decoded}"
            else:
                return_val = res_decoded
        elif res_decoded:
            try:
                # Pretty format the result if it's JSON
                return_val = json.loads(res_decoded)
                # If there's also a pointer string, add it as metadata
                if pointer_decoded and isinstance(return_val, dict):
                    return_val["_pointer_output"] = pointer_decoded
            except Exception:
                return_val = res_decoded
                if pointer_decoded:
                    return_val = f"Return: {res_decoded}\nPointer: {pointer_decoded}"
        else:
            return_val = pointer_decoded if pointer_decoded else None
            
        # 6. Unload DLL cleanly
        windll.kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
        windll.kernel32.FreeLibrary.restype = wintypes.BOOL
        windll.kernel32.FreeLibrary(dll._handle)
        
        # 7. Print result to stdout
        output = {"status": "success", "output": return_val, "raw_output": str(res_decoded) if res_decoded is not None else pointer_decoded}
        print(json.dumps(output))
        
    except Exception as e:
        output = {"status": "error", "message": f"Exception in runner: {str(e)}"}
        print(json.dumps(output))

if __name__ == "__main__":
    main()
