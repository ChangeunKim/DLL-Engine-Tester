// fnp_tracker.dll - allocation tracker for the FnP Engine Tester.
//
// Loaded into the profile runner process. fnp_tracker_attach() patches the import
// address table of ONE module (the DLL under test) so every allocation / free that
// module performs goes through a hook that records (pointer -> size, call stack,
// call index). Allocations made by Python or by other modules are never seen, so
// the report is about the DLL alone.
//
// After the run, fnp_tracker_report() groups the blocks that are STILL LIVE (and
// were allocated after the warmup calls) by call stack, symbolizes the stacks with
// dbghelp + the PDB, and writes a JSON file.
//
// Hooked imports (by name, from whichever import DLL):
//   malloc/calloc/realloc/free/_recalloc/_aligned_*/_strdup/_wcsdup (UCRT)
//   operator new / new[] / delete / delete[] and their nothrow/aligned/sized forms
//   HeapAlloc/HeapReAlloc/HeapFree, LocalAlloc/LocalFree, GlobalAlloc/GlobalFree
//   VirtualAlloc/VirtualFree
//   CoTaskMemAlloc/Realloc/Free, SysAllocString*/SysReAllocString*/SysFreeString
// Not covered: delay-loaded imports, allocations made inside other DLLs that the
// target calls (e.g. msvcp140.dll internals), statically linked CRTs (/MT) which use
// their own heap functions.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <oleauto.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <new>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>
#include "symbols.h"

#define TRK_API extern "C" __declspec(dllexport)

// --- Private heap: the tracker's own bookkeeping must not look like the DLL's heap
// growth, so every container below allocates from a dedicated heap that the Python
// side excludes from its heap statistics (fnp_tracker_heap()).
static HANDLE g_heap = nullptr;

template <class T> struct PAlloc {
    using value_type = T;
    PAlloc() = default;
    template <class U> PAlloc(const PAlloc<U>&) {}
    T* allocate(size_t n) {
        void* p = HeapAlloc(g_heap, 0, n * sizeof(T));
        if (!p) throw std::bad_alloc();
        return (T*)p;
    }
    void deallocate(T* p, size_t) { HeapFree(g_heap, 0, p); }
    template <class U> bool operator==(const PAlloc<U>&) const { return true; }
    template <class U> bool operator!=(const PAlloc<U>&) const { return false; }
};

struct Block {
    size_t size;
    uint32_t stack;
    uint32_t call;
};

struct StackRec {
    uint16_t n;
    void** frames;   // allocated from g_heap
};

typedef std::unordered_map<void*, Block, std::hash<void*>, std::equal_to<void*>,
                           PAlloc<std::pair<void* const, Block>>> BlockMap;
typedef std::unordered_map<uint64_t, uint32_t, std::hash<uint64_t>, std::equal_to<uint64_t>,
                           PAlloc<std::pair<const uint64_t, uint32_t>>> StackIndex;
typedef std::vector<StackRec, PAlloc<StackRec>> StackVec;

static SRWLOCK g_lock = SRWLOCK_INIT;
static BlockMap* g_blocks = nullptr;
static StackIndex* g_stackIndex = nullptr;
static StackVec* g_stacks = nullptr;

static std::atomic<uint32_t> g_call{0};
static std::atomic<uint64_t> g_allocs{0}, g_frees{0}, g_allocBytes{0};
static std::atomic<bool> g_enabled{false};

static HMODULE g_self = nullptr;
static uintptr_t g_selfLo = 0, g_selfHi = 0;
static uintptr_t g_targetLo = 0, g_targetHi = 0;
static std::string g_targetName;
static std::wstring g_symPath;

struct HookedImport { std::string dll, name; };
static std::vector<HookedImport> g_hooked;

static const int kMaxFrames = 48;

struct Lock {
    Lock() { AcquireSRWLockExclusive(&g_lock); }
    ~Lock() { ReleaseSRWLockExclusive(&g_lock); }
};

// --- Recording ---------------------------------------------------------------

static uint32_t intern_stack(void** fr, uint16_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (uint16_t i = 0; i < n; i++) {
        h ^= (uint64_t)(uintptr_t)fr[i];
        h *= 1099511628211ULL;
    }
    auto it = g_stackIndex->find(h);
    if (it != g_stackIndex->end()) return it->second;
    StackRec rec;
    rec.n = n;
    rec.frames = (void**)HeapAlloc(g_heap, 0, sizeof(void*) * (n ? n : 1));
    memcpy(rec.frames, fr, sizeof(void*) * n);
    uint32_t id = (uint32_t)g_stacks->size();
    g_stacks->push_back(rec);
    (*g_stackIndex)[h] = id;
    return id;
}

