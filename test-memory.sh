#!/bin/bash
# 三轮记忆测试脚本 - 验证会话持久性
# Session key 必须用 agent:<agentId>:<rest> 格式
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-placeholder-token}"
BASE="http://127.0.0.1:3002"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

test_platform() {
  local PLATFORM=$1
  local AGENT=$2
  local SESSION_KEY="agent:${AGENT}:main:memtest:${PLATFORM}:$(date +%s)"
  
  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN}  测试平台: ${PLATFORM} (agent=${AGENT})${NC}"
  echo -e "${CYAN}  Session: ${SESSION_KEY}${NC}"
  echo -e "${CYAN}========================================${NC}"
  
  send_msg() {
    local ROUND=$1
    local MSG=$2
    echo -e "${YELLOW}[轮次 ${ROUND}]${NC} 发送: ${MSG:0:80}..."
    
    local RESP=$(curl -s --max-time 120 -X POST "${BASE}/v1/chat/completions" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -H "x-openclaw-scopes: operator.read,operator.write" \
      -H "x-openclaw-session-key: ${SESSION_KEY}" \
      -H "x-openclaw-agent-id: ${AGENT}" \
      -d "{\"model\": \"openclaw\", \"stream\": false, \"messages\": [{\"role\": \"user\", \"content\": $(echo "$MSG" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")}]}" 2>&1)
    
    local CONTENT=$(echo "$RESP" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    content=d['choices'][0]['message']['content']
    print(content)
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    print(f'RAW: {sys.stdin.read()[:500] if hasattr(sys.stdin,\"read\") else \"\"}', file=sys.stderr)
" 2>&1)
    
    echo -e "${GREEN}[轮次 ${ROUND}]${NC} 回复: ${CONTENT:0:500}"
    echo "$CONTENT"
  }
  
  # 轮次1: 告诉模型信息
  echo ""
  R1=$(send_msg 1 "请记住以下信息：我的名字是小明，我最喜欢的颜色是蓝色，我的幸运数字是42。请回复确认你已记住这些信息。")
  sleep 6
  
  # 轮次2: 测试记忆 - 名字
  echo ""
  R2=$(send_msg 2 "我刚才告诉你我叫什么名字？只需回答名字即可。")
  sleep 4
  
  # 轮次3: 测试记忆 - 颜色  
  echo ""
  R3=$(send_msg 3 "那我刚才告诉你我最喜欢的颜色是什么？只需回答颜色即可。")
  
  # 检查结果
  echo ""
  echo -e "${CYAN}--- 记忆测试结果 ---${NC}"
  
  if echo "$R2" | grep -qi "小明"; then
    echo -e "${GREEN}[PASS]${NC} 轮次2 - 名字记忆: 正确"
  else
    echo -e "${RED}[FAIL]${NC} 轮次2 - 名字记忆失败, 回复: ${R2:0:200}"
  fi
  
  if echo "$R3" | grep -qEi "蓝|blue"; then
    echo -e "${GREEN}[PASS]${NC} 轮次3 - 颜色记忆: 正确"
  else
    echo -e "${RED}[FAIL]${NC} 轮次3 - 颜色记忆失败, 回复: ${R3:0:200}"
  fi
}

echo "开始三轮记忆测试..."
echo "时间: $(date)"
echo ""

test_platform "KIMI" "kimi-web"
sleep 5
test_platform "DOUBAO" "doubao-web"
sleep 5
test_platform "QWEN-INTL" "qwen-web"
sleep 5
test_platform "QWEN-CN" "qwen-cn-web"

echo ""
echo -e "${CYAN}所有测试完成${NC}"