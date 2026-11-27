// Shared dbghelp wrapper used by both the allocation tracker (in-process) and the
// sampling profiler (out-of-process). Header-only so each binary stays standalone.
#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dbghelp.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "dbghelp.lib")

struct SymFrame {
    std::string module;   // image file name, e.g. "FnGenesis.dll"
    std::string func;     // undecorated function name, or "module+0xOFFSET"
    std::string file;     // source file, empty without line info
    unsigned line = 0;
    bool inlined = false; // true for frames reconstructed from inline info
    bool resolved = false;
};

inline std::string WideToUtf8(const wchar_t* w) {
    if (!w || !*w) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return std::string();
    std::string s((size_t)n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}

inline std::string BaseName(const std::string& p) {
    size_t i = p.find_last_of("\\/");
    return i == std::string::npos ? p : p.substr(i + 1);
}

inline std::string JsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
            if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
            else o += (char)c;
        }
    }
    return o;
}

class Symbolizer {
public:
    HANDLE proc = nullptr;
    bool ok = false;
    // Image name of the DLL under test (lowercase compare). Unnamed frames inside it
    // keep their module+offset; unnamed frames elsewhere collapse to "(internal)" so
    // a system DLL without symbols is one node, not one node per instruction address.
    std::string targetModule;

    // searchPath: semicolon separated folders holding the PDBs (may be empty).
    bool init(HANDLE process, const std::wstring& searchPath, bool invade) {
        proc = process;
        // No SYMOPT_EXACT_SYMBOLS: it also disables the export-table fallback, which is
        // all system DLLs (ntdll, ucrtbase, KERNELBASE) have without a symbol server.
        // dbghelp still refuses a PDB whose GUID does not match the image.
        SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES |
                      SYMOPT_FAIL_CRITICAL_ERRORS | SYMOPT_NO_PROMPTS);
        ok = SymInitializeW(proc, searchPath.empty() ? nullptr : searchPath.c_str(),
                            invade ? TRUE : FALSE) != FALSE;
        return ok;
    }

    void shutdown() {
        if (ok) SymCleanup(proc);
        ok = false;
    }

    // Describes the symbol state of the module containing `addr`.
    // type: 0 none, 1 coff, 2 cv, 3 pdb, 4 export, 5 deferred, 6 sym, 7 dia, 8 virtual
    bool moduleInfo(DWORD64 addr, std::string& name, std::string& pdb, int& type) {
        IMAGEHLP_MODULEW64 mi;
        memset(&mi, 0, sizeof mi);
        mi.SizeOfStruct = sizeof mi;
        if (!SymGetModuleInfoW64(proc, addr, &mi)) return false;
        name = BaseName(WideToUtf8(mi.ImageName));
        if (name.empty()) name = WideToUtf8(mi.ModuleName);
        pdb = WideToUtf8(mi.LoadedPdbName);
        type = (int)mi.SymType;
        return true;
    }

    // Force-load symbols for a module and report what dbghelp ended up with.
    bool forceLoad(DWORD64 addr, std::string& name, std::string& pdb, int& type) {
        // SymGetModuleInfo triggers a deferred load.
        return moduleInfo(addr, name, pdb, type);
    }

    // Resolves one code address. Frames come back innermost-first: inline frames,
    // then the physical function. For a return address pass isReturn=true so the
    // lookup lands inside the call instruction, not on the next function.
    void resolve(DWORD64 addr, bool isReturn, std::vector<SymFrame>& out, bool inlineFrames = true) {
        DWORD64 key = addr * 2 + (isReturn ? 1 : 0);
        auto it = cache_.find(key);
        if (it != cache_.end()) {
            out.insert(out.end(), it->second.begin(), it->second.end());
            return;
        }
        std::vector<SymFrame> frames;
        DWORD64 a = isReturn && addr ? addr - 1 : addr;

        std::string modName, pdb;
        int type = 0;
        bool haveMod = moduleInfo(a, modName, pdb, type);

        if (inlineFrames && ok) {
            DWORD count = SymAddrIncludeInlineTrace(proc, a);
            if (count) {
                DWORD ctx = 0, idx = 0;
                if (SymQueryInlineTrace(proc, a, 0, a, a, &ctx, &idx)) {
                    for (DWORD i = 0; i < count; i++) {
                        SymFrame f;
                        if (fromInline(a, ctx + i, f)) {
                            f.inlined = true;
                            f.module = modName;
                            frames.push_back(std::move(f));
                        }
                    }
                }
            }
        }

        SymFrame phys;
        phys.module = haveMod ? modName : std::string("?");
        alignas(SYMBOL_INFOW) char buf[sizeof(SYMBOL_INFOW) + 1024 * sizeof(wchar_t)];
        SYMBOL_INFOW* si = (SYMBOL_INFOW*)buf;
        memset(si, 0, sizeof *si);
        si->SizeOfStruct = sizeof(SYMBOL_INFOW);
        si->MaxNameLen = 1023;
        DWORD64 disp = 0;
        bool named = false;
        if (ok && SymFromAddrW(proc, a, &disp, si)) {
            std::string m2, p2;
            int t2 = 0;
            moduleInfo(a, m2, p2, t2);   // after the lookup: the load is deferred until now
            named = true;
            if (t2 == 4 /*SymExport*/ || t2 == 0) {
                // Export-only module: the nearest preceding export is the right name only
                // if the function really starts there; otherwise it is some internal
                // routine that happens to sit after an export, and naming it would lie.
                DWORD64 base = SymGetModuleBase64(proc, a);
                auto rf = (PRUNTIME_FUNCTION)SymFunctionTableAccess64(proc, a);
                named = rf && base && (a - disp) == base + rf->BeginAddress;
            }
            if (named) {
                phys.func = WideToUtf8(si->Name);
                phys.resolved = true;
                IMAGEHLP_LINEW64 ln;
                memset(&ln, 0, sizeof ln);
                ln.SizeOfStruct = sizeof ln;
                DWORD d32 = 0;
                if (SymGetLineFromAddrW64(proc, a, &d32, &ln)) {
                    phys.file = WideToUtf8(ln.FileName);
                    phys.line = ln.LineNumber;
                }
            }
        }
        if (!named) {
            bool isTarget = !targetModule.empty() && _stricmp(phys.module.c_str(), targetModule.c_str()) == 0;
            if (isTarget || targetModule.empty()) {
                DWORD64 base = ok ? SymGetModuleBase64(proc, a) : 0;
                char b[96];
                snprintf(b, sizeof b, "%s+0x%llx", phys.module.c_str(),
                         (unsigned long long)(base ? a - base : a));
                phys.func = b;
            } else {
                phys.func = "(internal)";
            }
        }
        frames.push_back(std::move(phys));

        cache_[key] = frames;
        out.insert(out.end(), frames.begin(), frames.end());
    }

private:
    std::unordered_map<DWORD64, std::vector<SymFrame>> cache_;

    bool fromInline(DWORD64 a, DWORD ctx, SymFrame& f) {
        alignas(SYMBOL_INFOW) char buf[sizeof(SYMBOL_INFOW) + 1024 * sizeof(wchar_t)];
        SYMBOL_INFOW* si = (SYMBOL_INFOW*)buf;
        memset(si, 0, sizeof *si);
        si->SizeOfStruct = sizeof(SYMBOL_INFOW);
        si->MaxNameLen = 1023;
        DWORD64 disp = 0;
        if (!SymFromInlineContextW(proc, a, ctx, &disp, si)) return false;
        f.func = WideToUtf8(si->Name);
        f.resolved = true;
        IMAGEHLP_LINEW64 ln;
        memset(&ln, 0, sizeof ln);
        ln.SizeOfStruct = sizeof ln;
        DWORD d32 = 0;
        if (SymGetLineFromInlineContextW(proc, a, ctx, 0, &d32, &ln)) {
            f.file = WideToUtf8(ln.FileName);
            f.line = ln.LineNumber;
        }
        return true;
    }
};