static void track(void* p, size_t size) {
    if (!p || !g_enabled.load(std::memory_order_relaxed)) return;
    void* fr[kMaxFrames];
    USHORT n = RtlCaptureStackBackTrace(0, kMaxFrames, fr, nullptr);
    // Drop the tracker's own leading frames (hook, track) so frame 0 is real code.
    USHORT skip = 0;
    while (skip < n && (uintptr_t)fr[skip] >= g_selfLo && (uintptr_t)fr[skip] < g_selfHi) skip++;
    Lock lk;
    uint32_t sid = intern_stack(fr + skip, (uint16_t)(n - skip));
    (*g_blocks)[p] = Block{size, sid, g_call.load(std::memory_order_relaxed)};
    g_allocs++;
    g_allocBytes += size;
}

static void untrack(void* p) {
    if (!p || !g_enabled.load(std::memory_order_relaxed)) return;
    Lock lk;
    if (g_blocks->erase(p)) g_frees++;
}

static void retrack(void* oldp, void* newp, size_t size) {
    if (!g_enabled.load(std::memory_order_relaxed)) return;
    if (oldp && oldp == newp) {
        Lock lk;
        auto it = g_blocks->find(oldp);
        if (it != g_blocks->end()) { it->second.size = size; return; }
    }
    if (oldp) untrack(oldp);
    if (newp) track(newp, size);
}

// --- Hook functions -----------------------------------------------------------
// One template instance per distinct imported symbol, so each keeps its own
// original pointer. Extra register arguments (nothrow_t&, align_val_t, ...) are
// forwarded untouched; passing spare registers to a callee that ignores them is
// harmless on the x64 calling convention.

static const int kSlots = 24;
static void* g_origAlloc[kSlots];
static void* g_origFree[kSlots];
static void* g_origFreeInt[kSlots];   // BOOL/HLOCAL-returning frees keyed separately

template <int S> static void* hk_alloc1(size_t n, uintptr_t a2) {
    void* p = ((void* (*)(size_t, uintptr_t))g_origAlloc[S])(n, a2);
    track(p, n);
    return p;
}
template <int S> static void hk_free1(void* p, uintptr_t a2, uintptr_t a3) {
    untrack(p);
    ((void (*)(void*, uintptr_t, uintptr_t))g_origFree[S])(p, a2, a3);
}

template <size_t... I> static std::array<void*, sizeof...(I)> mkAlloc(std::index_sequence<I...>) {
    return {(void*)&hk_alloc1<(int)I>...};
}
template <size_t... I> static std::array<void*, sizeof...(I)> mkFree(std::index_sequence<I...>) {
    return {(void*)&hk_free1<(int)I>...};
}
static const std::array<void*, kSlots> kAllocHooks = mkAlloc(std::make_index_sequence<kSlots>{});
static const std::array<void*, kSlots> kFreeHooks = mkFree(std::make_index_sequence<kSlots>{});

// Single-slot hooks for functions with their own shape.
static void *o_calloc, *o_realloc, *o_recalloc, *o_aligned_realloc, *o_strdup, *o_wcsdup;
static void *o_HeapAlloc, *o_HeapReAlloc, *o_HeapFree, *o_LocalAlloc, *o_LocalFree;
static void *o_GlobalAlloc, *o_GlobalFree, *o_VirtualAlloc, *o_VirtualFree;
static void *o_CoRealloc, *o_SysAllocString, *o_SysAllocStringLen, *o_SysAllocStringByteLen;
static void *o_SysReAllocString, *o_SysReAllocStringLen;

