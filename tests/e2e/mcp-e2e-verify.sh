#!/bin/bash
# ============================================================================
# MCP 端到端验证脚本
# 验证链路：用户Token操作 → MCP服务启动 → 认证 → 初始化会话 → 获取工具列表
#
# 用法：
#   chmod +x tests/e2e/mcp-e2e-verify.sh
#   ./tests/e2e/mcp-e2e-verify.sh              # 全部协议
#   ./tests/e2e/mcp-e2e-verify.sh http          # 仅 HTTP
#   ./tests/e2e/mcp-e2e-verify.sh sse           # 仅 SSE
#   ./tests/e2e/mcp-e2e-verify.sh stdio         # 仅 stdio
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $PROJECT_ROOT/dist/index.js"

# ── 颜色 ──────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── 全局状态 ──────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
ERRORS=()
TEST_USER_ID=""
TEST_USER_TOKEN=""

# ── 辅助函数 ──────────────────────────────────────────────────────────────────
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); ERRORS+=("$1"); echo -e "  ${RED}✗ $1${NC}"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo -e "  ${YELLOW}⊘ $1${NC}"; }
info() { echo -e "  ${CYAN}→ $1${NC}"; }
header() { echo -e "\n${BOLD}[$1] $2${NC}"; echo "  ─────────────────────────────────────────"; }

cleanup() {
    # 停止后台服务器
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    # 可选：删除测试用户
    # if [ -n "$TEST_USER_ID" ]; then
    #     $CLI user delete "$TEST_USER_ID" 2>/dev/null || true
    # fi
}
trap cleanup EXIT

# ── Step 1: 系统初始化 & 登录 ────────────────────────────────────────────────
LOGIN_HELPER="$PROJECT_ROOT/tests/e2e/_login-helper.mjs"

ensure_logged_in() {
    local whoami_output
    whoami_output=$($CLI auth whoami 2>&1) || true
    if echo "$whoami_output" | grep -q "status.*VALID" && ! echo "$whoami_output" | grep -q "EXPIRED"; then
        return 0
    fi
    return 1
}

step_init() {
    header "Step 1" "系统初始化 & 登录"

    # 确保数据库已初始化
    $CLI init --username superadmin --password admin888 >/dev/null 2>&1 || true

    if ensure_logged_in; then
        pass "已登录（token 有效）"
    else
        info "Token 不存在或已过期，正在重置密码并登录..."
        # 使用辅助脚本：先重置密码再登录（绕过交互式输入）
        local login_output
        login_output=$(node "$LOGIN_HELPER" reset-and-login superadmin admin888 2>&1)
        if echo "$login_output" | grep -q "Logged in as"; then
            pass "$(echo "$login_output" | grep "Logged in as")"
        else
            fail "登录失败: $login_output"
            return 1
        fi
    fi
}

# ── Step 2: 创建测试用户 & 获取 Token ────────────────────────────────────────
step_user_token() {
    header "Step 2" "创建测试用户 & 获取 Token"

    # 尝试获取已有测试用户
    local existing
    existing=$($CLI user list 2>/dev/null | grep "mcp-e2e-verify" | awk '{print $1}' || true)

    if [ -n "$existing" ]; then
        TEST_USER_ID="$existing"
        info "使用已有用户: $TEST_USER_ID"
    else
        local output
        output=$($CLI user create \
            --name "MCP E2E Verify" \
            --username mcp-e2e-verify \
            --password verify123456 \
            --user-type user 2>&1) || {
            fail "创建用户失败: $output"
            return 1
        }
        TEST_USER_ID=$(echo "$output" | grep -o 'usr_[a-z0-9]*' | head -1)
        if [ -z "$TEST_USER_ID" ]; then
            fail "无法从输出提取用户ID: $output"
            return 1
        fi
        pass "用户已创建: $TEST_USER_ID"
    fi

    # 轮换 Token（确保拿到明文 token）
    local token_output
    token_output=$($CLI user rotate-token "$TEST_USER_ID" --ttl 30d 2>&1)
    TEST_USER_TOKEN=$(echo "$token_output" | grep -o 'sk-live-[a-z0-9_]*' | head -1)

    if [ -z "$TEST_USER_TOKEN" ]; then
        # fallback: 从 user get 中获取
        local get_output
        get_output=$($CLI user get "$TEST_USER_ID" 2>&1)
        TEST_USER_TOKEN=$(echo "$get_output" | grep -o 'sk-live-[a-z0-9_]*' | head -1)
    fi

    if [ -n "$TEST_USER_TOKEN" ]; then
        pass "Token 已获取: ${TEST_USER_TOKEN:0:20}..."
    else
        fail "无法获取用户 Token"
        info "rotate-token 输出: $token_output"
        return 1
    fi
}

