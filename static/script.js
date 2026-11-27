let currentPathParam = '';
let selectedFile = null;
let currentTargetInputId = '';
let fileExtensionFilter = '';

const statusBadge = document.getElementById('status-badge');
const outputView = document.getElementById('output-view');
const modal = document.getElementById('file-modal');
const fbList = document.getElementById('fb-list');
const fbCurrentPath = document.getElementById('fb-current-path');
const fbConfirmBtn = document.getElementById('fb-confirm-btn');
const fbSelectedName = document.getElementById('fb-selected-name');

async function executeDll() {
    saveConfig(); // Force save config to localStorage right before executing

    const dllPath = document.getElementById('dll-path').value;
    const jsonPath = document.getElementById('json-path').value;
    const funcName = document.getElementById('func-name').value;
    const argType = document.getElementById('arg-type').value;
    const resType = document.getElementById('res-type').value;

    if(!dllPath || !jsonPath || !funcName) {
        alert('Please provide DLL path, JSON path and Function name.');
        return;
    }

    // UI Updates
    const runBtn = document.getElementById('run-btn');
    const btnText = runBtn.querySelector('.btn-text');
    const btnLoader = document.getElementById('btn-loader');
    
    // Save the input editor content right before execution to reflect edits
    await saveInputToFile();
    
    runBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-block';
    
    statusBadge.className = 'status-badge running';
    statusBadge.textContent = 'Executing...';
    outputView.textContent = 'Starting execution...';

    try {
        const debugMode = document.getElementById('debug-mode').checked;

        const response = await fetch('/api/execute', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                dll_path: dllPath,
                json_path: jsonPath,
                function_name: funcName,
                arg_type: argType,
                res_type: resType,
                debug_mode: debugMode
            })
        });

        const result = await response.json();
        
        statusBadge.className = result.status === 'success' ? 'status-badge success' : 'status-badge error';
        statusBadge.textContent = result.status === 'success' ? 'Success' : 'Error';
        
        if (result.status === 'success') {
            let finalOutput = '';
            if (result.stdout) {
                finalOutput += `====== [C++ STDOUT LOGS] ======\n${result.stdout}\n===============================\n\n`;
            }
            
            if (result.is_raw) {
                finalOutput += (result.output || "[Empty Raw String]");
            } else {
                finalOutput += JSON.stringify(result.output, null, 2);
            }
            
            outputView.textContent = finalOutput;
            document.getElementById('save-btn').style.display = 'inline-block';
        } else {
            document.getElementById('save-btn').style.display = 'none';
            let errorText = result.message + '\n\n';
            if (result.stdout) errorText += `STDOUT:\n${result.stdout}\n\n`;
            if (result.stderr) errorText += `STDERR:\n${result.stderr}`;
            outputView.textContent = errorText;
        }

    } catch (error) {
        statusBadge.className = 'status-badge error';
        statusBadge.textContent = 'Request Failed';
        outputView.textContent = 'Critical Error: ' + error.message;
    } finally {
        runBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
    }
}

// Use Native Windows File Explorer pop-up
// The file dialog remembers where it was last opened, per KIND of file, so choosing
// a JSON after a DLL does not reopen in the DLL's folder. DLL and PDB share one
// remembered folder (they live together); JSON has its own.
const BROWSE_DIR_KEYS = { 'dll-path': 'fnp_dir_bin', 'pdb-path': 'fnp_dir_bin', 'json-path': 'fnp_dir_json' };

function dirOfPath(p) {
    p = (p || '').trim();
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : '';
}

function browseStartDir(inputId, explicitDir) {
    if (explicitDir) return explicitDir;
    let remembered = '';
    try { remembered = localStorage.getItem(BROWSE_DIR_KEYS[inputId] || '') || ''; } catch (e) { /* private mode */ }
    // Fall back to the folder of what is already in the field; the server supplies
    // a default (e.g. the project's JSON folder) when this is empty or gone.
    return remembered || dirOfPath(document.getElementById(inputId).value);
}

function rememberBrowseDir(inputId, chosenPath) {
    const key = BROWSE_DIR_KEYS[inputId];
    const dir = dirOfPath(chosenPath);
    if (!key || !dir) return;
    try { localStorage.setItem(key, dir); } catch (e) { /* private mode */ }
}