static void* hk_calloc(size_t n, size_t sz) {
    void* p = ((void* (*)(size_t, size_t))o_calloc)(n, sz);
    track(p, n * sz);
    return p;
}
static void* hk_realloc(void* old, size_t sz) {
    void* p = ((void* (*)(void*, size_t))o_realloc)(old, sz);
    if (p || sz == 0) retrack(old, p, sz);
    return p;
}
static void* hk_recalloc(void* old, size_t n, size_t sz) {
    void* p = ((void* (*)(void*, size_t, size_t))o_recalloc)(old, n, sz);
    if (p || n * sz == 0) retrack(old, p, n * sz);
    return p;
}
static void* hk_aligned_realloc(void* old, size_t sz, size_t al) {
    void* p = ((void* (*)(void*, size_t, size_t))o_aligned_realloc)(old, sz, al);
    if (p || sz == 0) retrack(old, p, sz);
    return p;
}
static char* hk_strdup(const char* s) {
    char* p = ((char* (*)(const char*))o_strdup)(s);
    track(p, s ? strlen(s) + 1 : 0);
    return p;
}
static wchar_t* hk_wcsdup(const wchar_t* s) {
    wchar_t* p = ((wchar_t* (*)(const wchar_t*))o_wcsdup)(s);
    track(p, s ? (wcslen(s) + 1) * sizeof(wchar_t) : 0);
    return p;
}
static LPVOID WINAPI hk_HeapAlloc(HANDLE h, DWORD f, SIZE_T n) {
    LPVOID p = ((LPVOID(WINAPI*)(HANDLE, DWORD, SIZE_T))o_HeapAlloc)(h, f, n);
    track(p, n);
    return p;
}
static LPVOID WINAPI hk_HeapReAlloc(HANDLE h, DWORD f, LPVOID old, SIZE_T n) {
    LPVOID p = ((LPVOID(WINAPI*)(HANDLE, DWORD, LPVOID, SIZE_T))o_HeapReAlloc)(h, f, old, n);
    if (p) retrack(old, p, n);
    return p;
}
static BOOL WINAPI hk_HeapFree(HANDLE h, DWORD f, LPVOID p) {
    untrack(p);
    return ((BOOL(WINAPI*)(HANDLE, DWORD, LPVOID))o_HeapFree)(h, f, p);
}
static HLOCAL WINAPI hk_LocalAlloc(UINT f, SIZE_T n) {
    HLOCAL p = ((HLOCAL(WINAPI*)(UINT, SIZE_T))o_LocalAlloc)(f, n);
    track(p, n);
    return p;
}
static HLOCAL WINAPI hk_LocalFree(HLOCAL p) {
    untrack(p);
    return ((HLOCAL(WINAPI*)(HLOCAL))o_LocalFree)(p);
}
static HGLOBAL WINAPI hk_GlobalAlloc(UINT f, SIZE_T n) {
    HGLOBAL p = ((HGLOBAL(WINAPI*)(UINT, SIZE_T))o_GlobalAlloc)(f, n);
    track(p, n);
    return p;
}
static HGLOBAL WINAPI hk_GlobalFree(HGLOBAL p) {
    untrack(p);
    return ((HGLOBAL(WINAPI*)(HGLOBAL))o_GlobalFree)(p);
}
static LPVOID WINAPI hk_VirtualAlloc(LPVOID a, SIZE_T n, DWORD type, DWORD prot) {
    LPVOID p = ((LPVOID(WINAPI*)(LPVOID, SIZE_T, DWORD, DWORD))o_VirtualAlloc)(a, n, type, prot);
    // Only a fresh region (no explicit address) is a new allocation; committing
    // inside a region the DLL already reserved must not double-count it.
    if (p && !a) track(p, n);
    return p;
}
static BOOL WINAPI hk_VirtualFree(LPVOID a, SIZE_T n, DWORD type) {
    if (type & MEM_RELEASE) untrack(a);
    return ((BOOL(WINAPI*)(LPVOID, SIZE_T, DWORD))o_VirtualFree)(a, n, type);
}
static LPVOID WINAPI hk_CoRealloc(LPVOID old, SIZE_T n) {
    LPVOID p = ((LPVOID(WINAPI*)(LPVOID, SIZE_T))o_CoRealloc)(old, n);
    if (p || n == 0) retrack(old, p, n);
    return p;
}
static BSTR WINAPI hk_SysAllocString(const OLECHAR* s) {
    BSTR p = ((BSTR(WINAPI*)(const OLECHAR*))o_SysAllocString)(s);
    track(p, s ? (wcslen(s) + 1) * sizeof(OLECHAR) : 0);
    return p;
}
static BSTR WINAPI hk_SysAllocStringLen(const OLECHAR* s, UINT len) {
    BSTR p = ((BSTR(WINAPI*)(const OLECHAR*, UINT))o_SysAllocStringLen)(s, len);
    track(p, (size_t)(len + 1) * sizeof(OLECHAR));
    return p;
}
static BSTR WINAPI hk_SysAllocStringByteLen(LPCSTR s, UINT len) {
    BSTR p = ((BSTR(WINAPI*)(LPCSTR, UINT))o_SysAllocStringByteLen)(s, len);
    track(p, (size_t)len + 2);
    return p;
}
static INT WINAPI hk_SysReAllocString(BSTR* pbstr, const OLECHAR* s) {
    BSTR old = pbstr ? *pbstr : nullptr;
    INT r = ((INT(WINAPI*)(BSTR*, const OLECHAR*))o_SysReAllocString)(pbstr, s);
    if (r && pbstr) retrack(old, *pbstr, s ? (wcslen(s) + 1) * sizeof(OLECHAR) : 0);
    return r;
}
static INT WINAPI hk_SysReAllocStringLen(BSTR* pbstr, const OLECHAR* s, UINT len) {
    BSTR old = pbstr ? *pbstr : nullptr;
    INT r = ((INT(WINAPI*)(BSTR*, const OLECHAR*, UINT))o_SysReAllocStringLen)(pbstr, s, len);
    if (r && pbstr) retrack(old, *pbstr, (size_t)(len + 1) * sizeof(OLECHAR));
    return r;
}

