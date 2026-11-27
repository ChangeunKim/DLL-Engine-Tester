# FnGenesis DLL Tester Web Application

이 프로젝트는 기존 Jupyter Notebook(`dll_tester.ipynb`) 환경을 완벽하게 대치하기 위해 개발된 **직관적이고 가독성 높은 평가 엔진 DLL 테스트용 로컬 웹 서버**입니다.
가장 현대적인 Glassmorphism 기반의 다크 테마 UI를 채택하여 우아한 사용자 경험을 제공하며, DLL 메모리 잠금 현상을 완전히 정복하여 최고의 테스트/빌드 환경을 보장합니다.

---

## 🚀 주요 핵심 기능 (Features)

**1. 완벽한 DLL 메모리 해제 및 분리 (No Lock Issue)**
- 웹 서버(Flask)와 실제 DLL 실행기(`runner.py`)가 내부적으로 **완벽한 독립 프로세스 체제**로 분리되어 있습니다.
- Run 버튼을 눌러 테스트를 수행한 직후 관련 메모리와 파일 잠금(Lock)이 OS 레벨에서 0.1초 만에 즉각 해제됩니다.
- 웹 서버를 절대 끄지 않은 상태에서도 언제나 Visual Studio에서 원본 C++ 코드를 수정하고 **에러 없이 즉시 재빌드(Rebuild)**할 수 있습니다.

**2. 윈도우 네이티브 파일 탐색기 연동**
- `Browse` 버튼 클릭 시 웹 브라우저 안의 답답한 가짜 탐색기가 아니라, 사용자 PC 바탕화면에 실제 **윈도우 파일 탐색기(Windows File Explorer) 팝업**을 띄워 경로를 직관적으로 선택하게 해줍니다.
- DLL 버튼은 소스코드 출력 폴더를, JSON 버튼은 현재 프로젝트의 JSON 폴더를 디폴트 경로로 자동 타겟팅합니다.

**3. Input/Output JSON 실시간 뷰어 및 다운로드**
- 좌측: 파일 탐색기에서 인풋 `.json` 파일을 선택하거나 앱을 켜면, 터미널 박스 안에 해당 JSON 텍스트를 즉시 프리뷰로 띄워줍니다.
- 우측: C++ DLL을 통과하여 반환된 Output JSON 스트링이 문법 강조(Syntax Highlighting)와 함께 출력되며, `.json` 파일로 즉시 다운로드할 수 있는 **💾 Save JSON 버튼**을 제공합니다.
- 양쪽 화면 길이를 1:1로 맞추고 독립적인 스크롤바를 배치하여 수천 줄의 JSON도 쾌적하게 훑어볼 수 있습니다.

**4. 자동 반영 핫 리로드 (Hot-Reloading)**
- 번거롭게 서버를 껐다 켤 필요가 없습니다! 파이썬, HTML, JS 파일을 수정하고 저장하면 백그라운드 서버가 스스로 코드 변경을 감지해 1초 내에 자동 재시작됩니다. 웹사이트 새로고침(F5)만으로 모든 사항이 즉각 반영됩니다.

**5. 메모리 프로파일러 & 누수 검출 (Memory Profiler)**
- 똑같은 인풋 JSON으로 **반복 횟수를 지정해 DLL을 N번 호출**하고, 매 호출 전후의 프로세스 메모리를 샘플링해 **DLL이 물고 있는 메모리와 누수 여부**를 판정합니다.
- 측정은 항상 **새 프로세스**에서 수행되므로 이전 실행의 잔여 메모리가 기준선을 오염시키지 않습니다.
- 결과는 **NDJSON 스트리밍**으로 내려와 호출마다 차트가 실시간으로 갱신되며, 긴 실행은 `Cancel`로 즉시 중단할 수 있습니다.
- 측정 지표:
  - **Live heap(힙 사용 중 바이트)** — 누수 판정의 **1차 기준 신호**. 프로세스의 모든 힙을 `GetProcessHeaps` + `HeapSummary`로 읽어, 힙이 *실제로 할당해 쥐고 있는* 바이트(`cbAllocated`)와 *커밋만 해 둔* 바이트(`cbCommitted`)를 분리합니다. private bytes는 힙·스택·`VirtualAlloc`·Python 자체 메모리가 섞이고 할당자가 페이지를 계단식으로 반납해서 같은 누수도 R²가 낮게 나오지만, live heap은 선형 증가가 그대로 드러납니다.
  - **Private bytes(커밋 차지)** — 보조 신호. 힙 밖(`VirtualAlloc`, 매핑 뷰) 누수를 잡기 위해 `private − 힙 커밋`(non-heap)도 함께 회귀합니다.
  - **Working set** — 실제 상주 메모리.
  - **In-call peak / Transient** — 호출이 진행되는 동안 5ms 간격으로 샘플링한 최고점과, 반환 후 반납한 양. "인풋 하나 돌릴 때 순간적으로 몇 MB를 쓰는가"에 대한 답입니다.
  - **DLL module image** — 로드된 모듈 자체의 이미지 크기와 매핑 주소.
  - **First-call init** — 첫 호출의 일회성 초기화 비용. 지연 초기화(lazy init)를 누수로 오판하지 않기 위해 따로 분리해 보여줍니다.
