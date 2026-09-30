#!/usr/bin/env bash
# RE2CabbyCodes 简体中文汉化 - 一键生成（Linux / macOS / WSL / Git Bash）
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================"
echo " RE2CabbyCodes 简体中文汉化 - 一键生成"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
    echo "[x] 没有找到 Node.js。"
    echo "    请先安装 Node.js 18+：https://nodejs.org/"
    exit 1
fi

if [ ! -f steam_api64.dll ]; then
    echo "[x] 当前目录下没有找到 steam_api64.dll。"
    echo
    echo "    请先下载 RE2CabbyCodes 1.0.6 的原版压缩包，把它里面的 steam_api64.dll"
    echo "    复制到本目录（也就是和 patch.js 放在一起），然后重新运行本脚本。"
    exit 1
fi

echo "正在生成汉化版 DLL，请稍候……"
echo
node patch.js

echo
echo "============================================"
echo " 完成"
echo "============================================"
echo
echo "生成的汉化版 DLL："
echo "  $(pwd)/out/steam_api64.dll"
echo
echo "安装方法："
echo "  1. 先备份游戏目录里原来的 steam_api64.dll"
echo "  2. 把上面那个文件改名成 steam_api64.dll，覆盖进游戏目录"
echo "     （通常是 ...\\RESIDENT EVIL 2  BIOHAZARD RE2\\）"
echo "  3. 完全退出游戏再启动，进游戏后按 F7 呼出面板"
echo
