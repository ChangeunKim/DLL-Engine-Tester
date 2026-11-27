// fnp_sampler.exe - out-of-process wall-clock sampling profiler.
//
// The profile runner (Python) starts this process right before the measured calls
// and tells it which thread executes the DLL. Every interval it suspends that
// thread, walks its stack with dbghelp (using the PDB for names, files, lines and
// inline frames), resumes it, and keeps the sample if the stack passes through the
// DLL under test. It must be a separate process: suspending a thread that holds a
// heap/loader lock and then allocating in the SAME process would deadlock.
//
// Protocol:  argv: --pid N --tid T [--interval-us 1000] [--symbols PATH] --module NAME --out FILE
//            stdout: "ready\n" once symbols are initialised, "done\n" after FILE is written
//            stdin : a line "stop" ends sampling and triggers the report.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>
#include "symbols.h"

#pragma comment(lib, "psapi.lib")

static std::atomic<bool> g_stop{false};

static void stdin_watcher() {
    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        if (!strncmp(line, "stop", 4)) break;
    }
    g_stop = true;   // also on EOF: parent died or closed the pipe
}

struct Node {
    std::string name, module, file;
    unsigned line = 0;
    uint64_t value = 0, self = 0;
    bool inlined = false;
    std::map<std::string, std::unique_ptr<Node>> kids;
};

struct FlatRec {
    std::string name, module, file;
    unsigned line = 0;
    uint64_t self = 0, incl = 0;
};

static std::string node_json(const Node& n, uint64_t minValue, int depth) {
    std::string s = "{\"n\":\"" + JsonEscape(n.name) + "\",\"m\":\"" + JsonEscape(n.module) +
                    "\",\"f\":\"" + JsonEscape(n.file) + "\",";
    char b[160];
    snprintf(b, sizeof b, "\"l\":%u,\"v\":%llu,\"s\":%llu,\"i\":%d,\"c\":[", n.line,
             (unsigned long long)n.value, (unsigned long long)n.self, n.inlined ? 1 : 0);
    s += b;
    std::vector<const Node*> kids;
    uint64_t pruned = 0;
    for (auto& kv : n.kids) {
        if (kv.second->value >= minValue && depth < 200) kids.push_back(kv.second.get());
        else pruned += kv.second->value;
    }
    std::sort(kids.begin(), kids.end(), [](const Node* a, const Node* b) { return a->value > b->value; });
    bool first = true;
    for (auto* k : kids) {
        if (!first) s += ",";
        first = false;
        s += node_json(*k, minValue, depth + 1);
    }
    if (pruned) {
        if (!first) s += ",";
        snprintf(b, sizeof b, "{\"n\":\"(other)\",\"m\":\"\",\"f\":\"\",\"l\":0,\"v\":%llu,\"s\":%llu,\"i\":0,\"c\":[]}",
                 (unsigned long long)pruned, (unsigned long long)pruned);
        s += b;
    }
    s += "]}";
    return s;
}

// Stack snapshot used while unwinding AFTER the thread has been resumed. Reading the
// live stack of a running thread would return garbage, so every stack address is
// served from the copy taken while the thread was stopped.
struct Snapshot {
    uint64_t lo = 0, len = 0;
    uint64_t stackLo = 0, stackHi = 0;   // the thread's whole stack range (from its TEB)
    std::vector<uint8_t> mem;
};
static Snapshot g_snap;
static int g_refreshes = 0;

static BOOL CALLBACK ReadMem(HANDLE proc, DWORD64 addr, PVOID buf, DWORD size, LPDWORD got) {
    if (addr >= g_snap.lo && addr + size <= g_snap.lo + g_snap.len) {
        memcpy(buf, g_snap.mem.data() + (addr - g_snap.lo), size);
        if (got) *got = size;
        return TRUE;
    }
    if (addr + size > g_snap.stackLo && addr < g_snap.stackHi) return FALSE;   // stale live stack
    SIZE_T n = 0;
    BOOL ok = ReadProcessMemory(proc, (LPCVOID)addr, buf, size, &n);
    if (got) *got = (DWORD)n;
    return ok;
}

