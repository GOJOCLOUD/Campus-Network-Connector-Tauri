#!/bin/sh
# Windows 代码体检 —— 一条命令。
#
#   ./tools/windows-check.sh
#
# 做的是 `cargo check --target x86_64-pc-windows-msvc`:只看类型对不对,不打包、
# 不链接、不需要真的资源编译器(那是打包才用的东西,本机不装)。
#
# 为什么要有这个脚本:Windows 目标的构建会调 embed_resource 去编译 .rc,
# 那步要 RC/llvm-rc。本机用 tools/windows-check-rc-stub.sh 当替身。
# **RC 的路径必须是绝对路径** —— 编译 .rc 那步跑在 cargo 依赖的构建脚本里,
# 工作目录在 ~/.cargo/registry 下,相对路径会解析到那里去,结果是
# "Couldn't execute ../../tools/windows-check-rc-stub.sh ... No such file"。
# 这个脚本把绝对路径算好,免得每次都踩。
set -e

here=$(cd "$(dirname "$0")" && pwd)
rc="$here/windows-check-rc-stub.sh"
if [ ! -x "$rc" ]; then
  echo "找不到 RC 替身: $rc" >&2
  exit 1
fi

cd "$here/../tauri-app/src-tauri"
RC="$rc" cargo check --target x86_64-pc-windows-msvc "$@"
