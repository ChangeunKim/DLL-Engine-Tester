// Self-test DLL for the FnP Engine Tester profilers. It deliberately contains
//   * two per-call leaks (a new[] block and a malloc block, from different functions),
//   * one one-time lazy allocation (must NOT be reported as a per-call leak),
//   * scratch memory that is correctly freed,
//   * a CPU-heavy stage (with an inlined helper), an allocation-heavy stage and a
//     sleeping stage, so the speed profiler has distinct hot spots to find.
// Input JSON may contain "leak":0 to disable the leaks and "work":N to scale the CPU
// work. Output is returned through a BSTR (caller frees with SysFreeString).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <oleauto.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define FNP_API extern "C" __declspec(dllexport)

static std::vector<char*> g_leakedBlocks;   // keeps the leaked pointers reachable
static char* g_lazyTable = nullptr;

static __forceinline double inline_kernel(double x) {
    return std::sin(x) * std::cos(x) + std::sqrt(x + 1.0);
}

__declspec(noinline) static double heavy_math(int rounds) {
    double acc = 0.0;
    for (int i = 0; i < rounds; ++i) acc += inline_kernel((double)i * 0.001);
    return acc;
}

__declspec(noinline) static void leak_parser_buffer() {
    char* p = new char[4096];
    memset(p, 0x5a, 4096);
    g_leakedBlocks.push_back(p);
}

__declspec(noinline) static void leak_cache_entry() {
    char* p = (char*)malloc(1024);
    memset(p, 0x33, 1024);
    g_leakedBlocks.push_back(p);
}

__declspec(noinline) static void lazy_init_once() {
    if (!g_lazyTable) {
        g_lazyTable = (char*)malloc(256 * 1024);
        memset(g_lazyTable, 1, 256 * 1024);
    }
}

__declspec(noinline) static double scratch_work() {
    std::vector<double> tmp(200000);
    for (size_t i = 0; i < tmp.size(); ++i) tmp[i] = (double)i * 0.5;
    double s = 0;
    for (double v : tmp) s += v;
    return s;   // tmp freed on return
}

__declspec(noinline) static double parse_stage(int work) { return heavy_math(300000 * work); }
__declspec(noinline) static double price_stage(int work) { return heavy_math(900000 * work); }
__declspec(noinline) static double alloc_stage() {
    double s = 0;
    for (int i = 0; i < 6000; ++i) {
        std::string* t = new std::string(200, 'a' + (i % 26));
        s += (*t)[i % 100];
        delete t;
    }
    return s;
}
__declspec(noinline) static void io_stage() { Sleep(12); }

__declspec(noinline) static std::wstring serialize_stage(double a, double b, double c) {
    std::wstring out = L"{\"result\":[";
    for (int i = 0; i < 400; ++i) {
        out += std::to_wstring(a + i);
        out += L',';
    }
    out += std::to_wstring(b + c);
    out += L"]}";
    return out;
}

FNP_API int fnp_test_run(const wchar_t* json, wchar_t** out) {
    std::wstring in;
    for (const wchar_t* c = json; c && *c; ++c)
        if (*c != L' ') in += *c;   // the tester re-serializes JSON with spaces
    bool leak = in.find(L"\"leak\":0") == std::wstring::npos;
    int work = 1;
    size_t w = in.find(L"\"work\":");
    if (w != std::wstring::npos) work = std::max(1, _wtoi(in.c_str() + w + 7));

    lazy_init_once();
    double a = parse_stage(work);
    double b = price_stage(work);
    double c = alloc_stage() + scratch_work();
    io_stage();
    if (leak) {
        leak_parser_buffer();
        leak_cache_entry();
    }
    std::wstring res = serialize_stage(a, b, c);
    *out = SysAllocString(res.c_str());
    return 0;
}

// Variant returning the BSTR by value, for the "returned string" signature.
FNP_API BSTR fnp_test_ret(const wchar_t* json) {
    wchar_t* o = nullptr;
    fnp_test_run(json, &o);
    return o;
}
