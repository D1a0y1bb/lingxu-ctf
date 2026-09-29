#!/usr/bin/env bash
# 把 dsh-lingxu-ctf 安装到 DSH desktop profile。
#
# 三种方式（任选其一）：
#   1) 让会话里的 agent 调用 plugin_manager 工具（推荐，无需手工敲命令）：
#        action=install_bundle  target=/Users/d1a0y1bb/Desktop/lingxu-ctf
#   2) 本脚本（走 dsh CLI；desktop profile 被 Electron 独占时需要应用私有 CLI）
#   3) 手工把包塞进 profile（最后手段，见文末）
#
# 安装后 **必须重启 DSH**：bundle 列表在启动时读取。

set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROFILE="${DSH_PROFILE:-desktop}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "源目录   : $SRC"
echo "profile  : $PROFILE"
echo "DSH_HOME : $DSH_HOME"
echo

if [ ! -f "$SRC/package.json" ]; then
  echo "✖ $SRC 下没有 package.json" >&2
  exit 1
fi

PKG_NAME=$(grep -m1 '"name"' "$SRC/package.json" | sed 's/.*: *"\(.*\)".*/\1/')
echo "包名     : $PKG_NAME"

# ── 方式 2：dsh CLI ──────────────────────────────────────────────────────
if command -v dsh >/dev/null 2>&1; then
  echo
  echo "▶ 使用 dsh CLI 安装…"
  dsh plugin --profile "$PROFILE" add "$SRC"
  echo "✔ 已安装。请重启 DSH 使 bundle 生效。"
  exit 0
fi

echo
echo "⚠ 未找到 dsh CLI（desktop profile 由 Electron 应用独占管理）。"
echo
echo "请改用会话里的 plugin_manager 工具："
echo "    action: install_bundle"
echo "    target: $SRC"
echo
echo "或在 DSH GUI 里：设置 → 插件 → 安装本地路径。"
echo
echo "── 手工兜底（仅在前两者都不可用时）────────────────────────────────"
echo "1) 把包复制/链接进 profile："
echo "     mkdir -p $DSH_HOME/profiles/$PROFILE/node_modules"
echo "     ln -sfn '$SRC' '$DSH_HOME/profiles/$PROFILE/node_modules/$PKG_NAME'"
echo "2) 在 $DSH_HOME/profiles/$PROFILE/package.json 里补两处："
echo "     \"dependencies\": { \"$PKG_NAME\": \"link:$SRC\" }"
echo "     \"dsh\": { \"profile\": { \"bundles\": [ ... , \"$PKG_NAME\" ] } }"
echo "3) 重启 DSH。"
exit 1
