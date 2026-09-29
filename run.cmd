@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title run

set GHUSER=%~1
set GHREPO=%~2
if "%GHUSER%"=="" set GHUSER=GoodGoodStudyDayDayUp12
if "%GHREPO%"=="" set GHREPO=manhuagui-rss
set REMOTEURL=https://github.com/%GHUSER%/%GHREPO%.git
set CDN=https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main

where node >nul 2>nul
if errorlevel 1 goto NONODE
where git >nul 2>nul
if errorlevel 1 goto NOGIT
if not exist ".git" goto SETUP
git remote get-url origin >nul 2>nul
if errorlevel 1 goto SETUP
goto UPDATE

:SETUP
git init -b main >nul
git remote remove origin >nul 2>nul
git remote add origin %REMOTEURL%
git config --local user.name "%GHUSER%"
git config --local user.email "%GHUSER%@users.noreply.github.com"
goto GEN

:UPDATE
git config --local user.email >nul 2>nul
if not errorlevel 1 goto SYNC
git config --local user.name "%GHUSER%"
git config --local user.email "%GHUSER%@users.noreply.github.com"

:SYNC
echo 0/3 sync
git fetch origin main >nul 2>nul
if errorlevel 1 echo    [warn] fetch failed - 用本地文件继续
if errorlevel 1 goto GEN
git reset --hard FETCH_HEAD >nul
if errorlevel 1 echo    [warn] reset failed
goto GEN

:GEN
echo 1/3
set WARN=
node "%~dp0gen-a.mjs" --config config.json
if errorlevel 1 set WARN=%WARN% a
node "%~dp0gen-c.mjs" --out feed-c.xml --limit 100 --with-content --content-limit 20 --guid-version 4 --self "%CDN%/feed-c.xml"
if errorlevel 1 set WARN=%WARN% c
node "%~dp0gen-d.mjs" --out feed-d.xml --limit 30 --self "%CDN%/feed-d.xml"
if errorlevel 1 set WARN=%WARN% d
node "%~dp0gen-e.mjs" --out feed-e.xml --limit 50 --with-content --content-limit 20 --guid-version 2 --self "%CDN%/feed-e.xml"
if errorlevel 1 set WARN=%WARN% e
node "%~dp0gen-f.mjs" --out feed-f.xml --limit 30 --self "%CDN%/feed-f.xml"
if errorlevel 1 set WARN=%WARN% f
node "%~dp0gen-g.mjs" --out feed-g.xml --limit 100 --with-content --content-limit 20 --guid-version 1 --self "%CDN%/feed-g.xml"
if errorlevel 1 set WARN=%WARN% g
node "%~dp0gen-d.mjs" --mid 3493278460676126 --title "订阅源 H" --out feed-h.xml --limit 30 --self "%CDN%/feed-h.xml"
if errorlevel 1 set WARN=%WARN% h
node "%~dp0gen-i.mjs" --config config-i.json
if errorlevel 1 set WARN=%WARN% i

echo 2/3 check
node "%~dp0check.mjs"
if errorlevel 1 goto BADXML

git add -A
git diff --cached --quiet
if not errorlevel 1 goto NOCHANGE
git commit -m "update"
if errorlevel 1 goto FAIL

echo 3/3
git push -u origin main
if not errorlevel 1 goto DONE
git fetch origin main >nul 2>nul
if errorlevel 1 goto FAIL
git reset --soft FETCH_HEAD
git add -A
git commit -m "update" >nul 2>nul
git push -u origin main
if errorlevel 1 goto FAIL
goto DONE

:DONE
echo.
echo done
if not "%WARN%"=="" echo   本轮抓取失败/跳过：%WARN%
echo   %CDN%/feed-a.xml
echo   %CDN%/feed-b.xml
echo   %CDN%/feed-c.xml
echo   %CDN%/feed-d.xml
echo   %CDN%/feed-e.xml
echo   %CDN%/feed-f.xml
echo   %CDN%/feed-g.xml
echo   %CDN%/feed-h.xml
echo   %CDN%/feed-i.xml
echo   %CDN%/feed-j.xml
echo   %CDN%/feed-k.xml
echo   %CDN%/feed-l.xml
echo   %CDN%/feed-m.xml
goto END

:NOCHANGE
echo.
echo no change
if not "%WARN%"=="" echo   本轮抓取失败/跳过：%WARN%
goto END

:BADXML
echo.
echo check failed - 有 feed 文件不合法或条目变少，已跳过提交
echo   修正后重新双击即可
goto END

:NONODE
echo node not found
goto END

:NOGIT
echo git not found
goto END

:FAIL
echo.
echo failed: %REMOTEURL%
echo   1) 首次需要登录 GitHub（重试一次）
echo   2) 报错提到 workflow scope：需带该权限的 Token
echo   3) 仓库名或用户名写错

:END
echo.
pause