- **누수 판정 로직**: warmup 구간을 제외한 구간에 최소제곱 회귀를 적용해 호출당 증가량(slope)과 적합도(R²)를 구합니다. 판정은 **live heap**과 **non-heap** 중 더 나쁜 쪽을 따르고, private bytes만 늘고 live heap은 평평하면 "커밋만 증가(단편화/할당자 보유)"로 보고 `Possible leak`과 원인 설명을 띄웁니다.
  - `호출당 증가량 ≤ 1 KB` 또는 총 증가량이 64 KB 이하 → **No leak**
  - `R² ≥ 0.85` (일관된 선형 증가) 또는 `호출당 32 KB 이상` → **Leak detected**
  - 그 사이 → **Possible leak** (반복 횟수를 늘려 재측정 권장)
- **Warmup**: 앞쪽 N번의 호출은 회귀에서 제외합니다. 지연 초기화·캐시 예열·힙 아레나 확장은 정상 동작인데도 초반 메모리를 늘리므로, 이를 포함하면 slope가 과대평가됩니다. 기본값 3이 대부분의 엔진에 적절합니다.
- **Output buffer release**: DLL이 호출마다 출력 문자열 버퍼를 새로 할당하면 **해제 책임은 호출자**에게 있습니다. 이 옵션을 `Do not free`로 두면 테스터가 버퍼를 방치하므로 DLL이 정상이어도 누수로 보입니다. 엔진이 `SysAllocString`(BSTR)을 쓰면 **SysFreeString**, `CoTaskMemAlloc`을 쓰면 **CoTaskMemFree**를 선택해야 DLL 자체의 누수만 측정됩니다. 적용 대상은 두 가지입니다.
  - out-pointer 시그니처 `[c_wchar_p, POINTER(c_wchar_p)]`: 포인터가 가리키는 버퍼를 해제합니다.
  - 반환값이 문자열인 시그니처(Return Type이 `c_wchar_p` / `c_char_p`): 해제 방식을 고르면 반환 포인터를 직접 받아 문자열을 복사한 뒤 원본 버퍼를 해제합니다. ctypes의 기본 `c_wchar_p` 반환은 문자열만 복사하고 원본을 해제하지 않으므로, DLL이 BSTR을 반환하면 호출마다 누수가 생깁니다.
  - 두 경우 모두 `Do not free`로 실행하면 경고 메모가 함께 표시됩니다.
- 시각화 4종 — **live heap vs 커밋 힙**, 호출별 보유 메모리 추이(추세선 포함), 호출별 증감(양수=보유/음수=반납), 호출 중 순간 메모리. 세 차트는 크로스헤어가 연동되며 방향키로도 탐색할 수 있습니다. 호출 수가 많으면 열을 자동으로 묶고 축은 실제 호출 번호를 표기합니다.
- 전체 원자료는 **Download CSV** 또는 per-call 표로 확인할 수 있고, C++ 쪽 `printf`/`std::cout` 로그도 함께 수집돼 표시됩니다.
- 실행 중 DLL이 죽으면 "몇 번째 호출에서 멈췄는지"와 그 시점까지의 메모리 곡선을 그대로 보여줍니다.