// --- IAT patching ----------------------------------------------------------------

static int g_nAlloc = 0, g_nFree = 0;

static bool starts(const char* s, const char* pre) { return strncmp(s, pre, strlen(pre)) == 0; }

// Returns the hook for an import, recording the original pointer; null = not hooked.
static void* hook_for(const char* name, void* orig) {
    if (!strcmp(name, "malloc") || !strcmp(name, "_malloc_base") ||
        !strcmp(name, "_aligned_malloc") || !strcmp(name, "CoTaskMemAlloc") ||
        starts(name, "??2@") || starts(name, "??_U@")) {
        if (g_nAlloc >= kSlots) return nullptr;
        g_origAlloc[g_nAlloc] = orig;
        return kAllocHooks[g_nAlloc++];
    }
    if (!strcmp(name, "free") || !strcmp(name, "_free_base") || !strcmp(name, "_aligned_free") ||
        !strcmp(name, "CoTaskMemFree") || !strcmp(name, "SysFreeString") ||
        starts(name, "??3@") || starts(name, "??_V@")) {
        if (g_nFree >= kSlots) return nullptr;
        g_origFree[g_nFree] = orig;
        return kFreeHooks[g_nFree++];
    }
#define SINGLE(n, var, fn) if (!strcmp(name, n)) { var = orig; return (void*)&fn; }
    SINGLE("calloc", o_calloc, hk_calloc)
    SINGLE("_calloc_base", o_calloc, hk_calloc)
    SINGLE("realloc", o_realloc, hk_realloc)
    SINGLE("_realloc_base", o_realloc, hk_realloc)
    SINGLE("_recalloc", o_recalloc, hk_recalloc)
    SINGLE("_aligned_realloc", o_aligned_realloc, hk_aligned_realloc)
    SINGLE("_strdup", o_strdup, hk_strdup)
    SINGLE("_wcsdup", o_wcsdup, hk_wcsdup)
    SINGLE("HeapAlloc", o_HeapAlloc, hk_HeapAlloc)
    SINGLE("HeapReAlloc", o_HeapReAlloc, hk_HeapReAlloc)
    SINGLE("HeapFree", o_HeapFree, hk_HeapFree)
    SINGLE("LocalAlloc", o_LocalAlloc, hk_LocalAlloc)
    SINGLE("LocalFree", o_LocalFree, hk_LocalFree)
    SINGLE("GlobalAlloc", o_GlobalAlloc, hk_GlobalAlloc)
    SINGLE("GlobalFree", o_GlobalFree, hk_GlobalFree)
    SINGLE("VirtualAlloc", o_VirtualAlloc, hk_VirtualAlloc)
    SINGLE("VirtualFree", o_VirtualFree, hk_VirtualFree)
    SINGLE("CoTaskMemRealloc", o_CoRealloc, hk_CoRealloc)
    SINGLE("SysAllocString", o_SysAllocString, hk_SysAllocString)
    SINGLE("SysAllocStringLen", o_SysAllocStringLen, hk_SysAllocStringLen)
    SINGLE("SysAllocStringByteLen", o_SysAllocStringByteLen, hk_SysAllocStringByteLen)
    SINGLE("SysReAllocString", o_SysReAllocString, hk_SysReAllocString)
    SINGLE("SysReAllocStringLen", o_SysReAllocStringLen, hk_SysReAllocStringLen)
#undef SINGLE
    return nullptr;
}

