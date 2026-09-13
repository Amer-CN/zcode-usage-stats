#!/bin/bash
# 验收脚本：一条命令跑完所有检查
cd "$(dirname "$0")/.."
node build/assemble.cjs >/dev/null 2>&1
pass=0; fail=0
chk() { if [ "$1" = "0" ]; then echo "  PASS $2"; pass=$((pass+1)); else echo "  FAIL $2"; fail=$((fail+1)); fi }

echo "=== 1. 语法 ==="
node --check lib/client.js >/dev/null 2>&1; chk $? "client.js 语法"
node --check lib/index.mjs >/dev/null 2>&1; chk $? "index.mjs 语法"

echo "=== 2. 部署一致性 ==="
diff -q build/client.new.js lib/client.js >/dev/null 2>&1; chk $? "工作区源 = 部署文件"

echo "=== 3. 几何断言（热力图三档 × 多宽度）==="
for m in daily weekly cumulative; do
  for w in 320 410 620; do
    W=$w HEAT_MODE=$m node tests/assert.cjs >/dev/null 2>&1
    chk $? "热力图 $m @ ${w}px"
  done
done

echo "=== 4. WCAG 对比度 ==="
node tests/contrast.cjs >/dev/null 2>&1; chk $? "明暗两套文字对比度"
node tests/preset-conformance.cjs >/dev/null 2>&1; chk $? "custom 多彩色板（对比度+可分辨度+INK_BOOST）"

echo "=== 5. 彩色断言 ==="
W=410 node tests/assert.cjs 2>&1 | grep -qE "折线全部带类目色" && W=410 node tests/assert.cjs 2>&1 | grep -qE "全部几何断言通过"
chk $? "类目色接入三图 + 全部几何断言"

echo
echo "总计: $pass 通过, $fail 失败"
[ $fail -eq 0 ] && echo "验收通过" || echo "验收失败"
exit $fail