static DWORD64 CALLBACK ModBase(HANDLE proc, DWORD64 addr) {
    DWORD64 b = SymGetModuleBase64(proc, addr);
    if (!b && g_refreshes < 20) {   // a module the DLL loaded after we started
        g_refreshes++;
        SymRefreshModuleList(proc);
        b = SymGetModuleBase64(proc, addr);
    }
    return b;
}

typedef LONG(NTAPI* NtQueryInformationThread_t)(HANDLE, ULONG, PVOID, ULONG, PULONG);

static bool thread_stack_range(HANDLE hProc, HANDLE hThread, uint64_t& lo, uint64_t& hi) {
    auto fn = (NtQueryInformationThread_t)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationThread");
    if (!fn) return false;
    struct { LONG status; PVOID teb; PVOID cid[2]; ULONG_PTR affinity; LONG prio; LONG bprio; } tbi = {};
    if (fn(hThread, 0 /*ThreadBasicInformation*/, &tbi, sizeof tbi, nullptr) != 0 || !tbi.teb) return false;
    uint64_t tib[3] = {};   // ExceptionList, StackBase, StackLimit
    SIZE_T n = 0;
    if (!ReadProcessMemory(hProc, tbi.teb, tib, sizeof tib, &n) || n != sizeof tib) return false;
    hi = tib[1];
    lo = tib[2];
    return hi > lo;
}

static std::wstring Widen(const char* s) {
    if (!s) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
    return w;
}

