@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 一键更新 RSS 订阅源到 GitHub

rem ===== 内置的仓库信息（可用参数覆盖：一键更新到GitHub.cmd 用户名 仓库名）=====
set GHUSER=%~1
set GHREPO=%~2
if "%GHUSER%"=="" set GHUSER=GoodGoodStudyDayDayUp12
if "%GHREPO%"=="" set GHREPO=manhuagui-rss
set REMOTEURL=https://github.com/%GHUSER%/%GHREPO%.git

echo ============================================================
echo   RSS 订阅源：生成 + 推送到 GitHub
echo   仓库： %REMOTEURL%
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 goto NONODE
where git >nul 2>nul
if errorlevel 1 goto NOGIT
if not exist ".git" goto SETUP
git remote get-url origin >nul 2>nul
if errorlevel 1 goto SETUP
goto UPDATE

:SETUP
echo [首次运行] 初始化本地仓库并绑定远程。
echo.
echo 1/3 生成订阅文件
call :GENFEEDS
echo.
echo 2/3 初始化本地仓库
git init -b main
git remote remove origin >nul 2>nul
git remote add origin %REMOTEURL%
git config --local user.name "%GHUSER%"
git config --local user.email "%GHUSER%@users.noreply.github.com"
git fetch origin main >nul 2>nul
if errorlevel 1 goto SETUPFRESH
git reset --mixed FETCH_HEAD
git add -A
git commit -m "chore: 更新订阅脚本与订阅源"
if errorlevel 1 goto COMMITFAIL
goto PUSH
:SETUPFRESH
git add -A
git commit -m "init: RSS 订阅源"
if errorlevel 1 goto COMMITFAIL
goto PUSH

:UPDATE
echo 1/3 生成订阅文件
call :GENFEEDS
echo.
git config --local user.email >nul 2>nul
if not errorlevel 1 goto UPDATEADD
git config --local user.name "%GHUSER%"
git config --local user.email "%GHUSER%@users.noreply.github.com"
:UPDATEADD
git add -A
git diff --cached --quiet
if not errorlevel 1 goto NOCHANGE
echo 2/3 提交改动
git commit -m "chore: 更新 RSS 订阅源"
if errorlevel 1 goto COMMITFAIL
goto PUSH

:PUSH
echo.
echo 3/3 推送到 GitHub
git push -u origin main
if errorlevel 1 goto PUSHFAIL
goto DONE

:GENFEEDS
node "%~dp0manhuagui-rss.mjs" --config feeds.json
if errorlevel 1 echo    [警告] 漫画源生成失败（站点可能限流），本次跳过
node "%~dp0govcn-rss.mjs" --out govcn-feed.xml --limit 100 --with-content --content-limit 20
if errorlevel 1 echo    [警告] 中国政府网源生成失败，本次跳过
goto :eof

:DONE
echo.
echo ============================================================
echo   [完成] 已生成并推送到 GitHub
echo ============================================================
echo.
echo 在 Folo / 阅读器里可以订阅：
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/govcn-feed.xml
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/manhuagui-all.xml
echo 仓库地址： https://github.com/%GHUSER%/%GHREPO%
goto END

:NOCHANGE
echo.
echo [无变化] 订阅内容与上次一致，无需提交。
echo 在 Folo / 阅读器里可以订阅：
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/govcn-feed.xml
echo   https://cdn.jsdelivr.net/gh/%GHUSER%/%GHREPO%@main/manhuagui-all.xml
goto END

:NONODE
echo [错误] 没有找到 node，请先安装 Node.js: https://nodejs.org/
goto END

:NOGIT
echo [错误] 没有找到 git，请先安装 Git for Windows: https://git-scm.com/download/win
goto END

:COMMITFAIL
echo.
echo [失败] 提交失败，请把上面的报错发给我。
goto END

:PUSHFAIL
echo.
echo ============================================================
echo   [失败] 推送没有成功
echo ============================================================
echo   当前仓库： %REMOTEURL%
echo   常见原因：
echo     1) 第一次推送需要登录 GitHub，浏览器弹窗没有完成（重新双击再试一次）
echo     2) 报错里提到 workflow scope：本次改动包含 .github/workflows/rss.yml，
echo        普通 Token 没有权限改它。处理办法二选一：
echo          a. 用带 workflow 权限的 Token
echo          b. 先在网页上把 .github/workflows/rss.yml 删掉，再双击本快捷方式
echo     3) 仓库名或用户名写错
echo     4) 网络问题（github.com 打不开）
echo.
echo   修好后重新双击桌面快捷方式即可。

:END
echo.
pause