// oleaut32 exports the BSTR API by ordinal and the linker imports it that way.
static const char* oleaut_name(WORD ord) {
    switch (ord) {
    case 2: return "SysAllocString";
    case 3: return "SysReAllocString";
    case 4: return "SysAllocStringLen";
    case 5: return "SysReAllocStringLen";
    case 6: return "SysFreeString";
    case 150: return "SysAllocStringByteLen";
    }
    return nullptr;
}

static bool is_ours(void* fn) {
    uintptr_t p = (uintptr_t)fn;
    return p >= g_selfLo && p < g_selfHi;
}

static int patch_module(HMODULE mod) {
    BYTE* base = (BYTE*)mod;
    auto dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return -1;
    auto nt = (IMAGE_NT_HEADERS64*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
        return -2;   // not a 64-bit image
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress) return 0;

    int patched = 0;
    for (auto imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress); imp->Name; ++imp) {
        const char* dllName = (const char*)(base + imp->Name);
        auto oft = (IMAGE_THUNK_DATA64*)(base + (imp->OriginalFirstThunk ? imp->OriginalFirstThunk
                                                                           : imp->FirstThunk));
        auto ft = (IMAGE_THUNK_DATA64*)(base + imp->FirstThunk);
        for (; oft->u1.AddressOfData; ++oft, ++ft) {
            const char* fn = nullptr;
            if (IMAGE_SNAP_BY_ORDINAL64(oft->u1.Ordinal)) {
                if (_strnicmp(dllName, "oleaut32", 8) != 0) continue;
                fn = oleaut_name((WORD)IMAGE_ORDINAL64(oft->u1.Ordinal));
                if (!fn) continue;
            } else {
                auto ibn = (IMAGE_IMPORT_BY_NAME*)(base + oft->u1.AddressOfData);
                fn = (const char*)ibn->Name;
            }
            void* cur = (void*)ft->u1.Function;
            if (!cur || is_ours(cur)) continue;
            void* hook = hook_for(fn, cur);
            if (!hook) continue;
            DWORD old;
            if (!VirtualProtect(&ft->u1.Function, sizeof(void*), PAGE_READWRITE, &old)) continue;
            ft->u1.Function = (ULONGLONG)(uintptr_t)hook;
            VirtualProtect(&ft->u1.Function, sizeof(void*), old, &old);
            g_hooked.push_back({dllName, fn});
            patched++;
        }
    }
    return patched;
}

// --- Exports ------------------------------------------------------------------------

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) g_self = h;
    return TRUE;
}

static void init_self_range() {
    BYTE* base = (BYTE*)g_self;
    auto dos = (IMAGE_DOS_HEADER*)base;
    auto nt = (IMAGE_NT_HEADERS64*)(base + dos->e_lfanew);
    g_selfLo = (uintptr_t)base;
    g_selfHi = g_selfLo + nt->OptionalHeader.SizeOfImage;
}

TRK_API void* fnp_tracker_heap() { return g_heap; }

TRK_API int fnp_tracker_init() {
    if (g_heap) return 1;
    init_self_range();
    g_heap = HeapCreate(0, 0, 0);
    if (!g_heap) return 0;
    g_blocks = new (HeapAlloc(g_heap, 0, sizeof(BlockMap))) BlockMap();
    g_stackIndex = new (HeapAlloc(g_heap, 0, sizeof(StackIndex))) StackIndex();
    g_stacks = new (HeapAlloc(g_heap, 0, sizeof(StackVec))) StackVec();
    return 1;
}

// Patches the module's imports. Returns the number of hooked imports, negative on error.
TRK_API int fnp_tracker_attach(void* hmodule) {
    if (!g_heap) return -10;
    HMODULE mod = (HMODULE)hmodule;
    auto dos = (IMAGE_DOS_HEADER*)mod;
    auto nt = (IMAGE_NT_HEADERS64*)((BYTE*)mod + dos->e_lfanew);
    g_targetLo = (uintptr_t)mod;
    g_targetHi = g_targetLo + nt->OptionalHeader.SizeOfImage;
    char path[MAX_PATH] = {};
    GetModuleFileNameA(mod, path, MAX_PATH);
    g_targetName = BaseName(path);
    int n = patch_module(mod);
    if (n > 0) g_enabled = true;
    return n;
}

