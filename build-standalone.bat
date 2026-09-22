@echo off
setlocal
cd /d "%~dp0"
echo Building roc_desk-explorer (Release)...
cargo build --release --features custom-protocol -p roc_desk_explorer_standalone
if errorlevel 1 (
  echo BUILD FAILED: roc_desk-explorer
  exit /b 1
)
if not exist bin mkdir bin
copy /Y "target\release\roc_desk_explorer_standalone.exe" "bin\roc_desk-explorer.exe" >nul
if errorlevel 1 (
  echo COPY FAILED: roc_desk-explorer
  exit /b 1
)
echo BUILD OK: bin\roc_desk-explorer.exe
exit /b 0
