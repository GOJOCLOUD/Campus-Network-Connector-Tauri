#!/bin/sh
# Windows 资源编译器替身 —— 只为让 `cargo check --target x86_64-pc-windows-msvc` 跑得起来。
#
# 背景:tauri-build 在 Windows 目标上会调 embed_resource 去编译 .rc(版本信息/图标/清单),
# 那一步要真的资源编译器(llvm-rc / RC.EXE)—— 那是**打包**用的东西,本机不装。
# 但 "cargo check" 只做类型检查、根本不链接,资源那步的结果毫无意义。
#
# 所以这里给个替身:embed_resource 用 `-V /?` 探测编译器类型
#   - 第一行含 "Resource Converter"  → 认定是 llvm-rc
#   - 输出里含 "no-preprocess"       → 跳过需要 Windows SDK 头文件的 C 预处理
# 被真正调用时,创建一个空的输出文件然后成功退出。
#
# 只影响**检查**这一步:云端 CI 有真的资源编译器,产物不受影响。
#
# 用法:
#   ./tools/windows-check.sh
#
# (这个 RC 路径**必须给绝对路径**:编译 .rc 那步跑在 cargo 依赖的构建脚本里,
#  工作目录在 ~/.cargo/registry 下,相对路径会解析到那里去 →
#  "Couldn't execute ../../tools/... No such file or directory"。
#  tools/windows-check.sh 已经把绝对路径算好了,直接用它。)
#
# 直接手动调用的话:
#   RC="$(pwd)/tools/windows-check-rc-stub.sh" \
#     cargo check --target x86_64-pc-windows-msvc
#
for a in "$@"; do
  case "$a" in
    -V|/?)
      echo "Resource Converter 1.0 (type-check stub)"
      echo "supports: no-preprocess"
      exit 0
      ;;
  esac
done
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "/fo" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && : > "$out"
exit 0
