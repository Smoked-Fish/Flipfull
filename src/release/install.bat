@echo off
setlocal
cd /d "%~dp0"

set ADB=adb
where adb >nul 2>nul
if errorlevel 1 set ADB=platform-tools\adb.exe
if not "%ADB%"=="adb" if not exist "%ADB%" (
    echo adb not found: install Android's platform-tools, or put its folder next to this file
    goto fail
)
set STAGING=/data/local/tmp/flipfull-setup

echo Waiting for the phone: USB debugging on, this computer allowed...
"%ADB%" wait-for-device
"%ADB%" root >nul
"%ADB%" wait-for-device
set UID=
for /f %%i in ('"%ADB%" shell id -u') do set UID=%%i
if not "%UID%"=="0" (
    echo adb can't get root on this phone. Flipfull needs a rooted phone.
    goto fail
)

echo Copying Flipfull to the phone...
"%ADB%" shell rm -rf %STAGING%
"%ADB%" push flipfull %STAGING% >nul
if errorlevel 1 goto fail
"%ADB%" shell sh %STAGING%/flipfull setup --from %STAGING%
if errorlevel 1 goto fail
"%ADB%" shell rm -rf %STAGING%
echo.
echo Done. Open Flipfull on the phone, pick what you want, then reboot.
pause
exit /b 0

:fail
pause
exit /b 1
