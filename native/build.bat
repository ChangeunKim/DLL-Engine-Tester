@echo off
REM Builds the native helpers into ..\bin (x64 only):
REM   fnp_tracker.dll  - allocation tracker (leak call stacks)
REM   fnp_sampler.exe  - out-of-process sampling profiler (hot spots)
REM   fnp_testdll.dll  - self-test DLL with known leaks / hot spots + PDB
REM Usage: native\build.bat        (run from anywhere; needs Visual Studio 2022 C++ tools)
setlocal
set "HERE=%~dp0"
set "OUT=%HERE%..\bin"
set "OBJ=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OBJ%" mkdir "%OBJ%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" ( echo vswhere not found - install Visual Studio 2022 with the C++ workload & exit /b 1 )
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT ( echo Visual Studio C++ x64 tools not found & exit /b 1 )
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

set "CF=/nologo /std:c++17 /O2 /Zi /EHsc /MD /W3 /DNDEBUG /D_CRT_SECURE_NO_WARNINGS /I"%HERE%common" /Fd"%OBJ%\\""
pushd "%OBJ%"

echo [1/3] fnp_tracker.dll
cl %CF% /LD "%HERE%tracker\fnp_tracker.cpp" /Fe"%OUT%\fnp_tracker.dll" /Fo"%OBJ%\tracker.obj" /link /DEBUG /OPT:REF /OPT:ICF /PDB:"%OUT%\fnp_tracker.pdb" dbghelp.lib || goto :fail

echo [2/3] fnp_sampler.exe
cl %CF% "%HERE%sampler\fnp_sampler.cpp" /Fe"%OUT%\fnp_sampler.exe" /Fo"%OBJ%\sampler.obj" /link /DEBUG /OPT:REF /OPT:ICF /PDB:"%OUT%\fnp_sampler.pdb" dbghelp.lib psapi.lib || goto :fail

echo [3/3] fnp_testdll.dll
cl %CF% /LD "%HERE%testdll\fnp_testdll.cpp" /Fe"%OUT%\fnp_testdll.dll" /Fo"%OBJ%\testdll.obj" /link /DEBUG /OPT:REF /OPT:ICF /PDB:"%OUT%\fnp_testdll.pdb" oleaut32.lib || goto :fail

popd
echo.
echo Done. Output in %OUT%
exit /b 0

:fail
popd
echo BUILD FAILED
exit /b 1