# ── Step 3: 启动 MCP 服务 ────────────────────────────────────────────────────
step_start_server() {
    local transport="$1"
    local port="$2"

    header "Step 3" "启动 MCP 服务 ($transport, port $port)"

    # 清理残留
    pkill -f "serve.*--transport $transport.*--port $port" 2>/dev/null || true
    sleep 1

    $CLI serve \
        --transport "$transport" \
        --port "$port" \
        --host 127.0.0.1 \
        --mode standalone \
        --auth-token "$TEST_USER_TOKEN" \
        >/dev/null 2>&1 &
    SERVER_PID=$!

    # 等待服务器就绪
    local ready=false
    for i in $(seq 1 15); do
        if curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
            ready=true
            break
        fi
        sleep 1
    done

    if $ready; then
        pass "服务器已启动 (PID: $SERVER_PID)"
    else
        fail "服务器启动超时 (15s)"
        return 1
    fi
}

# ── Step 4: 健康检查 ─────────────────────────────────────────────────────────
step_health() {
    local port="$1"

    header "Step 4" "健康检查"

    local resp
    resp=$(curl -sf "http://127.0.0.1:$port/api/health" 2>&1)
    local code=$?

    if [ $code -eq 0 ] && echo "$resp" | grep -q '"status":"ok"'; then
        pass "健康检查通过"
        info "$resp"
    else
        fail "健康检查失败 (exit=$code): $resp"
        return 1
    fi
}

# MCP Streamable HTTP 需要特定 Accept 头
MCP_ACCEPT_HEADER="Accept: application/json, text/event-stream"

# ── Step 5: 未认证访问（Gateway API 预期 401）───────────────────────────────
step_unauth() {
    local port="$1"

    header "Step 5" "未认证访问 Gateway API (预期 401)"

    local resp http_code
    resp=$(curl -s -w "\n%{http_code}" "http://127.0.0.1:$port/api/gateway/skills" 2>&1)
    http_code=$(echo "$resp" | tail -1)

    if [ "$http_code" = "401" ]; then
        pass "未认证访问 Gateway API 返回 401"
    else
        fail "未认证访问 Gateway API 返回 $http_code（预期 401）"
    fi
}

# ── Step 6: 错误 Token（Gateway API 预期 401）───────────────────────────────
step_bad_token() {
    local port="$1"

    header "Step 6" "错误 Token 访问 Gateway API (预期 401)"

    local resp http_code
    resp=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer badtoken123" \
        "http://127.0.0.1:$port/api/gateway/skills" 2>&1)
    http_code=$(echo "$resp" | tail -1)

    if [ "$http_code" = "401" ]; then
        pass "错误 Token 返回 401"
    else
        fail "错误 Token 返回 $http_code（预期 401）"
    fi
}

# ── Step 7: MCP Initialize 握手 ─────────────────────────────────────────────
step_mcp_init() {
    local port="$1"
    local token="$2"

    header "Step 7" "MCP Initialize 握手"

    # 使用 -D 获取响应头
    local full_resp
    full_resp=$(curl -s -D /tmp/mcp-headers -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -d '{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "e2e-verify", "version": "1.0.0"}
            }
        }' 2>&1)

    # 提取 session id（从响应头）
    MCP_SESSION_ID=$(grep -i "mcp-session-id" /tmp/mcp-headers 2>/dev/null | awk '{print $2}' | tr -d '\r\n' || true)

    if [ -n "$MCP_SESSION_ID" ]; then
        pass "MCP 会话初始化成功"
        info "Session ID: $MCP_SESSION_ID"
    else
        fail "MCP 会话初始化失败"
        info "响应: $full_resp"
        return 1
    fi
}

# ── Step 8: 发送 initialized 通知 ───────────────────────────────────────────
step_mcp_initialized() {
    local port="$1"
    local token="$2"
    local session_id="$3"

    header "Step 8" "发送 initialized 通知"

    curl -s -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -H "mcp-session-id: $session_id" \
        -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}' >/dev/null 2>&1

    pass "initialized 通知已发送"
}