// Tells the symbolizer which module is the DLL under test without patching anything
// (used by crash reports when allocation tracking is off).
TRK_API void fnp_tracker_set_target(void* hmodule) {
    HMODULE mod = (HMODULE)hmodule;
    auto dos = (IMAGE_DOS_HEADER*)mod;
    auto nt = (IMAGE_NT_HEADERS64*)((BYTE*)mod + dos->e_lfanew);
    g_targetLo = (uintptr_t)mod;
    g_targetHi = g_targetLo + nt->OptionalHeader.SizeOfImage;
    char path[MAX_PATH] = {};
    GetModuleFileNameA(mod, path, MAX_PATH);
    g_targetName = BaseName(path);
}

TRK_API void fnp_tracker_begin_call(uint32_t call) { g_call.store(call); }

// Releases a block the harness itself freed (BSTR / CoTaskMem the caller owns).
TRK_API void fnp_untrack(void* p) { untrack(p); }

TRK_API void fnp_tracker_set_symbol_path(const wchar_t* path) { g_symPath = path ? path : L""; }

// --- Crash forensics -------------------------------------------------------------------
// ctypes turns a hardware exception inside a foreign call into a bare
// "OSError: access violation reading 0x..." with no location. A vectored exception
// handler sees the exception FIRST, on the faulting thread with the faulting context,
// so it can record the exact instruction and unwind the real call stack. The record is
// symbolized on request (fnp_crash_report) once Python has caught the OSError.
struct CrashRec {
    bool have = false;
    DWORD code = 0;
    ULONG_PTR kind = 0, addr = 0;
    DWORD tid = 0;
    int n = 0;
    uintptr_t frames[48];
};
static CrashRec g_crash;
static SRWLOCK g_crashLock = SRWLOCK_INIT;
static PVOID g_veh = nullptr;

