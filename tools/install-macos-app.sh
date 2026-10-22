#!/bin/bash
# 安装 / 更新 macOS 版(Tauri),并保证「辅助功能」授权不会因重新打包而失效。
#
#   tools/install-macos-app.sh <包路径>
#     包路径可以是:
#       - 云端 release 的 zip(https://github.com/GOJOCLOUD/Campus-Network-Connector-Tauri/releases)
#       - 已经解压好的 .app
#
# 为什么要"重签"这一步:
#   云端 CI 出的包是 **ad-hoc 签名**(TeamIdentifier = not set)。macOS 的系统授权
#   (辅助功能 / 自动化)是**按代码签名身份**记的 —— ad-hoc 签名的身份跟着二进制
#   内容变,每出一个新包身份就变,**之前授过的权会直接失效**,要重新勾一次。
#   这里统一用钥匙串里那张**固定证书**重签,授权就能长期留着。
#
# 流程(每步都可回滚):
#   1. 解包(如果是 zip)并核对二进制哈希与源一致 —— 不信退出码
#   2. 退出正在运行的 App
#   3. 旧版本移入可恢复回收站(不做永久删除)
#   4. 新版本就位,用固定身份重签并校验签名
#   5. 启动,读运行自检 diag.json,把真实状态打出来
#
# 环境变量:
#   SIGN_IDENTITY   指定签名身份(默认自动找钥匙串里可用的代码签名身份)
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

# ── 2. 选签名身份 ─────────────────────────────────────────────────
if [ -z "${SIGN_IDENTITY:-}" ]; then
  # 优先用钥匙串里"有效的"代码签名身份;不要 Apple Development 这种会过期的临时身份,
  # 但本机目前只有这一张,先用它,总比 ad-hoc 强。
  # security find-identity 的行长这样:
  #   1) BE837299...168B65FD "Apple Development: 8618291894921 (FY2K6ZB64V)"
  # 名字在引号里,前面还带一段 hash,所以要取最后一对引号之间的内容。
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -E '^\s+[0-9]+\) [0-9A-F]{40} "' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
fi
[ -n "${SIGN_IDENTITY:-}" ] || die "钥匙串里没有可用的代码签名身份(设 SIGN_IDENTITY 指定)"
say "[2] 签名身份 = $SIGN_IDENTITY"

# ── 3. 退出 App + 旧版本移入回收站 ────────────────────────────────
say "[3] 退出正在运行的 App"
osascript -e 'tell application "模拟输入-Tauri" to quit' >/dev/null 2>&1 || true
pkill -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1 || true
sleep 1

if [ -e "$APP_PATH" ]; then
  say "[3] 旧版本移入可恢复回收站: $APP_PATH"
  if [ -x "$TRASH" ]; then
    "$TRASH" -- "$APP_PATH"
  else
    BAK="$APP_PATH.old.$(date +%s)"
    mv "$APP_PATH" "$BAK"
    say "    (没有 mavis-trash,已改名保留在 $BAK)"
  fi
fi

# ── 4. 就位 + 重签 ────────────────────────────────────────────────
say "[4] 安装到 $APP_PATH"
ditto "$APP_SRC" "$APP_PATH"

# 哈希核对必须在**签名前**做:codesign 会把签名写进二进制,签完哈希必然变,
# 拿签后的值去比源,是自找假警报。
INST_SHA="$(shasum -a 256 "$APP_PATH/$BIN_REL" | awk '{print $1}')"
[ "$INST_SHA" = "$SRC_SHA" ] || die "装完的二进制和源对不上: $INST_SHA != $SRC_SHA"
say "    装完二进制 sha256 与源一致: $INST_SHA"

say "[4] 用固定身份重签(这步是授权能长期留着的关键)"
codesign --force --deep --sign "$SIGN_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
say "    签名校验通过"
codesign -dv "$APP_PATH" 2>&1 | grep -E "Identifier=|TeamIdentifier=" | sed 's/^/    /'
say "    (签名会改写二进制,签后哈希与源不同是正常的)"

# ── 5. 启动 + 读运行自检 ──────────────────────────────────────────
say "[5] 启动 App 并读运行自检"
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
    say "    授权会一直留着 —— 因为签名身份是固定的,以后更新包不会掉。"
  fi
else
  say "    没读到 diag.json(应用可能没起来)"
fi
say "完成。"