async function openFileBrowser(inputId, extFilter, initialDir = '') {
    document.getElementById('status-badge').className = 'status-badge running';
    document.getElementById('status-badge').textContent = 'Waiting for File Selection...';
    
    try {
        const startDir = browseStartDir(inputId, initialDir);
        const url = `/api/browse?ext=${extFilter}&initialdir=${encodeURIComponent(startDir)}`;
        const response = await fetch(url);
        const result = await response.json();
        
        if (result.status === 'success' && result.path) {
            document.getElementById(inputId).value = result.path;
            rememberBrowseDir(inputId, result.path);
            document.getElementById('status-badge').className = 'status-badge success';
            document.getElementById('status-badge').textContent = 'File Selected';
            
            saveConfig(); // Save newly selected path to local storage
            
            // If the selected file was the JSON input, automatically refresh its preview
            if(inputId === 'json-path') {
                loadInputJson();
            }
        } else {
            document.getElementById('status-badge').className = 'status-badge';
            document.getElementById('status-badge').textContent = 'Selection Cancelled';
        }
    } catch (e) {
        document.getElementById('status-badge').className = 'status-badge error';
        document.getElementById('status-badge').textContent = 'File Browser Error';
        console.error(e);
    }
}

function saveJsonOutput() {
    const outputContent = document.getElementById('output-view').textContent;
    if (!outputContent || outputContent === '// JSON Output will appear here...' || outputContent === 'Starting execution...') {
        alert("There is no valid JSON output to save.");
        return;
    }
    
    const funcName = document.getElementById('func-name').value || 'output';
    const blob = new Blob([outputContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${funcName}_output.json`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 0);
}

function createNewJsonFile() {
    document.getElementById('json-path').value = '';
    const inputStatus = document.getElementById('input-status');
    const inputView = document.getElementById('input-view');
    const saveBtn = document.getElementById('save-input-btn');
    const saveAsBtn = document.getElementById('save-as-btn');
    
    inputStatus.style.display = 'inline-block';
    inputStatus.className = 'status-badge success';
    inputStatus.textContent = 'New File (Unsaved)';
    
    inputView.value = '{\n  \n}';
    
    if(saveBtn) saveBtn.style.display = 'inline-block';
    if(saveAsBtn) saveAsBtn.style.display = 'inline-block';
}

async function loadInputJson() {
    const path = document.getElementById('json-path').value;
    const inputStatus = document.getElementById('input-status');
    const inputView = document.getElementById('input-view');
    const saveBtn = document.getElementById('save-input-btn');
    
    if (!path) return;
    
    inputStatus.style.display = 'inline-block';
    inputStatus.className = 'status-badge running';
    inputStatus.textContent = 'Loading...';
    
    try {
        const response = await fetch(`/api/read_json?path=${encodeURIComponent(path)}`);
        const result = await response.json();
        
        if (result.status === 'success') {
            inputView.value = result.content;
            inputStatus.className = 'status-badge success';
            inputStatus.textContent = 'Loaded';
            if(saveBtn) saveBtn.style.display = 'inline-block';
            if(document.getElementById('save-as-btn')) document.getElementById('save-as-btn').style.display = 'inline-block';
        } else {
            inputView.value = `Error: ${result.message}`;
            inputStatus.className = 'status-badge error';
            inputStatus.textContent = 'Failed';
            if(saveBtn) saveBtn.style.display = 'none';
            if(document.getElementById('save-as-btn')) document.getElementById('save-as-btn').style.display = 'none';
        }
    } catch (e) {
        inputView.value = `Critical Error: ${e.message}`;
        inputStatus.className = 'status-badge error';
        inputStatus.textContent = 'Error';
        if(saveBtn) saveBtn.style.display = 'none';
        if(document.getElementById('save-as-btn')) document.getElementById('save-as-btn').style.display = 'none';
    }
}

async function saveInputAs() {
    const inputView = document.getElementById('input-view');
    const content = inputView.value;
    
    try {
        // Same remembered folder as the JSON Browse button
        const startDir = browseStartDir('json-path', '');
        const response = await fetch(`/api/browse_save_as?initialdir=${encodeURIComponent(startDir)}`);
        const result = await response.json();
        
        if (result.status === 'success' && result.path) {
            const saveResp = await fetch('/api/save_json', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ path: result.path, content: content })
            });
            const saveRes = await saveResp.json();
            
            if (saveRes.status === 'success') {
                rememberBrowseDir('json-path', result.path);
                // Change current input path to the new file
                document.getElementById('json-path').value = result.path;
                saveConfig(); // Persist new path in localStorage
                loadInputJson(); // Reload preview status
                alert('File saved successfully as: ' + result.path);
            }
        }
    } catch (err) {
        alert('Failed to save file as.');
    }
}

async function saveInputToFile() {
    const jsonPath = document.getElementById('json-path').value;
    const content = document.getElementById('input-view').value;
    const saveBtn = document.getElementById('save-input-btn');

    if (!content) return;
    if (!jsonPath) {
        return saveInputAs();
    }

    if(saveBtn) saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/save_json', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: jsonPath, content: content })
        });
        const result = await response.json();
        
        if(result.status === 'success') {
            if(saveBtn) {
                saveBtn.textContent = '✅ Saved';
                setTimeout(() => { saveBtn.textContent = '💾 Save to File'; }, 2000);
            }
        } else {
            alert('Failed to save file: ' + result.message);
            if(saveBtn) saveBtn.textContent = '💾 Save to File';
        }
    } catch (err) {
        alert('Failed to save file.');
        if(saveBtn) saveBtn.textContent = '💾 Save to File';
    }
}

// Attach event listeners for inputs to save preview and config
document.getElementById('json-path').addEventListener('change', loadInputJson);

// Save and Load Configuration Functions
function saveConfig() {
    localStorage.setItem('fnp_dll_path', document.getElementById('dll-path').value);
    localStorage.setItem('fnp_json_path', document.getElementById('json-path').value);
    localStorage.setItem('fnp_func_name', document.getElementById('func-name').value);
    localStorage.setItem('fnp_arg_type', document.getElementById('arg-type').value);
    localStorage.setItem('fnp_res_type', document.getElementById('res-type').value);
}

function loadConfig() {
    const dll = localStorage.getItem('fnp_dll_path');
    if (dll) document.getElementById('dll-path').value = dll;
    
    const json = localStorage.getItem('fnp_json_path');
    if (json) document.getElementById('json-path').value = json;
    
    const func = localStorage.getItem('fnp_func_name');
    if (func) document.getElementById('func-name').value = func;
    
    const arg = localStorage.getItem('fnp_arg_type');
    if (arg) document.getElementById('arg-type').value = arg;
    
    const res = localStorage.getItem('fnp_res_type');
    if (res) document.getElementById('res-type').value = res;
}

// Auto-save configuration whenever any input changes
['dll-path', 'json-path', 'func-name', 'arg-type', 'res-type'].forEach(id => {
    const el = document.getElementById(id);
    if(el) {
        el.addEventListener('change', saveConfig);
        el.addEventListener('input', saveConfig); // Save on every single keystroke just in case
    }
});

document.getElementById('debug-mode').addEventListener('change', async function(e) {
    const isChecked = e.target.checked;
    const badge = document.getElementById('status-badge');
    
    badge.className = 'status-badge running';
    badge.textContent = isChecked ? 'Starting Debug Session...' : 'Stopping Debug Session...';
    
    try {
        const response = await fetch('/api/toggle_debug', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ start: isChecked })
        });
        const result = await response.json();
        
        if (isChecked && result.status === 'success') {
            badge.className = 'status-badge success';
            badge.textContent = `Debug PID: ${result.pid} (DLL Locked)`;
            setTimeout(() => alert(`Persistent Debug Session Started! \n\n1. Attach VS Debugger to python.exe (PID: ${result.pid})\n2. Click 'Execute DLL' multiple times to test.\n3. Uncheck passing when you need to re-build C++.`), 200);
        } else {
            badge.className = 'status-badge';
            badge.textContent = 'Debug Stopped (DLL Unlocked)';
        }
    } catch (err) {
        badge.className = 'status-badge error';
        badge.textContent = 'Debugger Toggle Failed';
    }
});

function toggleFullscreen(terminalId) {
    const terminal = document.getElementById(terminalId);
    if (!terminal) return;

    terminal.classList.toggle('fullscreen-terminal');
    
    // Toggle body class to bypass parent container constraints (like backdrop-filter)
    if (terminal.classList.contains('fullscreen-terminal')) {
        document.body.classList.add('has-fullscreen');
        document.body.style.overflow = 'hidden';
    } else {
        document.body.classList.remove('has-fullscreen');
        document.body.style.overflow = '';
    }
}

// Global Quick Shortcut Listeners
document.addEventListener('keydown', (e) => {
    // 1. ESC key to exit fullscreen
    if (e.key === 'Escape') {
        const full = document.querySelector('.fullscreen-terminal');
        if (full) {
            full.classList.remove('fullscreen-terminal');
            document.body.classList.remove('has-fullscreen');
            document.body.style.overflow = '';
        }
    }
    
    // 2. Ctrl+S to save input JSON file automatically
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        const inputActive = document.activeElement === document.getElementById('input-view');
        const inputIsFullscreen = document.getElementById('input-terminal')?.classList.contains('fullscreen-terminal');
        
        // If we are currently editing the JSON (focused or fullscreen), save it!
        if (inputActive || inputIsFullscreen) {
            e.preventDefault(); // Prevent browser "Save Page" dialog
            saveInputToFile();
        }
    }
});

// Load the default config and json path initially
window.addEventListener('load', () => {
    loadConfig();
    loadInputJson();
});