# ── Step 9: 获取工具列表 ─────────────────────────────────────────────────────
step_tools_list() {
    local port="$1"
    local token="$2"
    local session_id="$3"

    header "Step 9" "获取 MCP 工具列表 (tools/list)"

    local resp
    resp=$(curl -s -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -H "mcp-session-id: $session_id" \
        -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}' 2>&1)

    # 预期的 6 个工具
    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found_tools=()
    local missing_tools=()

    for tool in "${expected_tools[@]}"; do
        if echo "$resp" | grep -q "\"name\":\"$tool\""; then
            found_tools+=("$tool")
        else
            missing_tools+=("$tool")
        fi
    done

    if [ ${#missing_tools[@]} -eq 0 ]; then
        pass "工具列表获取成功，共 ${#found_tools[@]} 个工具"
        for t in "${found_tools[@]}"; do
            info "  ✓ $t"
        done
    else
        fail "工具列表不完整: 找到 ${#found_tools[@]}/${#expected_tools[@]}"
        for t in "${found_tools[@]}"; do
            info "  ✓ $t"
        done
        for t in "${missing_tools[@]}"; do
            info "  ✗ $t (缺失)"
        done
        info "原始响应: $resp"
    fi
}

# ── Step 10: 调用一个工具（skill_list）────────────────────────────────────────
step_tool_call() {
    local port="$1"
    local token="$2"
    local session_id="$3"

    header "Step 10" "调用 skill_list 工具"

    local resp
    resp=$(curl -s -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -H "mcp-session-id: $session_id" \
        -d '{
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "skill_list",
                "arguments": {}
            }
        }' 2>&1)

    if echo "$resp" | grep -q '"result"'; then
        pass "skill_list 调用成功"
        # 提取简要信息
        local content
        content=$(echo "$resp" | grep -o '"text":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$content" ]; then
            info "返回内容: ${content:0:100}..."
        fi
    elif echo "$resp" | grep -q '"error"'; then
        local err_msg
        err_msg=$(echo "$resp" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        fail "skill_list 调用失败: $err_msg"
    else
        fail "skill_list 调用异常: ${resp:0:200}"
    fi
}

# ============================================================================
# stdio 协议验证
# ============================================================================
run_stdio() {
    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  MCP 端到端验证 — stdio 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    step_init || return 1
    step_user_token || return 1

    header "Step 3" "stdio MCP 通信"

    # 构造 JSON-RPC 请求
    local init_req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stdio-e2e","version":"1.0.0"}}}'
    local init_notify='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local tools_req='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

    # stdio 模式：JSON-RPC 走 stdout，日志走 stderr
    # 使用临时文件捕获输出，避免管道超时问题
    local tmp_out
    tmp_out=$(mktemp)
    (
        echo "$init_req"
        sleep 0.5
        echo "$init_notify"
        sleep 0.2
        echo "$tools_req"
        sleep 1
        # 关闭 stdin 让服务器退出
        exec 0<&-
        sleep 0.5
    ) | SKILL_MCP_AUTH_TOKEN="$TEST_USER_TOKEN" \
        $CLI serve --transport stdio >"$tmp_out" 2>/dev/null &
    local bg_pid=$!

    # 等待进程完成或超时
    local wait_count=0
    while kill -0 "$bg_pid" 2>/dev/null && [ $wait_count -lt 15 ]; do
        sleep 1
        wait_count=$((wait_count + 1))
    done
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true

    local stdout_out
    stdout_out=$(cat "$tmp_out")
    rm -f "$tmp_out"

    # 检查工具列表
    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found=0
    local missing=()

    for tool in "${expected_tools[@]}"; do
        if echo "$stdout_out" | grep -q "\"name\":\"$tool\""; then
            found=$((found + 1))
        else
            missing+=("$tool")
        fi
    done

    if [ $found -eq 6 ]; then
        pass "stdio 工具列表完整 ($found/6)"
        for t in "${expected_tools[@]}"; do
            info "  ✓ $t"
        done
    elif [ $found -gt 0 ]; then
        fail "stdio 工具列表不完整 ($found/6), 缺少: ${missing[*]}"
    else
        fail "stdio 工具列表获取失败"
        info "stdout 输出（前500字符）: ${stdout_out:0:500}"
    fi

    # 验证 skill_list 调用结果
    if echo "$stdout_out" | grep -q '"result"'; then
        pass "stdio skill_list 调用成功"
    fi
}

# ============================================================================
# HTTP 协议验证
# ============================================================================
run_http() {
    local port=3460

    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  MCP 端到端验证 — HTTP 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    step_init || return 1
    step_user_token || return 1
    step_start_server http "$port" || return 1
    step_health "$port" || return 1
    step_unauth "$port"
    step_bad_token "$port"
    step_mcp_init "$port" "$TEST_USER_TOKEN" || return 1
    step_mcp_initialized "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID"
    step_tools_list "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID" || return 1
    step_tool_call "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID"
}

# ============================================================================
# SSE 协议验证
# ============================================================================
run_sse() {
    local port=3461

    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  MCP 端到端验证 — SSE 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    step_init || return 1
    step_user_token || return 1
    step_start_server sse "$port" || return 1
    step_health "$port" || return 1
    step_unauth "$port"
    step_bad_token "$port"

    header "Step 7" "SSE: 建立连接 & 获取 session endpoint"

    # SSE 协议：先连接 /mcp/sse 获取 endpoint，再发送请求到 endpoint
    local tmp_sse
    tmp_sse=$(mktemp)
    local sse_endpoint=""

    # 后台启动 SSE 连接
    curl -s -N \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        "http://127.0.0.1:$port/mcp/sse" > "$tmp_sse" 2>/dev/null &
    local sse_pid=$!

    # 等待 endpoint 事件出现
    local wait_count=0
    while [ $wait_count -lt 10 ]; do
        sleep 1
        wait_count=$((wait_count + 1))
        if [ -f "$tmp_sse" ] && grep -q "event: endpoint" "$tmp_sse" 2>/dev/null; then
            sse_endpoint=$(grep -A1 "event: endpoint" "$tmp_sse" | grep "^data:" | sed 's/^data: //' | tr -d '\r\n')
            break
        fi
    done

    if [ -n "$sse_endpoint" ]; then
        pass "SSE endpoint 获取成功: $sse_endpoint"
    else
        fail "SSE endpoint 获取失败"
        info "SSE 响应: $(cat "$tmp_sse" 2>/dev/null | head -10)"
        kill "$sse_pid" 2>/dev/null || true
        rm -f "$tmp_sse"
        return 1
    fi

    # 通过 SSE endpoint 发送初始化请求
    local full_url="http://127.0.0.1:$port${sse_endpoint}"
    header "Step 8" "SSE: MCP Initialize"

    curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "sse-e2e", "version": "1.0.0"}
            }
        }' >/dev/null 2>&1

    # 发送 initialized 通知
    curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}' >/dev/null 2>&1

    # 发送 tools/list 请求
    header "Step 9" "SSE: 获取工具列表"

    curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}' >/dev/null 2>&1

    # 等待 SSE 响应
    sleep 3

    # 从 SSE 流中读取响应
    local sse_content
    sse_content=$(cat "$tmp_sse" 2>/dev/null)

    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found=0
    local missing=()

    for tool in "${expected_tools[@]}"; do
        if echo "$sse_content" | grep -q "\"name\":\"$tool\""; then
            found=$((found + 1))
        else
            missing+=("$tool")
        fi
    done

    if [ $found -eq 6 ]; then
        pass "SSE 工具列表完整 ($found/6)"
        for t in "${expected_tools[@]}"; do
            info "  ✓ $t"
        done
    elif [ $found -gt 0 ]; then
        fail "SSE 工具列表不完整 ($found/6), 缺少: ${missing[*]}"
    else
        fail "SSE 工具列表获取失败"
        info "SSE 响应内容（前500字符）: ${sse_content:0:500}"
    fi

    # 清理
    kill "$sse_pid" 2>/dev/null; wait "$sse_pid" 2>/dev/null || true
    rm -f "$tmp_sse"
}