**6. 누수 함수 추적 (Leak sites) — `Track leak call stacks`**
- 체크하면 `bin\fnp_tracker.dll`이 **테스트 대상 DLL의 import 테이블(IAT)만** 패치해, 그 DLL이 하는 할당/해제를 호출 스택과 함께 기록합니다. Python이나 다른 모듈의 할당은 보이지 않으므로 결과는 DLL 자체에 대한 것입니다.
- warmup 이후 할당되어 **끝까지 해제되지 않은 블록**을 호출 스택별로 묶어 **바이트·블록 수·함수명·파일:라인**(inline 프레임 포함)으로 보여줍니다. 이는 Visual Studio 진단 도구의 heap snapshot diff와 같은 정보입니다. (변수명이 아니라 *할당이 일어난 호출 스택*을 알려줍니다.)
- 블록이 **거의 모든 호출에서** 살아남은 사이트는 `Leaks every call`, 한 번만 나타난 사이트는 `One-time`(지연 초기화)로 구분합니다. `operator new`/STL 내부 프레임은 건너뛰고 DLL 자신의 코드를 "발생 지점"으로 표시합니다.
- 후킹 대상: `malloc/calloc/realloc/free/_aligned_*/_strdup`, `operator new/delete`(throw/nothrow/array/aligned/sized), `HeapAlloc/ReAlloc/Free`, `Local/GlobalAlloc`, `VirtualAlloc/Free`, `CoTaskMem*`, `SysAllocString*`(BSTR, 서수 import 포함). 테스터가 출력 버퍼를 직접 해제할 때는 해당 블록을 추적에서 먼저 제외합니다.
- 한계: delay-load import, 대상 DLL이 호출하는 *다른* DLL(예: `msvcp140.dll` 내부) 안의 할당, CRT 정적 링크(`/MT`) DLL은 보이지 않습니다. 추적 중에는 할당마다 비용이 들어 실행 시간이 늘어나므로 **시간 측정은 Speed Profiler로** 하세요.

**7. 실행 속도 분석 (Speed Profiler)**
- **1단계(timing)**: 아무것도 붙이지 않고 N번 호출해 호출당 **wall 시간과 CPU 시간**, median/p95/p99/표준편차, 첫 호출 비용을 구합니다. CPU 시간은 15.6ms 단위로만 갱신되는 `GetThreadTimes` 대신 `QueryThreadCycleTime`으로 측정해 짧은 호출에서도 정확합니다. wall과 CPU의 차이는 **대기 시간**(sleep, I/O, 락)입니다.
- **2단계(sampling)**: `bin\fnp_sampler.exe`가 **별도 프로세스**에서 호출 스레드의 스택을 약 1ms마다 떠서(스레드 정지는 샘플당 ~50µs) PDB로 함수/파일/라인/inline 프레임을 해석하고, 반복 호출 전체에 걸쳐 누적합니다. 같은 프로세스에서 하면 힙 락을 쥔 스레드를 멈춘 채 할당하다 데드락이 나므로 반드시 별도 프로세스입니다.
- 결과: **flame graph**(클릭으로 확대), **모듈별 시간**(DLL 코드 / C++ 런타임 / OS 대기), **hottest functions 표**(self/inclusive, 호출당 추정 ms). 샘플 커버리지(샘플 수 × 간격 ÷ 호출 시간)를 함께 표시해 신뢰도를 확인할 수 있습니다.
- 두 단계를 나눈 이유: 샘플링은 호출을 약간 느리게 하므로 통계 수치가 오염되지 않도록 분리했습니다.

**8. PDB 심볼 연결 (Symbols)**
- Configuration의 `Symbols (PDB)` 칸에 `.pdb` 파일 또는 폴더를 지정합니다. 비워 두면 DLL 옆과 링크 시 기록된 경로에서 자동으로 찾습니다.
- DLL의 CodeView 레코드(GUID/age)와 PDB의 GUID를 직접 비교해 `PDB matched` / `PDB mismatch`(다른 빌드) / `No PDB found` / `No debug info`를 즉시 표시합니다. 재빌드 후 PDB가 낡았을 때 엉뚱한 함수명이 나오는 사고를 막습니다.
- Release 빌드에서도 PDB를 만들려면 링커 옵션 **Debug Information = Generate Debug Info (`/DEBUG`)** 를 켜세요 (코드 생성은 최적화 그대로입니다).

**9. 크래시 위치 표시**
- 프로파일 도중 DLL이 access violation 등으로 죽으면, 단순한 `OSError: access violation reading 0x...` 대신 **어느 단계(몇 번째 DLL 호출인지, 호출 뒤 측정인지)에서 실패했는지**와 **크래시가 난 모듈!함수 (파일:라인) 및 그 순간의 호출 스택**을 보여줍니다. `bin\fnp_tracker.dll`의 벡터화된 예외 핸들러가 예외 발생 시점에 스택을 기록하고, PDB가 매칭되면 함수명과 라인까지 해석합니다.
- `Measure live heap`(기본 켜짐)과 `Track leak call stacks`(기본 꺼짐)를 모두 끄면 예전 방식과 같은 조건으로 DLL을 호출합니다. 측정 방식 때문에 DLL이 다르게 동작하는지 의심될 때 비교용으로 쓰세요.

---

## 🛠️ 실행 방법

DLL 프레임워크와 네이티브 파일 탐색기 연동을 사용하기 때문에 **반드시 윈도우 로컬 파이썬(Windows Local Python)** 으로 실행해야 합니다.

