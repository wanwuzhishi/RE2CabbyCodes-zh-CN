@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  RE2CabbyCodes 简体中文汉化 - 一键生成
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [x] 没有找到 Node.js。
    echo     请先到 https://nodejs.org/ 下载安装 LTS 版本，装完重开一个命令行窗口再运行本脚本。
    echo.
    pause
    exit /b 1
)

if not exist "steam_api64.dll" (
    echo [x] 当前目录下没有找到 steam_api64.dll。
    echo.
    echo     请先下载 RE2CabbyCodes 1.0.6 的原版压缩包，把它里面的 steam_api64.dll
    echo     复制到本目录（也就是和 patch.js 放在一起），然后重新运行本脚本。
    echo.
    pause
    exit /b 1
)

echo 正在生成汉化版 DLL，请稍候……
echo.
node patch.js
if errorlevel 1 (
    echo.
    echo [x] 生成失败。请把上面的报错信息复制到 GitHub Issues 里。
    pause
    exit /b 1
)

echo.
echo ============================================
echo  完成
echo ============================================
echo.
echo 生成的汉化版 DLL：
echo   %~dp0out\steam_api64.dll
echo.
echo 安装方法：
echo   1. 先备份游戏目录里原来的 steam_api64.dll
echo   2. 把上面那个文件改名成 steam_api64.dll，覆盖进游戏目录
echo      （通常是 ...\RESIDENT EVIL 2  BIOHAZARD RE2\）
echo   3. 完全退出游戏再启动，进游戏后按 F7 呼出面板
echo.
pause
