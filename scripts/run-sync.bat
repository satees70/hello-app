@echo off
REM Runs the attendance sync and appends output to sync.log (next to this file).
REM Point Windows Task Scheduler at THIS .bat, every 15 minutes.
REM %~dp0 = the folder this .bat lives in, so it works no matter where it's run.
node "%~dp0sync-attendance.mjs" >> "%~dp0sync.log" 2>&1
