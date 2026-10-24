#!/bin/bash
# 安装 / 更新 macOS 版(Tauri)。
#
#   tools/install-macos-app.sh <包路径>
#     包路径可以是:
#       - 云端 release 的 zip(https://github.com/GOJOCLOUD/Campus-Network-Connector-Tauri/releases)
#       - 已经解压好的 .app
#
# ## 重新安装要重新授权,这是正常的
#
# macOS 的系统授权(辅助功能 / 自动化)是**按代码签名身份**记的,身份一变,
# 之前授过的权就作废。**重新安装 = 重新授权**,这属于正常代价 ——
# 本脚本**不**为了「让授权留着」搞任何额外机制(不挑固定证书、不追授权状态),
# 重新勾一次就是了。
#
# ## 签名只做一件事:让签名**有效**
#
# Tauri 的构建产物只有链接器的 ad-hoc 签名(没有 `_CodeSignature` 资源封印),
# `codesign --verify` 会报「code has no resources but signature indicates they
# must be present」—— 那是**无效签名**,Gatekeeper 会判成「应用已损坏」,
# 比「无法验证开发者」更难绕过。
# ⇒ 这里用 ad-hoc **整包**签一次,只为了让签名有效,跟授权能不能留住**无关**。
#
# 流程(每步都可回滚):
#   1. 解包(如果是 zip)并核对二进制哈希与源一致 —— 不信退出码
#   2. 退出正在运行的 App
#   3. 旧版本移入可恢复回收站(不做永久删除)
#   4. 新版本就位,用 ad-hoc 签整包并校验签名
#   5. 启动,读运行自检 diag.json,把真实状态打出来
#
# 环境变量:
#   APP_PATH        安装目标(默认 /Applications/模拟输入-Tauri.app)
set -euo pipefail

APP_PATH="${APP_PATH:-/Applications/模拟输入-Tauri.app}"
DIAG="$HOME/Library/Application Support/com.gojocloud.campus-network-connector.tauri/diag.json"
TRASH="/Users/wutiaoyun/.minimax/bin/mavis-trash"

die() { echo "✖ $*" >&2; exit 1; }
say() { echo "$*"; }

[ $# -ge 1 ] || die "用法: $0 <zip 或 .app 路径>"
SRC="$1"
[ -e "$SRC" ] || die "找不到: $SRC"

# ── 1. 解包 + 核对 ────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP_SRC="$SRC"
case "$SRC" in
  *.zip)
    say "[1] 解包 $SRC"
    ditto -x -k "$SRC" "$WORK"
    APP_SRC="$(find "$WORK" -maxdepth 2 -name '*.app' -type d | head -1)"
    [ -n "$APP_SRC" ] || die "包里没找到 .app"
    ;;
esac
[ -d "$APP_SRC" ] || die "不是 .app: $APP_SRC"

BIN_REL="Contents/MacOS/simuinput-tauri"
[ -f "$APP_SRC/$BIN_REL" ] || die "包结构不对: 缺 $BIN_REL"
SRC_SHA="$(shasum -a 256 "$APP_SRC/$BIN_REL" | awk '{print $1}')"
say "[1] 源二进制 sha256 = $SRC_SHA"

# ── 2. 退出 App + 旧版本移入回收站 ────────────────────────────────
say "[2] 退出正在运行的 App"
osascript -e 'tell application "模拟输入-Tauri" to quit' >/dev/null 2>&1 || true
pkill -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1 || true
sleep 1

if [ -e "$APP_PATH" ]; then
  say "[2] 旧版本移入可恢复回收站: $APP_PATH"
  if [ -x "$TRASH" ]; then
    "$TRASH" -- "$APP_PATH"
  else
    BAK="$APP_PATH.old.$(date +%s)"
    mv "$APP_PATH" "$BAK"
    say "    (没有 mavis-trash,已改名保留在 $BAK)"
  fi
fi

# ── 3. 就位 + 让签名有效 ──────────────────────────────────────────
say "[3] 安装到 $APP_PATH"
ditto "$APP_SRC" "$APP_PATH"

# 哈希核对必须在**签名前**做:codesign 会把签名写进二进制,签完哈希必然变,
# 拿签后的值去比源,是自找假警报。
INST_SHA="$(shasum -a 256 "$APP_PATH/$BIN_REL" | awk '{print $1}')"
[ "$INST_SHA" = "$SRC_SHA" ] || die "装完的二进制和源对不上: $INST_SHA != $SRC_SHA"
say "    装完二进制 sha256 与源一致: $INST_SHA"

say "[3] 用 ad-hoc 签整包(只为让签名有效:构建产物只有链接器的 ad-hoc 签名,没有资源封印,Gatekeeper 会判「已损坏」)"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
say "    签名校验通过"
codesign -dv "$APP_PATH" 2>&1 | grep -E "Identifier=|TeamIdentifier=" | sed 's/^/    /'
say "    (签名会改写二进制,签后哈希与源不同是正常的)"

# ── 4. 启动 + 读运行自检 ──────────────────────────────────────────
say "[4] 启动 App 并读运行自检"
open -a "$APP_PATH"
sleep 4
if [ -f "$DIAG" ]; then
  python3 - "$DIAG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
nat = d.get("native") or {}
sr = d.get("safariRepair") or {}
print("    辅助功能已授权:", nat.get("accessibilityTrusted"))
print("    Safari 修复:", {k: v for k, v in sr.items() if k != "poll"})
print("    窗口:", d.get("innerWidth"), "x", d.get("innerHeight"))
PY
  if ! python3 -c "
import json,sys
d=json.load(open('$DIAG',encoding='utf-8'))
sys.exit(0 if (d.get('native') or {}).get('accessibilityTrusted') else 1)"; then
    say ""
    say "⚠️  还差最后一步(只有你能做):系统设置 → 隐私与安全性 → 辅助功能 →"
    say "    勾选「模拟输入-Tauri」→ 把这个 App 完全退出再重开。"
    say "    **重新安装 = 重新授权,这是正常的** —— 以后每次换新包,重勾一次就行。"
  fi
else
  say "    没读到 diag.json(应用可能没起来)"
fi
say "完成。"
