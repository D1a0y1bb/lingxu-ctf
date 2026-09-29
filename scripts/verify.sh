#!/usr/bin/env bash
# 交付前自检：单元测试 + 真实平台冒烟 + 打包清单 + profile 安装状态。
#
# 用法：
#   bash scripts/verify.sh
#   LINGXU_COOKIE_FILE=/path/cookie bash scripts/verify.sh   # 额外跑真实平台冒烟

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE="${DSH_NODE:-}"
if [ -z "$NODE" ]; then
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
    "/Applications/DSH Desktop.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
    "$(command -v node 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "✖ 找不到 node，可用 DSH_NODE=/path/to/node 指定" >&2
  exit 1
fi

FAILED=0
step() { echo; echo "══ $1"; }
ok()   { echo "  ✔ $1"; }
bad()  { echo "  ✖ $1"; FAILED=1; }

step "1/5 语法检查"
for f in lib/*.js tests/*.mjs; do
  if "$NODE" --check "$f" >/dev/null 2>&1; then ok "$f"; else bad "$f 语法错误"; fi
done

step "2/5 单元测试"
if "$NODE" --test tests/*.test.mjs 2>&1 | tail -12; then ok "测试完成"; else bad "测试失败"; fi

step "3/5 真实平台冒烟（无凭据则跳过）"
if [ -n "${LINGXU_COOKIE_FILE:-}${LINGXU_COOKIE:-}" ]; then
  if "$NODE" tests/smoke-live.mjs; then ok "冒烟通过"; else bad "冒烟失败"; fi
else
  echo "  ⏭ 未设置 LINGXU_COOKIE_FILE / LINGXU_COOKIE，跳过"
fi

step "4/5 打包清单完整性"
for f in package.json cordis.patch.yml README.md docs/DESIGN.md docs/DSH-API-NOTES.md \
         lib/index.js lib/lingxu.js lib/platforms.js lib/store.js lib/toolkit.js \
         lib/tools.js lib/orchestrate.js lib/writeup.js lib/client.js; do
  if [ -f "$f" ]; then ok "$f"; else bad "缺少 $f"; fi
done

step "5/5 profile 安装状态"
PROFILE="${DSH_PROFILE:-desktop}"
MANIFEST="$HOME/.dsh/profiles/$PROFILE/package.json"
if [ -f "$MANIFEST" ]; then
  if grep -q "dsh-lingxu-ctf" "$MANIFEST"; then
    ok "已登记在 $PROFILE profile"
    grep -A12 '"bundles"' "$MANIFEST" | grep -q "dsh-lingxu-ctf" \
      && ok "已在 dsh.profile.bundles 中" \
      || bad "未加入 dsh.profile.bundles（不会加载）"
  else
    echo "  ⏭ 尚未安装到 $PROFILE profile"
  fi
else
  echo "  ⏭ 找不到 $MANIFEST"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✅ 自检通过"
else
  echo "❌ 自检发现问题（见上）"
fi
exit "$FAILED"
