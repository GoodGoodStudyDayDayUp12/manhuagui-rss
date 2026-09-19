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
if not errorlevel 1 goto GEN
git config --local user.name "%GHUSER%"
git config --local user.email "%GHUSER%@users.noreply.github.com"

:GEN
echo 1/3
node "%~dp0gen-a.mjs" --config config.json
if errorlevel 1 echo    [warn] a failed
node "%~dp0gen-c.mjs" --out feed-c.xml --limit 100 --with-content --content-limit 20 --guid-version 4 --self "https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/feed-c.xml"
if errorlevel 1 echo    [warn] c failed
node "%~dp0gen-d.mjs" --out feed-d.xml --limit 30 --self "https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/feed-d.xml"
if errorlevel 1 echo    [warn] d failed

echo 2/3
git fetch origin main >nul 2>nul
if errorlevel 1 goto COMMIT
git reset --soft FETCH_HEAD
:COMMIT
git add -A
git diff --cached --quiet
if not errorlevel 1 goto NOCHANGE
git commit -m "update"
if errorlevel 1 goto FAIL

echo 3/3
git push -u origin main
if errorlevel 1 goto FAIL
goto DONE

:DONE
echo.
echo done
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/feed-b.xml
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/feed-c.xml
goto END

:NOCHANGE
echo.
echo no change
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