static bool safe_read_u64(uintptr_t at, uint64_t* out) {
    __try {
        *out = *(volatile uint64_t*)at;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool is_fatal_code(DWORD c) {
    switch (c) {
    case EXCEPTION_ACCESS_VIOLATION: case EXCEPTION_IN_PAGE_ERROR: case EXCEPTION_ILLEGAL_INSTRUCTION:
    case EXCEPTION_PRIV_INSTRUCTION: case EXCEPTION_INT_DIVIDE_BY_ZERO: case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
    case EXCEPTION_STACK_OVERFLOW: case 0xC0000374 /*heap corruption*/: case 0xC0000409 /*fast fail*/:
        return true;
    }
    return false;
}

static LONG CALLBACK crash_veh(PEXCEPTION_POINTERS ep) {
    PEXCEPTION_RECORD er = ep->ExceptionRecord;
    if (!is_fatal_code(er->ExceptionCode)) return EXCEPTION_CONTINUE_SEARCH;

    CrashRec r;
    r.have = true;
    r.code = er->ExceptionCode;
    r.tid = GetCurrentThreadId();
    if (er->NumberParameters >= 2) { r.kind = er->ExceptionInformation[0]; r.addr = er->ExceptionInformation[1]; }

    CONTEXT c = *ep->ContextRecord;
    // Unwinding from a stack-overflow handler would overflow again: record only the PC.
    int limit = er->ExceptionCode == EXCEPTION_STACK_OVERFLOW ? 1 : 48;
    for (; r.n < limit; ) {
        r.frames[r.n++] = (uintptr_t)c.Rip;
        DWORD64 base = 0;
        PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry(c.Rip, &base, nullptr);
        if (!rf) {                       // leaf function: return address is at [rsp]
            uint64_t ret = 0;
            if (!c.Rsp || !safe_read_u64((uintptr_t)c.Rsp, &ret)) break;
            c.Rip = ret;
            c.Rsp += 8;
        } else {
            PVOID handlerData = nullptr;
            DWORD64 establisher = 0;
            RtlVirtualUnwind(UNW_FLAG_NHANDLER, base, c.Rip, rf, &c, &handlerData, &establisher, nullptr);
        }
        if (!c.Rip) break;
    }

    AcquireSRWLockExclusive(&g_crashLock);
    g_crash = r;    // the latest fatal-looking exception wins: it is the one Python sees
    ReleaseSRWLockExclusive(&g_crashLock);
    return EXCEPTION_CONTINUE_SEARCH;   // never swallow: the normal handlers still run
}

TRK_API void fnp_crash_install() {
    if (!g_veh) g_veh = AddVectoredExceptionHandler(1, crash_veh);
}

TRK_API void fnp_crash_clear() {
    AcquireSRWLockExclusive(&g_crashLock);
    g_crash = CrashRec();
    ReleaseSRWLockExclusive(&g_crashLock);
}

// Symbolizes the recorded crash into a JSON file. Returns 0 on success, 1 if no crash
// was recorded, negative on I/O error.
TRK_API int fnp_crash_report(const wchar_t* outPath) {
    CrashRec r;
    AcquireSRWLockExclusive(&g_crashLock);
    r = g_crash;
    ReleaseSRWLockExclusive(&g_crashLock);
    if (!r.have) return 1;

    Symbolizer sym;
    bool symOk = sym.init(GetCurrentProcess(), g_symPath, true);
    sym.targetModule = g_targetName;

    std::string js = "{";
    char nb[160];
    snprintf(nb, sizeof nb, "\"code\":\"0x%08lX\",\"kind\":%llu,\"address\":\"0x%llx\",\"thread\":%lu,",
             (unsigned long)r.code, (unsigned long long)r.kind, (unsigned long long)r.addr,
             (unsigned long)r.tid);
    js += nb;
    js += "\"target\":\"" + JsonEscape(g_targetName) + "\",\"frames\":[";
    bool first = true;
    for (int i = 0; i < r.n; i++) {
        std::vector<SymFrame> frames;
        sym.resolve((DWORD64)r.frames[i], i != 0, frames, true);
        for (auto& f : frames) {
            if (!first) js += ",";
            first = false;
            std::string mod = f.module;
            js += "{\"module\":\"" + JsonEscape(mod) + "\",\"func\":\"" + JsonEscape(f.func) +
                  "\",\"file\":\"" + JsonEscape(f.file) + "\",";
            snprintf(nb, sizeof nb, "\"line\":%u,\"inlined\":%s,\"index\":%d}", f.line,
                     f.inlined ? "true" : "false", i);
            js += nb;
        }
    }
    js += "]";
    {
        std::string tmod, tpdb;
        int ttype = -1;
        if (symOk && g_targetLo) sym.moduleInfo(g_targetLo + 16, tmod, tpdb, ttype);
        snprintf(nb, sizeof nb, ",\"sym_type\":%d,\"pdb\":", ttype);
        js += nb;
        js += "\"" + JsonEscape(tpdb) + "\"";
    }
    js += "}";
    sym.shutdown();

    FILE* fp = _wfopen(outPath, L"wb");
    if (!fp) return -2;
    fwrite(js.data(), 1, js.size(), fp);
    fclose(fp);
    return 0;
}

TRK_API void fnp_tracker_stats(uint64_t* allocs, uint64_t* frees, uint64_t* live_blocks,
                               uint64_t* live_bytes) {
    Lock lk;
    uint64_t b = 0;
    for (auto& kv : *g_blocks) b += kv.second.size;
    if (allocs) *allocs = g_allocs;
    if (frees) *frees = g_frees;
    if (live_blocks) *live_blocks = g_blocks->size();
    if (live_bytes) *live_bytes = b;
}

struct Site {
    uint32_t stack;
    uint64_t count = 0, bytes = 0;
    uint32_t firstCall = UINT32_MAX, lastCall = 0;
    std::set<uint32_t> calls;
};

// Writes the leak report. min_call: only blocks allocated by call >= min_call are
// leak candidates (earlier ones are warmup / lazy-init). Returns 0 on success.
TRK_API int fnp_tracker_report(const wchar_t* outPath, uint32_t min_call, int top_n) {
    if (!g_heap) return -1;
    std::map<uint32_t, Site> sites;
    uint64_t liveBlocks = 0, liveBytes = 0, baseBlocks = 0, baseBytes = 0;
    std::vector<std::pair<uint32_t, std::vector<void*>>> stackCopies;
    {
        Lock lk;
        for (auto& kv : *g_blocks) {
            const Block& b = kv.second;
            liveBlocks++;
            liveBytes += b.size;
            if (b.call < min_call) { baseBlocks++; baseBytes += b.size; continue; }
            Site& s = sites[b.stack];
            s.stack = b.stack;
            s.count++;
            s.bytes += b.size;
            s.calls.insert(b.call);
            s.firstCall = std::min(s.firstCall, b.call);
            s.lastCall = std::max(s.lastCall, b.call);
        }
        for (auto& kv : sites) {
            const StackRec& r = (*g_stacks)[kv.first];
            stackCopies.push_back({kv.first, std::vector<void*>(r.frames, r.frames + r.n)});
        }
    }
    std::vector<Site*> order;
    for (auto& kv : sites) order.push_back(&kv.second);
    std::sort(order.begin(), order.end(), [](Site* a, Site* b) { return a->bytes > b->bytes; });
    if (top_n > 0 && (int)order.size() > top_n) order.resize(top_n);

    // Symbolize
    Symbolizer sym;
    bool symOk = sym.init(GetCurrentProcess(), g_symPath, true);
    sym.targetModule = g_targetName;
    std::map<uint32_t, std::vector<void*>*> stackMap;
    for (auto& p : stackCopies) stackMap[p.first] = &p.second;

    std::string js;
    js.reserve(1 << 16);
    char nb[128];
    js += "{";
    snprintf(nb, sizeof nb, "\"tracked_allocs\":%llu,\"tracked_frees\":%llu,",
             (unsigned long long)g_allocs.load(), (unsigned long long)g_frees.load());
    js += nb;
    snprintf(nb, sizeof nb, "\"live_blocks\":%llu,\"live_bytes\":%llu,",
             (unsigned long long)liveBlocks, (unsigned long long)liveBytes);
    js += nb;
    snprintf(nb, sizeof nb, "\"baseline_live_blocks\":%llu,\"baseline_live_bytes\":%llu,",
             (unsigned long long)baseBlocks, (unsigned long long)baseBytes);
    js += nb;
    snprintf(nb, sizeof nb, "\"candidate_sites\":%zu,\"min_call\":%u,", sites.size(), min_call);
    js += nb;
    js += "\"target\":\"" + JsonEscape(g_targetName) + "\",";
    js += "\"hooked\":[";
    for (size_t i = 0; i < g_hooked.size(); i++) {
        if (i) js += ",";
        js += "{\"dll\":\"" + JsonEscape(g_hooked[i].dll) + "\",\"name\":\"" +
              JsonEscape(g_hooked[i].name) + "\"}";
    }
    js += "],\"sites\":[";

    bool firstSite = true;
    for (Site* s : order) {
        if (!firstSite) js += ",";
        firstSite = false;
        snprintf(nb, sizeof nb,
                 "{\"count\":%llu,\"bytes\":%llu,\"calls\":%zu,\"first_call\":%u,\"last_call\":%u,",
                 (unsigned long long)s->count, (unsigned long long)s->bytes, s->calls.size(),
                 s->firstCall, s->lastCall);
        js += nb;
        js += "\"frames\":[";
        std::vector<SymFrame> frames;
        auto& raw = *stackMap[s->stack];
        for (size_t i = 0; i < raw.size(); i++) {
            // Frame 0 is where the hook was entered: a return address into the caller.
            sym.resolve((DWORD64)(uintptr_t)raw[i], true, frames, true);
        }
        bool ff = true;
        for (auto& f : frames) {
            if (!ff) js += ",";
            ff = false;
            js += "{\"module\":\"" + JsonEscape(f.module) + "\",\"func\":\"" + JsonEscape(f.func) +
                  "\",\"file\":\"" + JsonEscape(f.file) + "\",";
            snprintf(nb, sizeof nb, "\"line\":%u,\"inlined\":%s}", f.line, f.inlined ? "true" : "false");
            js += nb;
        }
        js += "]}";
    }
    js += "]";
    {
        // Queried last: dbghelp loads symbols lazily, so the module's state only
        // reflects the PDB once at least one address has been resolved.
        std::string tmod, tpdb;
        int ttype = -1;
        if (symOk && g_targetLo) sym.moduleInfo(g_targetLo + 16, tmod, tpdb, ttype);
        js += ",\"symbols\":{\"initialized\":";
        js += symOk ? "true" : "false";
        snprintf(nb, sizeof nb, ",\"sym_type\":%d,", ttype);
        js += nb;
        js += "\"pdb\":\"" + JsonEscape(tpdb) + "\"}";
    }
    js += "}";
    sym.shutdown();

    FILE* fp = _wfopen(outPath, L"wb");
    if (!fp) return -2;
    fwrite(js.data(), 1, js.size(), fp);
    fclose(fp);
    return 0;
}