int main(int argc, char** argv) {
    DWORD pid = 0, tid = 0;
    long intervalUs = 1000;
    std::string symbols, module, out;
    for (int i = 1; i + 1 < argc + 1; i++) {
        std::string a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
        if (a == "--pid") pid = (DWORD)atoi(next());
        else if (a == "--tid") tid = (DWORD)atoi(next());
        else if (a == "--interval-us") intervalUs = atol(next());
        else if (a == "--symbols") symbols = next();
        else if (a == "--module") module = next();
        else if (a == "--out") out = next();
    }
    if (!pid || !tid || out.empty()) {
        fprintf(stderr, "usage: fnp_sampler --pid N --tid T --module NAME --out FILE\n");
        return 2;
    }
    intervalUs = std::max(200L, std::min(intervalUs, 100000L));

    HANDLE hProc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    HANDLE hThread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!hProc || !hThread) {
        fprintf(stderr, "cannot open target (err %lu)\n", GetLastError());
        return 3;
    }

    // Locate the DLL under test inside the target process.
    uintptr_t tLo = 0, tHi = 0;
    {
        HMODULE mods[1024];
        DWORD need = 0;
        if (EnumProcessModulesEx(hProc, mods, sizeof mods, &need, LIST_MODULES_64BIT)) {
            for (DWORD i = 0; i < need / sizeof(HMODULE); i++) {
                char nm[MAX_PATH];
                if (!GetModuleFileNameExA(hProc, mods[i], nm, MAX_PATH)) continue;
                if (_stricmp(BaseName(nm).c_str(), module.c_str()) != 0) continue;
                MODULEINFO mi;
                if (GetModuleInformation(hProc, mods[i], &mi, sizeof mi)) {
                    tLo = (uintptr_t)mi.lpBaseOfDll;
                    tHi = tLo + mi.SizeOfImage;
                }
            }
        }
    }

    Symbolizer sym;
    bool symOk = sym.init(hProc, Widen(symbols.c_str()), true);
    sym.targetModule = module;
    thread_stack_range(hProc, hThread, g_snap.stackLo, g_snap.stackHi);
    const uint64_t kStackCap = 192 * 1024;
    g_snap.mem.resize((size_t)kStackCap);
    std::string tName, tPdb;
    int tType = -1;

    CreateThread(nullptr, 0, [](LPVOID) -> DWORD { stdin_watcher(); return 0; }, nullptr, 0, nullptr);
    printf("ready\n");
    fflush(stdout);

    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!timer) timer = CreateWaitableTimerW(nullptr, TRUE, nullptr);

    LARGE_INTEGER qf, q0, q1, qs, qe;
    QueryPerformanceFrequency(&qf);
    QueryPerformanceCounter(&q0);

    std::vector<std::vector<uint64_t>> kept;      // leaf-first stacks passing through the DLL
    uint64_t attempts = 0, gotStack = 0, failed = 0, suspendTicks = 0;

    while (!g_stop) {
        attempts++;
        LARGE_INTEGER cycleStart;
        QueryPerformanceCounter(&cycleStart);
        QueryPerformanceCounter(&qs);

        // --- Stop the thread for as short a time as possible: registers + a copy of
        // its stack, nothing else. The expensive unwinding happens after the resume.
        CONTEXT ctx;
        memset(&ctx, 0, sizeof ctx);
        ctx.ContextFlags = CONTEXT_FULL;
        bool haveCtx = false;
        if (SuspendThread(hThread) == (DWORD)-1) { failed++; break; }   // thread is gone
        if (GetThreadContext(hThread, &ctx)) {
            haveCtx = true;
            uint64_t sp = ctx.Rsp;
            uint64_t want = kStackCap;
            if (g_snap.stackHi > sp) want = std::min<uint64_t>(want, g_snap.stackHi - sp);
            SIZE_T got = 0;
            if (!ReadProcessMemory(hProc, (LPCVOID)sp, g_snap.mem.data(), (SIZE_T)want, &got) || got == 0) {
                // A guard page can cut the read short; keep whatever arrived.
                if (got == 0) haveCtx = false;
            }
            g_snap.lo = sp;
            g_snap.len = got;
        }
        ResumeThread(hThread);
        QueryPerformanceCounter(&qe);
        suspendTicks += (uint64_t)(qe.QuadPart - qs.QuadPart);

        std::vector<uint64_t> stack;
        if (haveCtx) {
            STACKFRAME64 sf;
            memset(&sf, 0, sizeof sf);
            sf.AddrPC.Offset = ctx.Rip;      sf.AddrPC.Mode = AddrModeFlat;
            sf.AddrFrame.Offset = ctx.Rbp;   sf.AddrFrame.Mode = AddrModeFlat;
            sf.AddrStack.Offset = ctx.Rsp;   sf.AddrStack.Mode = AddrModeFlat;
            stack.reserve(48);
            for (int d = 0; d < 128; d++) {
                // The first call returns the starting frame (RIP) itself, so it must be
                // made too - pushing RIP separately would record the leaf twice.
                if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, hProc, hThread, &sf, &ctx, ReadMem,
                                 SymFunctionTableAccess64, ModBase, nullptr))
                    break;
                if (!sf.AddrPC.Offset) break;
                stack.push_back(sf.AddrPC.Offset);
            }
        }

        if (stack.empty()) failed++;
        else {
            gotStack++;
            bool inDll = false;
            for (uint64_t a : stack)
                if (a >= tLo && a < tHi) { inDll = true; break; }
            if (inDll) kept.push_back(std::move(stack));
        }

        // Wait only for what is left of the interval; the unwinding already used some.
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        double usedUs = (double)(now.QuadPart - cycleStart.QuadPart) * 1e6 / (double)qf.QuadPart;
        double leftUs = (double)intervalUs - usedUs;
        if (leftUs > 50.0) {
            LARGE_INTEGER due;
            due.QuadPart = -(LONGLONG)(leftUs * 10.0);
            if (!SetWaitableTimerEx(timer, &due, 0, nullptr, nullptr, nullptr, 0)) Sleep(1);
            else WaitForSingleObject(timer, 200);
        }
    }
    QueryPerformanceCounter(&q1);
    double elapsedMs = (double)(q1.QuadPart - q0.QuadPart) * 1000.0 / (double)qf.QuadPart;

    // --- Aggregate ---------------------------------------------------------------
    Node root;
    root.name = "(entry)";
    std::unordered_map<std::string, FlatRec> flat;
    std::map<std::string, uint64_t> moduleSelf;
    uint64_t inDllSamples = 0;

    for (auto& st : kept) {
        // Cut everything above the outermost DLL frame (Python / ctypes / thread start).
        size_t hi = 0;
        for (size_t i = 0; i < st.size(); i++)
            if (st[i] >= tLo && st[i] < tHi) hi = i;
        std::vector<SymFrame> frames;   // leaf-first, inline frames expanded
        for (size_t i = 0; i <= hi; i++) sym.resolve(st[i], i != 0, frames, true);
        if (frames.empty()) continue;
        inDllSamples++;

        std::set<std::string> seen;
        for (size_t k = 0; k < frames.size(); k++) {
            const SymFrame& f = frames[k];
            std::string key = f.module + "!" + f.func;
            FlatRec& r = flat[key];
            if (r.name.empty()) { r.name = f.func; r.module = f.module; r.file = f.file; r.line = f.line; }
            if (k == 0) r.self++;
            if (seen.insert(key).second) r.incl++;
        }
        moduleSelf[frames[0].module]++;

        Node* cur = &root;
        cur->value++;
        for (size_t k = frames.size(); k-- > 0;) {
            const SymFrame& f = frames[k];
            std::string key = f.module + "!" + f.func;
            auto& slot = cur->kids[key];
            if (!slot) {
                slot.reset(new Node());
                slot->name = f.func; slot->module = f.module; slot->file = f.file;
                slot->line = f.line; slot->inlined = f.inlined;
            }
            cur = slot.get();
            cur->value++;
            if (k == 0) cur->self++;
        }
    }

    // Queried after the first resolves: dbghelp loads symbols lazily.
    if (symOk && tLo) sym.moduleInfo(tLo + 16, tName, tPdb, tType);

    std::vector<const FlatRec*> flatOrder;
    for (auto& kv : flat) flatOrder.push_back(&kv.second);
    std::sort(flatOrder.begin(), flatOrder.end(), [](const FlatRec* a, const FlatRec* b) {
        return a->self != b->self ? a->self > b->self : a->incl > b->incl;
    });
    if (flatOrder.size() > 300) flatOrder.resize(300);

    uint64_t minValue = std::max<uint64_t>(1, inDllSamples / 500);   // 0.2% of samples
    std::string js = "{";
    char b[256];
    snprintf(b, sizeof b,
             "\"interval_us\":%ld,\"attempts\":%llu,\"samples_total\":%llu,\"samples_in_dll\":%llu,"
             "\"walk_failures\":%llu,\"elapsed_ms\":%.3f,\"avg_suspend_us\":%.1f,"
             "\"achieved_interval_us\":%.1f,",
             intervalUs, (unsigned long long)attempts, (unsigned long long)gotStack,
             (unsigned long long)inDllSamples, (unsigned long long)failed, elapsedMs,
             attempts ? (double)suspendTicks * 1e6 / (double)qf.QuadPart / (double)attempts : 0.0,
             attempts ? elapsedMs * 1000.0 / (double)attempts : 0.0);
    js += b;
    js += "\"target\":\"" + JsonEscape(module) + "\",";
    snprintf(b, sizeof b, "\"target_found\":%s,\"symbols\":{\"initialized\":%s,\"sym_type\":%d,",
             tLo ? "true" : "false", symOk ? "true" : "false", tType);
    js += b;
    js += "\"pdb\":\"" + JsonEscape(tPdb) + "\"},\"modules\":[";
    {
        std::vector<std::pair<std::string, uint64_t>> mv(moduleSelf.begin(), moduleSelf.end());
        std::sort(mv.begin(), mv.end(), [](auto& a, auto& c) { return a.second > c.second; });
        bool f = true;
        for (auto& m : mv) {
            if (!f) js += ",";
            f = false;
            snprintf(b, sizeof b, "\",\"self\":%llu}", (unsigned long long)m.second);
            js += "{\"name\":\"" + JsonEscape(m.first) + b;
        }
    }
    js += "],\"flat\":[";
    {
        bool f = true;
        for (auto* r : flatOrder) {
            if (!f) js += ",";
            f = false;
            snprintf(b, sizeof b, "\",\"line\":%u,\"self\":%llu,\"incl\":%llu}", r->line,
                     (unsigned long long)r->self, (unsigned long long)r->incl);
            js += "{\"name\":\"" + JsonEscape(r->name) + "\",\"module\":\"" + JsonEscape(r->module) +
                  "\",\"file\":\"" + JsonEscape(r->file) + b;
        }
    }
    js += "],\"tree\":" + node_json(root, minValue, 0) + "}";
    sym.shutdown();

    FILE* fp = fopen(out.c_str(), "wb");
    if (!fp) { fprintf(stderr, "cannot write %s\n", out.c_str()); return 4; }
    fwrite(js.data(), 1, js.size(), fp);
    fclose(fp);
    printf("done\n");
    fflush(stdout);
    return 0;
}