# ============================================================================
# 输出验证结论
# ============================================================================
print_conclusion() {
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}  验证结论${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""
    echo -e "  ${GREEN}通过: $PASS_COUNT${NC}"
    echo -e "  ${RED}失败: $FAIL_COUNT${NC}"
    echo -e "  ${YELLOW}跳过: $SKIP_COUNT${NC}"
    echo ""

    if [ $FAIL_COUNT -eq 0 ]; then
        echo -e "  ${GREEN}${BOLD}✓ 端到端验证全部通过${NC}"
    else
        echo -e "  ${RED}${BOLD}✗ 端到端验证存在失败项${NC}"
        echo ""
        echo "  错误列表："
        for err in "${ERRORS[@]}"; do
            echo -e "    ${RED}• $err${NC}"
        done
        echo ""
        echo "  排查建议："
        echo "    1. 确认服务已编译: npm run build"
        echo "    2. 确认已初始化: node dist/index.js init --username admin --password admin888"
        echo "    3. 确认端口未被占用: lsof -i :3460"
        echo "    4. 查看详细日志: node dist/index.js serve --transport http --port 3460 --host 127.0.0.1 --mode standalone"
    fi

    echo ""
    echo -e "${BOLD}========================================${NC}"
}

# ============================================================================
# 主入口
# ============================================================================
main() {
    local protocol="${1:-all}"

    echo -e "${BOLD}MCP 端到端验证${NC}"
    echo -e "时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo -e "版本: $($CLI --version 2>/dev/null || echo 'unknown')"
    echo -e "协议: $protocol"

    case "$protocol" in
        http)   run_http ;;
        sse)    run_sse ;;
        stdio)  run_stdio ;;
        all)
            run_http
            run_sse
            run_stdio
            ;;
        *)
            echo "用法: $0 [http|sse|stdio|all]"
            exit 1
            ;;
    esac

    print_conclusion

    [ $FAIL_COUNT -eq 0 ]
}

main "$@"
