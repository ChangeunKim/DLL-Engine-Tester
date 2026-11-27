/* ==========================================================================
   Section manuals: a "?" button next to a section title that shows a short manual
   card on hover or keyboard focus (and stays open when clicked, for touch screens).

   Mark a spot with   <span class="help" data-help="KEY"></span>   and add the
   content under MANUALS[KEY] below. Content is plain text - it is inserted with
   textContent, never as HTML.
   ========================================================================== */

(function () {
    'use strict';

    var MANUALS = {
        config: {
            title: 'Configuration 사용법',
            summary: '테스트할 DLL, 함수, 입력 JSON을 정하고 한 번 실행합니다. 아래 두 프로파일러도 이 설정을 그대로 씁니다.',
            steps: [
                'DLL Path: Browse로 x64 DLL을 고릅니다. (64비트 Python이라 x86 DLL은 로드할 수 없습니다.)',
                'Symbols (PDB): 비워 두면 DLL 옆에서 자동으로 찾습니다. 배지가 PDB matched면 함수명·라인 해석이 가능합니다. mismatch면 DLL을 다시 빌드한 뒤 PDB가 갱신되지 않은 것입니다.',
                'Function Name / Argument Type / Return Type: [c_wchar_p]는 문자열을 받아 문자열을 돌려주는 함수, [c_wchar_p, POINTER(c_wchar_p)]는 결과를 출력 포인터로 받는 함수입니다.',
                'Input JSON: 파일을 고르거나 편집기에서 직접 수정합니다. Save / Save As로 저장할 수 있습니다.',
                'Execute DLL을 누르면 새 프로세스에서 한 번 실행하고 결과를 오른쪽에 보여줍니다.'
            ],
            tips: [
                'VS Debug Pause: DLL을 계속 로드한 채로 두어 Visual Studio에서 프로세스에 Attach해 디버깅할 수 있습니다. 끄면 실행이 끝날 때마다 DLL 잠금이 풀려 바로 재빌드할 수 있습니다.'
            ]
        },

        output: {
            title: 'Execution Output 사용법',
            summary: 'Execute DLL의 결과를 보여줍니다.',
            steps: [
                '정상 실행되면 반환된 JSON이 문법 강조와 함께 표시됩니다.',
                'Save JSON으로 결과를 파일로 저장합니다.',
                '오른쪽 위 확대 버튼으로 전체 화면으로 볼 수 있습니다.'
            ],
            tips: [
                'DLL이 printf / std::cout으로 남긴 로그도 함께 표시됩니다.',
                'DLL이 죽으면 종료 코드와 마지막 출력이 표시됩니다.'
            ]
        },

        memory: {
            title: 'Memory Profiler 사용법',
            summary: '같은 입력으로 DLL을 N번 호출하면서 메모리를 측정해 누수 여부를 판정하고, 원하면 어느 함수가 새는지도 찾아줍니다. 매번 새 프로세스에서 측정합니다.',
            steps: [
                'Iterations: 호출 횟수입니다. 30회 이상을 권장하며, 결과가 애매하면 더 늘려서 다시 측정하세요.',
                'Warmup: 앞쪽 N번은 판정에서 제외합니다. 지연 초기화나 캐시 예열은 정상 동작인데도 메모리를 늘리기 때문입니다. (기본 3)',
                'Output buffer release: DLL이 반환한 문자열 버퍼를 누가 해제하는지 정합니다. DLL이 BSTR을 쓰면 SysFreeString, CoTaskMemAlloc을 쓰면 CoTaskMemFree를 고르세요. Do not free로 두면 DLL이 정상이어도 누수로 보입니다.',
                'Track leak call stacks: 켜면 DLL의 할당/해제를 추적해 해제되지 않은 블록의 함수명과 파일:라인을 Leak sites에 보여줍니다. 실행이 느려지고 PDB가 필요합니다.',
                'Run Memory Profile을 누르면 호출마다 차트가 실시간으로 갱신되고, Cancel로 중단할 수 있습니다.'
            ],
            tips: [
                '가장 믿을 신호는 Live heap입니다. 이 선이 호출마다 계속 오르면 누수입니다.',
                'private bytes만 늘고 Live heap이 평평하면 단편화나 할당자가 페이지를 쥐고 있는 것이라 보통 누수가 아닙니다. (Possible leak으로 표시됩니다.)',
                'Leak sites에서 Leaks every call은 거의 모든 호출에서 블록이 남는 진짜 누수 후보, One-time은 한 번만 생긴 지연 초기화입니다.',
                'Leak tracking 중의 실행 시간은 느려진 값이므로, 속도는 Speed Profiler로 재세요.'
            ]
        },

        speed: {
            title: 'Speed Profiler 사용법',
            summary: '호출이 얼마나 걸리는지, 그 시간이 어느 함수에서 쓰이는지 분석합니다. 두 단계로 나뉩니다.',
            steps: [
                '1단계 (timing): 아무것도 붙이지 않고 Iterations만큼 호출해 호출당 시간(median, p95, p99)과 CPU 시간을 잽니다.',
                '2단계 (sampling): Find hot spots를 켜면 Sampled calls만큼 더 호출하면서 약 Interval(ms)마다 호출 스택을 떠서 어느 함수에 시간이 쓰이는지 모읍니다. 샘플링은 호출을 약간 느리게 하므로 통계와 따로 실행합니다.',
                'Warmup: 앞쪽 N번은 통계에서 제외합니다. (첫 호출 비용은 First call 타일에 따로 표시됩니다.)',
                'Run Speed Profile을 누르면 진행률이 표시되고, Cancel로 중단할 수 있습니다.'
            ],
            tips: [
                'Time per call 차트에서 Wall과 CPU의 간격은 대기 시간(Sleep, I/O, 락)입니다. CPU가 wall보다 훨씬 작으면 연산이 아니라 기다리느라 느린 것입니다.',
                'flame graph: 막대 폭이 그 함수가 쓴 시간 비중(하위 호출 포함)입니다. 클릭하면 확대, 맨 위 막대를 클릭하면 원래대로 돌아옵니다. 마우스를 올리면 호출당 추정 시간이 나옵니다.',
                'Hottest functions: Self는 함수 자체의 시간, Inclusive는 하위 호출까지 합친 시간입니다.',
                '샘플 수가 적다는 안내가 나오면 Sampled calls를 늘리거나 Interval을 줄이세요. 함수명이 module+offset으로만 나오면 Symbols (PDB) 상태를 확인하세요.'
            ]
        },

        leaks: {
            title: 'Leak sites 읽는 법',
            summary: 'warmup 이후 DLL이 할당했지만 끝까지 해제하지 않은 메모리를 호출 스택별로 묶어 보여줍니다.',
            steps: [
                '굵은 함수명이 해제되지 않은 메모리를 할당한 DLL 자신의 코드입니다. 파일:라인이 옆에 표시됩니다.',
                'Call stack을 펼치면 그 함수가 어디서 호출됐는지 전체 경로가 보입니다. (inlined 표시는 컴파일러가 합친 함수입니다.)',
                'from N of M calls는 M번의 측정 호출 중 N번에서 블록이 남았다는 뜻입니다.'
            ],
            tips: [
                'Leaks every call: 거의 매 호출마다 남는 블록이라 누수일 가능성이 높습니다.',
                'One-time: 한 번만 생긴 블록(캐시, 싱글턴, 벡터 버퍼의 마지막 확장 등)이라 대개 누수가 아닙니다.',
                '변수 이름이 아니라 할당이 일어난 호출 스택을 알려줍니다. 그 지점에서 만든 객체의 해제 경로를 확인하세요.'
            ]
        },

        flame: {
            title: 'Where the time goes 읽는 법',
            summary: '샘플링 결과로 그린 flame graph입니다. 위가 호출한 쪽, 아래로 갈수록 그 함수가 부른 하위 함수입니다.',
            steps: [
                '막대 폭 = 전체 호출 시간 중 그 함수(하위 호출 포함)가 차지한 비중입니다.',
                '막대를 클릭하면 그 함수를 기준으로 확대되고, 맨 위의 all calls 막대를 클릭하면 되돌아갑니다.',
                '마우스를 올리면 아래 칸에 비중, 호출당 추정 시간, 파일:라인이 나옵니다.'
            ],
            tips: [
                '색: 파랑 = DLL 자신의 코드, 초록 = C/C++ 런타임(할당, 수학 함수), 주황 = OS(대기, 락).',
                'SleepEx 등 주황색 막대가 넓으면 연산이 아니라 대기 때문에 느린 것입니다.',
                '(internal)은 심볼이 없는 시스템 DLL 내부 함수를 한데 묶은 것입니다.'
            ]
        }
    };

    function el(tag, cls, txt) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (txt !== undefined) n.textContent = txt;
        return n;
    }

    function list(tag, label, items) {
        var wrap = el('div', 'help-block');
        wrap.appendChild(el('div', 'help-label', label));
        var l = el(tag);
        items.forEach(function (t) { l.appendChild(el('li', null, t)); });
        wrap.appendChild(l);
        return wrap;
    }

    var seq = 0;

    function build(host) {
        var m = MANUALS[host.getAttribute('data-help')];
        if (!m) return;
        var id = 'help-pop-' + (++seq);

        var btn = el('button', 'help-btn', '?');
        btn.type = 'button';
        btn.setAttribute('aria-label', m.title);
        btn.setAttribute('aria-describedby', id);
        btn.setAttribute('aria-expanded', 'false');

        var pop = el('div', 'help-pop');
        pop.id = id;
        pop.setAttribute('role', 'tooltip');
        pop.appendChild(el('div', 'help-title', m.title));
        pop.appendChild(el('p', 'help-summary', m.summary));
        if (m.steps && m.steps.length) pop.appendChild(list('ol', '사용 방법', m.steps));
        if (m.tips && m.tips.length) pop.appendChild(list('ul', '알아두면 좋은 점', m.tips));

        host.appendChild(btn);
        host.appendChild(pop);

        function place() {
            // Open to the right by default; flip to the left edge if it would overflow.
            host.classList.remove('align-right');
            var r = pop.getBoundingClientRect();
            if (r.right > window.innerWidth - 8) host.classList.add('align-right');
            r = pop.getBoundingClientRect();
            if (r.left < 8) host.classList.remove('align-right');

            // Open downward unless there is more room above; either way fit the viewport.
            host.classList.remove('drop-up');
            pop.style.maxHeight = '';
            var b = btn.getBoundingClientRect();
            var below = window.innerHeight - b.bottom - 24;
            var above = b.top - 24;
            var natural = pop.scrollHeight + 2;
            var up = natural > below && above > below;
            if (up) host.classList.add('drop-up');
            pop.style.maxHeight = Math.max(160, Math.min(natural, up ? above : below)) + 'px';
        }

        host.addEventListener('mouseenter', place);
        btn.addEventListener('focus', place);

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var open = !host.classList.contains('is-open');
            closeAll();
            if (open) {
                host.classList.add('is-open');
                btn.setAttribute('aria-expanded', 'true');
                place();
            }
        });
    }

    function closeAll() {
        document.querySelectorAll('.help.is-open').forEach(function (h) {
            h.classList.remove('is-open');
            var b = h.querySelector('.help-btn');
            if (b) b.setAttribute('aria-expanded', 'false');
        });
    }

    document.addEventListener('click', function (e) {
        if (!e.target.closest('.help')) closeAll();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeAll();
    });

    window.addEventListener('load', function () {
        document.querySelectorAll('.help[data-help]').forEach(build);
    });
})();
