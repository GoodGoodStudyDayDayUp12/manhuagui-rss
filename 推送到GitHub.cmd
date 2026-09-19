@echo off
chcp 936 >nul
cd /d "%~dp0"
title 把 RSS 仓库推送到 GitHub
echo ============================================================
echo   把本文件夹推送到你的 GitHub 仓库
echo   前提：已在网页上创建好仓库  https://github.com/new
echo ============================================================
echo.
set GHUSER=%~1
set GHREPO=%~2
if not "%GHUSER%"=="" if not "%GHREPO%"=="" goto RUN
echo 提示：也可以直接运行  推送到GitHub.cmd 用户名 仓库名
echo.
set /p GHUSER=请输入你的 GitHub 用户名: 
set /p GHREPO=请输入仓库名 例如 manhuagui-rss : 
:RUN
where git >nul 2>nul
if errorlevel 1 goto NOGIT
if "%GHUSER%"=="" goto EMPTY
if "%GHREPO%"=="" goto EMPTY
echo.
echo 提交身份： %GHUSER% ^<%GHUSER%@users.noreply.github.com^>
echo 目标仓库： https://github.com/%GHUSER%/%GHREPO%.git
echo.
git init
git add -A
git -c user.name="%GHUSER%" -c user.email="%GHUSER%@users.noreply.github.com" commit -m "init: 看漫画 RSS 订阅"
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%GHUSER%/%GHREPO%.git
echo.
echo 开始推送。第一次会弹出浏览器要求登录 GitHub，登录完成后会自动继续。
git push -u origin main
if errorlevel 1 goto PUSHFAIL
echo.
echo [完成] 已推送成功，打开 https://github.com/%GHUSER%/%GHREPO% 查看
goto END
:NOGIT
echo.
echo [错误] 没有找到 git，请先安装 Git for Windows: https://git-scm.com/download/win
goto END
:EMPTY
echo.
echo [错误] 用户名和仓库名都必须填写。
goto END
:PUSHFAIL
echo.
echo [失败] 推送失败。常见原因：仓库还没创建、用户名或仓库名写错、登录未完成。
echo        修好后可以直接重跑本脚本。
:END
echo.
pause