### 1단계: 패키지 설치
초기 환경 세팅 시 1번만 수행합니다. (가상환경 사용을 권장합니다)
```bash
pip install -r requirements.txt
```

### 1.5단계: 네이티브 도구 빌드 (누수 함수 추적 / 속도 분석에 필요, 1회)
Visual Studio 2022(C++ 데스크톱 워크로드)가 설치되어 있으면 아래 한 줄로 `bin\`에 빌드됩니다. 메모리 증가량 측정만 쓴다면 건너뛰어도 됩니다.
```bat
native\build.bat
```
- `bin\fnp_tracker.dll` — 할당 추적기, `bin\fnp_sampler.exe` — 샘플링 프로파일러
- `bin\fnp_testdll.dll`(+PDB) — **자체 점검용 DLL**: 호출마다 새는 블록 2개, 1회성 지연 초기화, CPU 연산·할당·`Sleep` 구간이 의도적으로 들어 있습니다. 함수 `fnp_test_run`, Argument Type `[c_wchar_p, POINTER(c_wchar_p)]`, Output buffer release `SysFreeString`으로 두 프로파일러를 시험해 볼 수 있습니다. 입력 JSON에 `{"leak":0}`을 넣으면 누수가 꺼집니다.
- 테스터는 64비트 Python으로 도므로 **x64 DLL만** 로드할 수 있습니다.

### 2단계: 서버 실행
아래 명령어를 입력해 백그라운드 웹 서버를 작동시킵니다.
```bash
python app.py
```

### 3단계: 브라우저 접속
웹 브라우저(Chrome 권장)를 켜고 다음 주소에 접속합니다:
**http://127.0.0.1:5000**

👉 이제 브라우저 창과 Visual Studio를 듀얼 모니터에 띄워놓고 최적의 개발을 즐기시면 됩니다!

---

## ⚙️ DLL Function 설정 항목 가이드

화면의 인풋 및 아웃풋 데이터 자료형 지원(Argument Type / Return Type) 
- `c_wchar_p` : (기본값) C++ DLL에서 `BSTR` 타입 및 UTF-16 와이드 캐릭터 파라미터를 받을 때 매핑되는 유형
- `c_char_p` : 일반 ASCII 텍스트 처리나 레거시 자료형 확장 시 사용

## 💡 개발 및 수정 가이드

- `app.py`: 웹 서버 구동, 윈도우 탐색기 트리거, 통신 라우팅
- `runner.py`: dll 단독 실행 및 메모리 안전 해제를 위한 서브 프로세스 코어
- `runner_persistent.py`: VS 디버그 세션용 상주 실행기 (DLL을 물고 있는 상태로 반복 호출)
- `runner_speed.py`: 속도 프로파일러 실행기(timing 단계 + sampling 단계). `runner_profile.py`의 호출기/통계 함수를 재사용합니다.
- `symbols.py`: DLL의 CodeView(GUID/age)와 PDB(MSF 7.0 info stream)를 순수 Python으로 비교해 PDB 일치 여부를 판정합니다.
- `native_tools.py`: `bin\`의 네이티브 도구 위치 확인, 추적기 ctypes 래퍼, 샘플러 프로세스 제어.
- `native/`: `tracker/`(IAT 후킹 + 콜스택 기록 + dbghelp 심볼화), `sampler/`(스레드 정지→스택 스냅샷→재개 후 오프라인 언와인드), `common/symbols.h`(dbghelp 래퍼, inline 프레임 해석), `testdll/`(자체 점검 DLL), `build.bat`.
- `runner_profile.py`: 메모리 프로파일링 전용 실행기. DLL의 stdout(fd 1/2)을 임시 로그로 돌려놓고 NDJSON 채널을 분리하므로 C++ `printf`가 스트림을 깨뜨리지 않습니다. 측정 중 하네스 자체가 메모리를 늘리지 않도록 샘플은 고정폭 `array` 버퍼에 담습니다.
- `templates/index.html`: UI 구조 및 프레임 레이아웃
- `static/style.css`: 테마, 색상, 애니메이션, Flex/Grid 1:1 스크롤 레이아웃
- `static/script.js`: Fetch API 연동, JSON 프리뷰, 결과물 `.json` 파일 저장(다운로드) 로직
- `static/symbols.js`: PDB 칸 검증/상태 배지. `static/speed.js`: 속도 프로파일러 프런트엔드(flame graph 포함).
- `static/profiler.js`: 메모리 프로파일러 프런트엔드. NDJSON 스트림 파서와 인라인 SVG 차트를 직접 구현했으므로 외부 차트 라이브러리나 네트워크 없이 동작합니다.
