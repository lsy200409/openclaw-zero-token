#!/bin/bash
# Zero-Token 服务管理脚本
# 管理 DeepSeek Web Gateway
# 用法: ./zt-server.sh [start|stop|restart|status|logs]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ECOSYSTEM="$SCRIPT_DIR/ecosystem.zt.config.cjs"
CONFIG_PATH="$SCRIPT_DIR/.openclaw-upstream-state/openclaw.json"
STATE_DIR="$SCRIPT_DIR/.openclaw-upstream-state"

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "mac" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *) echo "linux" ;;
  esac
}

OS=$(detect_os)
COLOR_RESET='\033[0m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_RED='\033[0;31m'
COLOR_CYAN='\033[0;36m'

info()  { echo -e "${COLOR_CYAN}[ZT]${COLOR_RESET} $1"; }
ok()    { echo -e "${COLOR_GREEN}[✓]${COLOR_RESET} $1"; }
warn()  { echo -e "${COLOR_YELLOW}[!]${COLOR_RESET} $1"; }
fail()  { echo -e "${COLOR_RED}[✗]${COLOR_RESET} $1"; }

start_all() {
  info "启动 Gateway 服务..."
  info "  Gateway   → :3002 (DeepSeek Web + Expert + Search)"

  rm -f "$STATE_DIR/agents/main/agent/models.json"

  pm2 start "$ECOSYSTEM" 2>&1
  if [ $? -eq 0 ]; then
    ok "PM2 启动完成"
  else
    fail "PM2 启动失败"
    exit 1
  fi

  info "等待服务就绪..."
  for i in $(seq 1 15); do
    sleep 2
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/ 2>/dev/null | grep -q 200; then
      ok "Gateway 就绪 (${i}s)"
      break
    fi
  done

  echo ""
  echo "  WebUI:       http://localhost:3002/"
  echo "  默认模型:    deepseek-web/deepseek-pro-search (V4 Pro Expert + Search)"
  echo ""
}

stop_all() {
  info "停止 Gateway 服务..."
  pm2 stop "$ECOSYSTEM" 2>&1
  ok "已停止"
}

restart_all() {
  info "重启 Gateway 服务..."
  rm -f "$STATE_DIR/agents/main/agent/models.json"
  pm2 restart "$ECOSYSTEM" 2>&1
  ok "已重启"
}

show_status() {
  echo ""
  info "=== PM2 进程状态 ==="
  pm2 list 2>&1 | grep -E "zt-|─"
  echo ""

  for port in 3002; do
    pid=$(lsof -ti:$port 2>/dev/null)
    if [ -n "$pid" ]; then
      name=$(ps -p $pid -o comm= 2>/dev/null || echo "?")
      ok "Port $port → PID $pid ($name)"
    else
      fail "Port $port ← 无监听"
    fi
  done
}

show_logs() {
  local app="${1:-zt-gateway}"
  pm2 logs "$app" --lines 30
}

case "${1:-status}" in
  start)    start_all ;;
  stop)     stop_all ;;
  restart)  restart_all ;;
  status)   show_status ;;
  logs)     show_logs "$2" ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs [app]}"
    echo ""
    echo "  start   启动 Gateway 服务"
    echo "  stop    停止 Gateway 服务"
    echo "  restart 重启 Gateway 服务"
    echo "  status  查看进程状态"
    echo "  logs    查看日志 (默认: zt-gateway)"
    echo ""
    exit 1
    ;;
esac