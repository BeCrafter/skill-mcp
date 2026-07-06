#!/bin/bash
# ============================================================================
# MCP 端到端验证脚本 — 完整版
#
# 覆盖范围（对照 docs/CLI_VERIFICATION_CHECKLIST.md）：
#   Phase 1 — 数据准备：init, auth whoami, user create, role create, rotate-token,
#             import, list, info, search, lint, versions, update
#   Phase 2 — MCP 协议：HTTP / SSE / stdio 三种传输，全部 6 个 MCP 工具调用，
#             Gateway API 认证后请求（skills/entry/files/file-tree）
#   Phase 3 — CLI 深度验证：eval, pipeline, migrate:check, manifest:migrate,
#             upgrade, sync check, role CRUD, assign-roles, 权限守卫,
#             remove, auth reset-password, user delete, auth logout
#
# 用法：
#   chmod +x tests/e2e/mcp-e2e-verify.sh
#   ./tests/e2e/mcp-e2e-verify.sh              # 全部协议 + CLI
#   ./tests/e2e/mcp-e2e-verify.sh http          # 仅 HTTP + CLI
#   ./tests/e2e/mcp-e2e-verify.sh sse           # 仅 SSE + CLI
#   ./tests/e2e/mcp-e2e-verify.sh stdio         # 仅 stdio + CLI
#   ./tests/e2e/mcp-e2e-verify.sh cli           # 仅 CLI 命令（不启动 MCP）
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $PROJECT_ROOT/dist/index.js"
LOGIN_HELPER="$PROJECT_ROOT/tests/e2e/_login-helper.mjs"
FIXTURES="$PROJECT_ROOT/tests/fixtures"

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
TEST_ROLE_ID=""
IMPORTED_SLUG="test-skill"
SERVER_PID=""

# ── 辅助函数 ──────────────────────────────────────────────────────────────────
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); ERRORS+=("$1"); echo -e "  ${RED}✗ $1${NC}"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo -e "  ${YELLOW}⊘ $1${NC}"; }
info() { echo -e "  ${CYAN}→ $1${NC}"; }
header() { echo -e "\n${BOLD}[$1] $2${NC}"; echo "  ─────────────────────────────────────────"; }

cleanup() {
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

stop_server() {
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
    fi
}

MCP_ACCEPT_HEADER="Accept: application/json, text/event-stream"

# ── 认证辅助 ──────────────────────────────────────────────────────────────────
ensure_logged_in() {
    local whoami_output
    whoami_output=$($CLI auth whoami 2>&1) || true
    if echo "$whoami_output" | grep -q "status.*VALID" && ! echo "$whoami_output" | grep -q "EXPIRED"; then
        return 0
    fi
    return 1
}

# ============================================================================
# Phase 1: 数据准备
# ============================================================================

step_init() {
    header "1.1" "系统初始化 & 登录"

    $CLI init --username superadmin --password admin888 >/dev/null 2>&1 || true

    if ensure_logged_in; then
        pass "已登录（token 有效）"
    else
        info "Token 不存在或已过期，正在重置密码并登录..."
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

step_auth_whoami() {
    header "1.2" "验证登录状态 (V-42)"
    local output
    output=$($CLI auth whoami 2>&1)
    if echo "$output" | grep -q "username.*superadmin"; then
        pass "auth whoami 显示 superadmin"
    else
        fail "auth whoami 异常: $output"
    fi
}

step_user_create() {
    header "1.3" "创建测试用户 (V-45)"

    local existing
    existing=$($CLI user list 2>/dev/null | grep "mcp-e2e-verify" | awk '{print $1}' || true)

    if [ -n "$existing" ]; then
        TEST_USER_ID="$existing"
        info "使用已有用户: $TEST_USER_ID"
        pass "测试用户已存在"
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
}

step_user_rotate_token() {
    header "1.4" "轮换 Token (V-49)"

    local token_output
    token_output=$($CLI user rotate-token "$TEST_USER_ID" --ttl 30d 2>&1)
    TEST_USER_TOKEN=$(echo "$token_output" | grep -o 'sk-live-[a-z0-9_]*' | head -1)

    if [ -z "$TEST_USER_TOKEN" ]; then
        local get_output
        get_output=$($CLI user get "$TEST_USER_ID" 2>&1)
        TEST_USER_TOKEN=$(echo "$get_output" | grep -o 'sk-live-[a-z0-9_]*' | head -1)
    fi

    if [ -n "$TEST_USER_TOKEN" ]; then
        pass "Token 已获取: ${TEST_USER_TOKEN:0:20}..."
    else
        fail "无法获取用户 Token"
        return 1
    fi
}

step_role_create() {
    header "1.5" "创建测试角色 (V-51)"

    local existing
    existing=$($CLI role list 2>/dev/null | grep "E2E Test Role" | awk '{print $1}' || true)
    if [ -n "$existing" ]; then
        TEST_ROLE_ID="$existing"
        info "使用已有角色: $TEST_ROLE_ID"
        pass "测试角色已存在"
        return 0
    fi

    local output
    output=$($CLI role create --name "E2E Test Role" --tags e2e,test --description "Role for E2E testing" 2>&1)
    TEST_ROLE_ID=$(echo "$output" | grep -o 'role_[a-z0-9]*' | head -1)
    if [ -n "$TEST_ROLE_ID" ]; then
        pass "角色已创建: $TEST_ROLE_ID"
    else
        fail "创建角色失败: $output"
        return 1
    fi
}

step_import_test_skill() {
    header "1.6" "导入测试技能包 (V-05)"

    local output
    output=$($CLI import "$FIXTURES/test-skill" --category e2e --tags e2e,verification --overwrite 2>&1)
    if echo "$output" | grep -q "Created\|Updated\|content unchanged"; then
        pass "test-skill 导入成功"
    else
        fail "导入失败: $output"
        return 1
    fi

    # Set visibility=public via DB so non-admin users can access via Gateway API
    sqlite3 "$HOME/.skill-mcp/skill-mcp.db" \
        "UPDATE skills SET visibility='public' WHERE slug='$IMPORTED_SLUG';" 2>/dev/null || true
}

step_cli_list() {
    header "1.7" "列出技能 (V-09)"

    local output
    output=$($CLI list 2>&1)
    if echo "$output" | grep -q "$IMPORTED_SLUG"; then
        pass "list 包含 test-skill"
    else
        fail "list 未找到 test-skill"
    fi
}

step_cli_info() {
    header "1.10" "查看技能详情 (V-12)"

    local output
    output=$($CLI info "$IMPORTED_SLUG" 2>&1)
    if echo "$output" | grep -q "Version\|version\|v[0-9]"; then
        pass "info 显示版本信息"
    else
        fail "info 输出异常: ${output:0:200}"
    fi
}

step_cli_info_notfound() {
    header "1.11" "info 不存在的 slug (E-03)"

    local output rc
    output=$($CLI info nonexistent-slug-zzz 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "info 不存在 slug 正确报错"
    else
        fail "info 不存在 slug 未报错: ${output:0:100}"
    fi
}

step_cli_list_tags() {
    header "1.8" "list --tags 过滤 (V-10)"
    local output
    output=$($CLI list --tags e2e 2>&1)
    if echo "$output" | grep -q "$IMPORTED_SLUG"; then
        pass "list --tags e2e 找到 test-skill"
    else
        fail "list --tags e2e 未找到 test-skill: ${output:0:100}"
    fi
}

step_cli_list_name() {
    header "1.9" "list --name 过滤 (V-11)"
    local output
    output=$($CLI list --name "$IMPORTED_SLUG" 2>&1)
    if echo "$output" | grep -q "$IMPORTED_SLUG"; then
        pass "list --name 找到 test-skill"
    else
        fail "list --name 未找到 test-skill: ${output:0:100}"
    fi
}

step_cli_search() {
    header "1.12" "搜索技能 (V-13)"

    local output
    output=$($CLI search --name test-skill 2>&1)
    if echo "$output" | grep -q "$IMPORTED_SLUG"; then
        pass "search 找到 test-skill"
    else
        fail "search 未找到 test-skill: ${output:0:100}"
    fi
}

step_cli_search_notfound() {
    header "1.13" "search 不存在的名称 (E-04)"
    local output
    output=$($CLI search --name zzznotexistzzz 2>&1)
    if echo "$output" | grep -q "No skills found"; then
        pass "search 不存在的名称正确提示无结果"
    else
        fail "search 异常: ${output:0:100}"
    fi
}

step_cli_lint_good() {
    header "1.21" "lint 合法技能包 (V-21)"

    local output rc
    output=$($CLI lint "$FIXTURES/test-skill" 2>&1) || rc=$?
    if echo "$output" | grep -q "PASS\|pass"; then
        pass "lint 合法技能包通过"
    else
        fail "lint 合法技能包失败: ${output:0:200}"
    fi
}

step_cli_lint_bad() {
    header "1.22" "lint 有缺陷技能包 (V-22)"

    local output rc
    output=$($CLI lint "$FIXTURES/bad-skill" 2>&1) || rc=$?
    if echo "$output" | grep -q "FAIL\|fail\|error\|Error"; then
        pass "lint 缺陷技能包正确检测到错误"
    else
        fail "lint 缺陷技能包未检测到错误: ${output:0:200}"
    fi
}

step_cli_versions() {
    header "1.14" "查看版本历史 (V-17)"

    local output
    output=$($CLI versions "$IMPORTED_SLUG" 2>&1)
    if echo "$output" | grep -q "Version history\|VERSION"; then
        pass "versions 显示版本历史"
    else
        fail "versions 输出异常: ${output:0:200}"
    fi
}

step_cli_versions_show() {
    header "1.15" "versions --show (V-18)"
    local output
    output=$($CLI versions "$IMPORTED_SLUG" --show 1.0.0 2>&1)
    if echo "$output" | grep -q "hash\|files\|storage\|created"; then
        pass "versions --show 显示版本详情"
    else
        fail "versions --show 异常: ${output:0:200}"
    fi
}

step_cli_versions_notfound() {
    header "1.16" "versions 不存在的 slug (E-06)"
    local output rc
    output=$($CLI versions nonexistent-slug-zzz 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "versions 不存在 slug 正确报错"
    else
        fail "versions 不存在 slug 未报错: ${output:0:100}"
    fi
}

step_cli_rollback() {
    header "1.26" "rollback --to (V-19)"
    local output
    output=$($CLI rollback "$IMPORTED_SLUG" --to 1.0.0 2>&1)
    if echo "$output" | grep -q "rollback complete\|Rolling back"; then
        pass "rollback 成功"
    else
        fail "rollback 失败: ${output:0:200}"
    fi
}

step_cli_import_duplicate() {
    header "1.24" "import 重复同名技能 (E-02)"
    local output rc
    output=$($CLI import "$FIXTURES/test-skill" --category test 2>&1) || rc=$?
    if echo "$output" | grep -q "Duplicate\|already exists"; then
        pass "import 重复技能正确拒绝"
    else
        fail "import 重复技能未拒绝: ${output:0:100}"
    fi
}

step_cli_lint_notfound() {
    header "1.23" "lint 不存在的路径 (E-08)"
    local output rc
    output=$($CLI lint /nonexistent/path 2>&1) || rc=$?
    if echo "$output" | grep -q "not found\|FAIL\|error\|Error"; then
        pass "lint 不存在路径正确报错"
    else
        fail "lint 不存在路径未报错: ${output:0:200}"
    fi
}

step_cli_remove_notfound() {
    header "1.25" "remove 不存在的 slug (E-07)"
    local output rc
    output=$($CLI remove nonexistent-slug-zzz --force 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "remove 不存在 slug 正确报错"
    else
        fail "remove 不存在 slug 未报错: ${output:0:100}"
    fi
}

step_cli_update() {
    header "1.17" "更新技能元数据 (V-14)"

    local output
    output=$($CLI update "$IMPORTED_SLUG" --category e2e-updated 2>&1)
    if echo "$output" | grep -q "Updated"; then
        pass "update --category 成功"
    else
        fail "update 失败: $output"
    fi
}

step_cli_update_tags() {
    header "1.18" "update --tags (V-15)"
    local output
    output=$($CLI update "$IMPORTED_SLUG" --tags newtag1,newtag2 2>&1)
    if echo "$output" | grep -q "Updated"; then
        pass "update --tags 成功"
    else
        fail "update --tags 失败: $output"
    fi
}

step_cli_update_description() {
    header "1.19" "update --description (V-16)"
    local output
    output=$($CLI update "$IMPORTED_SLUG" --description "Updated by E2E" 2>&1)
    if echo "$output" | grep -q "Updated"; then
        pass "update --description 成功"
    else
        fail "update --description 失败: $output"
    fi
}

step_cli_update_notfound() {
    header "1.20" "update 不存在的 slug (E-05)"
    local output rc
    output=$($CLI update nonexistent --category x 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "update 不存在 slug 正确报错"
    else
        fail "update 不存在 slug 未报错: ${output:0:100}"
    fi
}

# ============================================================================
# Phase 2: MCP 协议验证
# ============================================================================

# ── 通用：MCP 工具调用（可被所有传输协议复用） ──

mcp_tool_call_http() {
    local port="$1" token="$2" session_id="$3" tool="$4" args="$5"
    # $6 = optional forced url (for SSE which uses a different endpoint), $7 = optional override url
    local url="${7:-http://127.0.0.1:$port/mcp}"
    local session_header=""
    if [ -n "$session_id" ]; then
        session_header=(-H "mcp-session-id: $session_id")
    fi
    curl -s -X POST "$url" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        "${session_header[@]}" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" 2>&1
}

assert_tool_call() {
    local desc="$1" resp="$2"
    # 只接受 "result" — tools/list 已验证工具注册，这里验证工具真正执行成功
    # "error" 意味着参数错误/权限问题等，必须 fail
    if echo "$resp" | grep -q '"result"'; then
        pass "$desc"
    elif echo "$resp" | grep -q '"error"'; then
        local err_msg
        err_msg=$(echo "$resp" | grep -o '"message":"[^"]*"' | head -1 | sed 's/"message":"//;s/"//')
        fail "$desc — 返回 error: ${err_msg:-未知错误}"
    else
        fail "$desc — 响应异常: ${resp:0:200}"
    fi
}

# ── HTTP 协议 ──

step_start_server() {
    local transport="$1" port="$2"

    header "MCP" "启动 MCP 服务 ($transport, port $port)"

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

step_health() {
    local port="$1"
    header "MCP" "健康检查 (V-36)"
    local resp
    resp=$(curl -sf "http://127.0.0.1:$port/api/health" 2>&1)
    if [ $? -eq 0 ] && echo "$resp" | grep -q '"status":"ok"'; then
        pass "健康检查通过"
    else
        fail "健康检查失败: $resp"
        return 1
    fi
}

step_unauth() {
    local port="$1"
    header "MCP" "未认证访问 Gateway API (V-37 / P-02)"

    local resp http_code
    resp=$(curl -s -w "\n%{http_code}" "http://127.0.0.1:$port/api/gateway/skills" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "401" ]; then
        pass "未认证访问返回 401"
    else
        fail "未认证访问返回 $http_code（预期 401）"
    fi
}

step_bad_token() {
    local port="$1"
    header "MCP" "错误 Token 访问 Gateway API (V-38 / P-03)"

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

step_mcp_init() {
    local port="$1" token="$2"
    header "MCP" "MCP Initialize 握手"

    curl -s -D /tmp/mcp-headers -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-verify","version":"1.0.0"}}}' >/dev/null 2>&1

    MCP_SESSION_ID=$(grep -i "mcp-session-id" /tmp/mcp-headers 2>/dev/null | awk '{print $2}' | tr -d '\r\n' || true)

    if [ -n "$MCP_SESSION_ID" ]; then
        pass "MCP 会话初始化成功"
        info "Session ID: $MCP_SESSION_ID"
    else
        fail "MCP 会话初始化失败"
        return 1
    fi
}

step_mcp_initialized() {
    local port="$1" token="$2" session_id="$3"
    header "MCP" "发送 initialized 通知"

    curl -s -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -H "mcp-session-id: $session_id" \
        -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null 2>&1

    pass "initialized 通知已发送"
}

step_tools_list() {
    local port="$1" token="$2" session_id="$3"
    header "MCP" "获取 MCP 工具列表 (tools/list)"

    local resp
    resp=$(curl -s -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" \
        -H "$MCP_ACCEPT_HEADER" \
        -H "Authorization: Bearer $token" \
        -H "mcp-session-id: $session_id" \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' 2>&1)

    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found=0 missing=()

    for tool in "${expected_tools[@]}"; do
        if echo "$resp" | grep -q "\"name\":\"$tool\""; then
            found=$((found + 1))
        else
            missing+=("$tool")
        fi
    done

    if [ ${#missing[@]} -eq 0 ]; then
        pass "工具列表完整 ($found/${#expected_tools[@]})"
        for t in "${expected_tools[@]}"; do info "  ✓ $t"; done
    else
        fail "工具列表不完整: $found/${#expected_tools[@]}, 缺失: ${missing[*]}"
        info "原始响应: ${resp:0:500}"
    fi
}

step_mcp_tool_calls() {
    local port="$1" token="$2" session_id="$3"
    header "MCP" "调用全部 6 个 MCP 工具"

    local resp

    # 1. skill_list
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_list" '{}')
    assert_tool_call "tools/call skill_list" "$resp"
    if echo "$resp" | grep -q "$IMPORTED_SLUG"; then
        pass "  → skill_list 返回包含 test-skill"
    fi

    # 2. skill_search
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_search" '{"query":"test"}')
    assert_tool_call "tools/call skill_search" "$resp"

    # 3. skill_view
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_view" "{\"skill_slug\":\"$IMPORTED_SLUG\"}")
    assert_tool_call "tools/call skill_view" "$resp"
    if echo "$resp" | grep -q "$IMPORTED_SLUG"; then
        pass "  → skill_view 返回 skill 信息"
    fi

    # 4. skill_file
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_file" "{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}")
    assert_tool_call "tools/call skill_file" "$resp"

    # 5. skill_feedback
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_feedback" "{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"e2e verify\",\"agent_comment\":\"all good\"}")
    assert_tool_call "tools/call skill_feedback" "$resp"

    # 6. skill_pipeline
    resp=$(mcp_tool_call_http "$port" "$token" "$session_id" "skill_pipeline" '{"pipeline":"name: e2e-test\ninputs:\n  text:\n    type: string\n    required: true\nstages:\n  echo:\n    skill: test-skill\n    inputs:\n      text: ${{ inputs.text }}\n    outputs: [result]\noutput:\n  final: ${{ stages.echo.outputs.result }}"}')
    assert_tool_call "tools/call skill_pipeline" "$resp"
}

step_gateway_authed() {
    local port="$1" token="$2"
    header "MCP" "Gateway API 认证后访问 (V-40)"

    local resp http_code

    # GET /api/gateway/skills
    resp=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $token" \
        "http://127.0.0.1:$port/api/gateway/skills" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "200" ]; then
        pass "GET /api/gateway/skills → 200"
    else
        fail "GET /api/gateway/skills → $http_code（预期 200）"
    fi

    # GET /api/gateway/skills/:identifier
    resp=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $token" \
        "http://127.0.0.1:$port/api/gateway/skills/$IMPORTED_SLUG" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "200" ]; then
        pass "GET /api/gateway/skills/:slug → 200"
    else
        fail "GET /api/gateway/skills/:slug → $http_code（预期 200）"
    fi

    # GET /api/gateway/skills/:slug/entry
    resp=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $token" \
        "http://127.0.0.1:$port/api/gateway/skills/$IMPORTED_SLUG/entry" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "200" ]; then
        pass "GET /api/gateway/skills/:slug/entry → 200"
    else
        fail "GET /api/gateway/skills/:slug/entry → $http_code（预期 200）"
    fi

    # POST /api/gateway/skills/:slug/files
    resp=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d '{"paths":["SKILL.md"]}' \
        "http://127.0.0.1:$port/api/gateway/skills/$IMPORTED_SLUG/files" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "200" ]; then
        pass "POST /api/gateway/skills/:slug/files → 200"
    else
        fail "POST /api/gateway/skills/:slug/files → $http_code（预期 200）"
    fi

    # GET /api/gateway/skills/:slug/file-tree
    resp=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $token" \
        "http://127.0.0.1:$port/api/gateway/skills/$IMPORTED_SLUG/file-tree" 2>&1)
    http_code=$(echo "$resp" | tail -1)
    if [ "$http_code" = "200" ]; then
        pass "GET /api/gateway/skills/:slug/file-tree → 200"
    else
        fail "GET /api/gateway/skills/:slug/file-tree → $http_code（预期 200）"
    fi
}

run_http_mcp() {
    local port=3460

    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  Phase 2: MCP 端到端验证 — HTTP 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    step_start_server http "$port" || return 1
    step_health "$port" || return 1
    step_unauth "$port"
    step_bad_token "$port"
    step_mcp_init "$port" "$TEST_USER_TOKEN" || return 1
    step_mcp_initialized "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID"
    step_tools_list "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID" || return 1
    step_mcp_tool_calls "$port" "$TEST_USER_TOKEN" "$MCP_SESSION_ID"
    step_gateway_authed "$port" "$TEST_USER_TOKEN"
    stop_server
}

# ── SSE 协议 ──

run_sse_mcp() {
    local port=3461

    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  MCP 端到端验证 — SSE 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    step_start_server sse "$port" || return 1
    step_health "$port" || return 1
    step_unauth "$port"
    step_bad_token "$port"

    header "MCP-SSE" "SSE: 建立连接 & 获取 session endpoint"

    local tmp_sse sse_endpoint
    tmp_sse=$(mktemp)

    curl -s -N \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        "http://127.0.0.1:$port/mcp/sse" > "$tmp_sse" 2>/dev/null &
    local sse_pid=$!

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
        info "SSE 响应: $(head -10 "$tmp_sse" 2>/dev/null)"
        kill "$sse_pid" 2>/dev/null || true; rm -f "$tmp_sse"
        stop_server
        return 1
    fi

    local full_url="http://127.0.0.1:$port${sse_endpoint}"

    header "MCP-SSE" "SSE: MCP Initialize"
    local init_resp
    init_resp=$(curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sse-e2e","version":"1.0.0"}}}' 2>&1)

    if echo "$init_resp" | grep -q '"result"'; then
        pass "SSE initialize 成功"
    else
        fail "SSE initialize 失败: ${init_resp:0:200}"
    fi

    curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null 2>&1

    header "MCP-SSE" "SSE: 获取工具列表"
    curl -s -X POST "$full_url" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' >/dev/null 2>&1

    sleep 3
    local sse_content
    sse_content=$(cat "$tmp_sse" 2>/dev/null)

    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found=0 missing=()
    for tool in "${expected_tools[@]}"; do
        if echo "$sse_content" | grep -q "\"name\":\"$tool\""; then
            found=$((found + 1))
        else
            missing+=("$tool")
        fi
    done

    if [ $found -eq 6 ]; then
        pass "SSE 工具列表完整 ($found/6)"
        for t in "${expected_tools[@]}"; do info "  ✓ $t"; done
    elif [ $found -gt 0 ]; then
        fail "SSE 工具列表不完整 ($found/6), 缺少: ${missing[*]}"
    else
        fail "SSE 工具列表获取失败"
        info "SSE 响应（前500字符）: ${sse_content:0:500}"
    fi

    # SSE tools/call — 逐个调用全部 6 个 MCP 工具
    header "MCP-SSE" "SSE: 调用全部 6 个 MCP 工具"
    local resp

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_list" '{}' "" "$full_url")
    assert_tool_call "SSE tools/call skill_list" "$resp"

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_search" '{"query":"test"}' "" "$full_url")
    assert_tool_call "SSE tools/call skill_search" "$resp"

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_view" "{\"skill_slug\":\"$IMPORTED_SLUG\"}" "" "$full_url")
    assert_tool_call "SSE tools/call skill_view" "$resp"
    if echo "$resp" | grep -q "$IMPORTED_SLUG"; then
        pass "  → SSE skill_view 返回 skill 信息"
    fi

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_file" "{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}" "" "$full_url")
    assert_tool_call "SSE tools/call skill_file" "$resp"

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_feedback" "{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"e2e verify\",\"agent_comment\":\"all good\"}" "" "$full_url")
    assert_tool_call "SSE tools/call skill_feedback" "$resp"

    resp=$(mcp_tool_call_http "$port" "$TEST_USER_TOKEN" "" "skill_pipeline" "{\"pipeline\":\"name: e2e-test\ninputs:\n  text:\n    type: string\n    required: true\nstages:\n  echo:\n    skill: test-skill\n    inputs:\n      text: \${{ inputs.text }}\n    outputs: [result]\noutput:\n  final: \${{ stages.echo.outputs.result }}\"}" "" "$full_url")
    assert_tool_call "SSE tools/call skill_pipeline" "$resp"

    kill "$sse_pid" 2>/dev/null; wait "$sse_pid" 2>/dev/null || true
    rm -f "$tmp_sse"
    stop_server
}

# ── stdio 协议 ──

run_stdio_mcp() {
    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  MCP 端到端验证 — stdio 协议${NC}"
    echo -e "${BOLD}========================================${NC}"

    header "MCP-STDIO" "stdio MCP 通信"

    local init_req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stdio-e2e","version":"1.0.0"}}}'
    local init_notify='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local tools_req='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    local call_skill_list='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skill_list","arguments":{}}}'
    local call_skill_view="{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_view\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\"}}}"
    local call_skill_search='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"skill_search","arguments":{"query":"test"}}}'
    local call_skill_file="{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_file\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}}}"
    local call_skill_feedback="{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_feedback\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"e2e verify\",\"agent_comment\":\"all good\"}}}"
    local call_skill_pipeline="{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_pipeline\",\"arguments\":{\"pipeline\":\"name: e2e-test\ninputs:\n  text:\n    type: string\n    required: true\nstages:\n  echo:\n    skill: test-skill\n    inputs:\n      text: \${{ inputs.text }}\n    outputs: [result]\noutput:\n  final: \${{ stages.echo.outputs.result }}\"}}}"

    local tmp_out
    tmp_out=$(mktemp)
    (
        echo "$init_req"
        sleep 0.5
        echo "$init_notify"
        sleep 0.2
        echo "$tools_req"
        sleep 0.5
        echo "$call_skill_list"
        sleep 0.5
        echo "$call_skill_view"
        sleep 0.5
        echo "$call_skill_search"
        sleep 0.5
        echo "$call_skill_file"
        sleep 0.5
        echo "$call_skill_feedback"
        sleep 0.5
        echo "$call_skill_pipeline"
        sleep 0.5
        exec 0<&-
        sleep 0.5
    ) | SKILL_MCP_AUTH_TOKEN="$TEST_USER_TOKEN" \
        $CLI serve --transport stdio >"$tmp_out" 2>/dev/null &
    local bg_pid=$!

    local wait_count=0
    while kill -0 "$bg_pid" 2>/dev/null && [ $wait_count -lt 20 ]; do
        sleep 1
        wait_count=$((wait_count + 1))
    done
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true

    local stdout_out
    stdout_out=$(cat "$tmp_out")
    rm -f "$tmp_out"

    # 工具列表完整性
    local expected_tools=("skill_list" "skill_search" "skill_view" "skill_file" "skill_feedback" "skill_pipeline")
    local found=0 missing=()
    for tool in "${expected_tools[@]}"; do
        if echo "$stdout_out" | grep -q "\"name\":\"$tool\""; then
            found=$((found + 1))
        else
            missing+=("$tool")
        fi
    done

    if [ $found -eq 6 ]; then
        pass "stdio 工具列表完整 ($found/6)"
        for t in "${expected_tools[@]}"; do info "  ✓ $t"; done
    elif [ $found -gt 0 ]; then
        fail "stdio 工具列表不完整 ($found/6), 缺少: ${missing[*]}"
    else
        fail "stdio 工具列表获取失败"
        info "stdout 输出（前500字符）: ${stdout_out:0:500}"
    fi

    # skill_list 调用
    if echo "$stdout_out" | grep -q '"id":3.*"result"'; then
        pass "stdio tools/call skill_list 成功"
    else
        fail "stdio tools/call skill_list 失败"
    fi

    # skill_view 调用
    if echo "$stdout_out" | grep -q "$IMPORTED_SLUG"; then
        pass "stdio tools/call skill_view 返回 skill 数据"
    else
        fail "stdio tools/call skill_view 失败"
    fi

    # skill_search 调用
    if echo "$stdout_out" | grep -cq '"id":5'; then
        pass "stdio tools/call skill_search 收到响应"
    else
        fail "stdio tools/call skill_search 失败"
    fi

    # skill_file 调用
    if echo "$stdout_out" | grep -cq '"id":6'; then
        pass "stdio tools/call skill_file 收到响应"
    else
        fail "stdio tools/call skill_file 失败"
    fi

    # skill_feedback 调用
    if echo "$stdout_out" | grep -cq '"id":7'; then
        pass "stdio tools/call skill_feedback 收到响应"
    else
        fail "stdio tools/call skill_feedback 失败"
    fi

    # skill_pipeline 调用
    if echo "$stdout_out" | grep -cq '"id":8'; then
        pass "stdio tools/call skill_pipeline 收到响应"
    else
        fail "stdio tools/call skill_pipeline 失败"
    fi
}

# ============================================================================
# Phase 3: CLI 深度验证 + 清理
# ============================================================================

step_eval_list() {
    header "3.1" "eval list (V-23)"
    local output
    output=$($CLI eval list "$IMPORTED_SLUG" 2>&1)
    if echo "$output" | grep -q "Eval cases\|No eval cases"; then
        pass "eval list 正常"
    else
        fail "eval list 异常: ${output:0:200}"
    fi
}

step_eval_run() {
    header "3.2" "eval run (V-24)"
    local output rc
    output=$($CLI eval run "$IMPORTED_SLUG" 2>&1) || rc=$?
    # eval run 在没有 cases 时也会正常输出
    if echo "$output" | grep -q "Eval run\|No eval cases"; then
        pass "eval run 正常"
    else
        fail "eval run 异常: ${output:0:200}"
    fi
}

step_eval_results() {
    header "3.3" "eval results (V-25)"
    local output
    output=$($CLI eval results "$IMPORTED_SLUG" 2>&1)
    if echo "$output" | grep -q "Eval results\|No eval runs"; then
        pass "eval results 正常"
    else
        fail "eval results 异常: ${output:0:200}"
    fi
}

step_pipeline_validate_good() {
    header "3.4" "pipeline validate 合法 YAML (V-26)"
    local output rc
    output=$($CLI pipeline validate "$FIXTURES/test-pipeline.yaml" 2>&1) || rc=$?
    if echo "$output" | grep -q "stages\|batches"; then
        pass "pipeline validate 合法 YAML 通过"
    else
        fail "pipeline validate 异常: ${output:0:200}"
    fi
}

step_pipeline_validate_bad() {
    header "3.5" "pipeline validate 循环依赖 (E-09)"
    local output rc
    output=$($CLI pipeline validate "$FIXTURES/bad-pipeline.yaml" 2>&1) || rc=$?
    if echo "$output" | grep -q "Validation failed\|Failed\|Failed to parse\|outputs"; then
        pass "pipeline validate 正确检测到错误"
    else
        fail "pipeline validate 未检测到错误: ${output:0:200}"
    fi
}

step_pipeline_graph() {
    header "3.6" "pipeline graph (V-27)"
    local output
    output=$($CLI pipeline graph "$FIXTURES/test-pipeline.yaml" 2>&1)
    if echo "$output" | grep -q "Batch\|→\|←\|read-pr"; then
        pass "pipeline graph 输出依赖图"
    else
        fail "pipeline graph 异常: ${output:0:200}"
    fi
}

step_pipeline_run() {
    header "3.7" "pipeline run --dry-run (V-28)"
    local output
    output=$($CLI pipeline run "$FIXTURES/test-pipeline.yaml" \
        --input "pr_url=https://github.com/test/pr" --dry-run 2>&1)
    if echo "$output" | grep -q "Dry run\|skipped"; then
        pass "pipeline run --dry-run 正常"
    else
        fail "pipeline run --dry-run 异常: ${output:0:200}"
    fi
}

step_migrate_check() {
    header "3.8" "migrate:check (V-29)"
    local output
    output=$($CLI migrate:check 2>&1)
    if echo "$output" | grep -q "CHECK\|migration\|sqlite"; then
        pass "migrate:check 正常"
    else
        fail "migrate:check 异常: ${output:0:200}"
    fi
}

step_manifest_migrate() {
    header "3.9" "manifest:migrate dry-run (V-30)"
    local output
    output=$($CLI manifest:migrate "$FIXTURES/test-skill" 2>&1)
    # dry-run：提示需要迁移或已是最新
    if echo "$output" | grep -q "package\|migrat\|already\|manifest_schema"; then
        pass "manifest:migrate dry-run 正常"
    else
        fail "manifest:migrate 异常: ${output:0:200}"
    fi
}

step_manifest_migrate_patch() {
    header "3.10" "manifest:migrate --patch (V-31)"
    local output
    output=$($CLI manifest:migrate "$FIXTURES/test-skill" --patch 2>&1)
    if echo "$output" | grep -q "@@\|+++\|---\|diff\|patch"; then
        pass "manifest:migrate --patch 输出 diff"
    else
        # 如果已经是最新格式，patch 可能输出空 diff
        if echo "$output" | grep -q "already\|up to date\|Already\|No packages"; then
            pass "manifest:migrate --patch (已是最新)"
        else
            fail "manifest:migrate --patch 异常: ${output:0:200}"
        fi
    fi
}

step_manifest_migrate_apply() {
    header "3.11" "manifest:migrate --apply (V-32)"
    local output
    output=$($CLI manifest:migrate "$FIXTURES/test-skill" --apply 2>&1)
    if echo "$output" | grep -q "Migrated\|migrat\|already\|up to date\|Already"; then
        pass "manifest:migrate --apply 正常"
    else
        fail "manifest:migrate --apply 异常: ${output:0:200}"
    fi
}

step_upgrade() {
    header "3.10" "upgrade 检查更新 (V-33)"
    local output rc
    output=$($CLI upgrade 2>&1) || rc=$?
    if echo "$output" | grep -q "current\|latest\|Checking\|Already"; then
        pass "upgrade 正常"
    else
        # npm registry 不可达也算正常（跳过）
        skip "upgrade 检查（可能无网络）"
    fi
}

step_sync_check() {
    header "3.11" "sync check 本地技能 (E-12)"
    local output rc
    output=$($CLI sync check "$IMPORTED_SLUG" 2>&1) || rc=$?
    if echo "$output" | grep -q "no import source\|no remote\|was imported locally"; then
        pass "sync check 正确提示本地技能无远程源"
    else
        fail "sync check 异常: ${output:0:200}"
    fi
}

step_role_list() {
    header "3.12" "role list (V-50)"
    local output
    output=$($CLI role list 2>&1)
    if echo "$output" | grep -q "Roles\|NAME" && echo "$output" | grep -q "superadmin"; then
        pass "role list 显示角色列表"
    else
        fail "role list 异常: ${output:0:200}"
    fi
}

step_role_get() {
    header "3.13" "role get (V-52)"
    local output
    output=$($CLI role get "$TEST_ROLE_ID" 2>&1)
    if echo "$output" | grep -q "E2E Test Role"; then
        pass "role get 显示角色详情"
    else
        fail "role get 异常: ${output:0:200}"
    fi
}

step_role_get_notfound() {
    header "3.14" "role get 不存在的 ID (E-18)"
    local output rc
    output=$($CLI role get nonexistent-role-id 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "role get 不存在 ID 正确报错"
    else
        fail "role get 不存在 ID 未报错: ${output:0:100}"
    fi
}

step_role_update() {
    header "3.15" "role update (V-53)"
    local output
    output=$($CLI role update "$TEST_ROLE_ID" --name "E2E Test Role Updated" --tags e2e,test,updated 2>&1)
    if echo "$output" | grep -q "updated\|Updated"; then
        pass "role update 成功"
    else
        fail "role update 失败: ${output:0:200}"
    fi
}

step_user_assign_roles() {
    header "3.16" "user assign-roles (V-48)"
    local output
    output=$($CLI user assign-roles "$TEST_USER_ID" --role-ids "$TEST_ROLE_ID" 2>&1)
    if echo "$output" | grep -q "updated\|Updated\|Roles updated"; then
        pass "user assign-roles 成功"
    else
        fail "user assign-roles 失败: ${output:0:200}"
    fi
}

step_role_delete() {
    header "3.17" "role delete (V-54)"
    local output
    output=$($CLI role delete "$TEST_ROLE_ID" 2>&1)
    if echo "$output" | grep -q "Deleted\|deleted"; then
        pass "role delete 成功"
    else
        fail "role delete 失败: ${output:0:200}"
    fi
}

step_role_delete_builtin_protect() {
    header "3.18" "内置角色删除保护 (E-19 / P-05)"

    # 找到 superadmin 角色 ID
    local superadmin_role_id
    superadmin_role_id=$($CLI role list 2>/dev/null | grep superadmin | awk '{print $1}' | head -1)

    if [ -z "$superadmin_role_id" ]; then
        skip "找不到 superadmin 角色"
        return
    fi

    local output rc
    output=$($CLI role delete "$superadmin_role_id" 2>&1) || rc=$?
    if echo "$output" | grep -q "Cannot delete built-in\|built-in"; then
        pass "内置角色删除保护生效"
    else
        fail "内置角色删除保护未生效: ${output:0:200}"
    fi
}

step_remove_skill() {
    header "3.19" "remove 技能 (V-20)"
    local output
    output=$($CLI remove "$IMPORTED_SLUG" --force 2>&1)
    if echo "$output" | grep -q "removed\|Removed"; then
        pass "remove --force 成功"
    else
        fail "remove 失败: ${output:0:200}"
    fi
}

step_user_create_duplicate() {
    header "3.23" "user create 重复 username (E-15)"
    local output rc
    output=$($CLI user create --name "Dup User" --username mcp-e2e-verify --password test123456 2>&1) || rc=$?
    if echo "$output" | grep -q "already exists\|Already\|UNIQUE\|Constraint"; then
        pass "user create 重复 username 正确拒绝"
    else
        fail "user create 重复 username 未拒绝: ${output:0:100}"
    fi
}

step_auth_reset_password() {
    header "3.22" "auth reset-password (V-44)"
    local output
    output=$($CLI auth reset-password --username mcp-e2e-verify --password newpass456 2>&1)
    if echo "$output" | grep -q "reset\|Reset"; then
        pass "auth reset-password 成功"
    else
        fail "auth reset-password 失败: ${output:0:200}"
    fi
}

step_user_get() {
    header "3.23" "user get (V-46)"
    local output
    output=$($CLI user get "$TEST_USER_ID" 2>&1)
    if echo "$output" | grep -q "mcp-e2e-verify\|$TEST_USER_ID"; then
        pass "user get 显示用户信息"
    else
        fail "user get 异常: ${output:0:200}"
    fi
}

step_user_get_notfound() {
    header "3.24" "user get 不存在的 ID (E-16)"
    local output rc
    output=$($CLI user get nonexistent-user-id 2>&1) || rc=$?
    if echo "$output" | grep -q "not found"; then
        pass "user get 不存在 ID 正确报错"
    else
        fail "user get 不存在 ID 未报错: ${output:0:100}"
    fi
}

step_user_delete() {
    header "3.25" "user delete (V-47)"
    local output
    output=$($CLI user delete "$TEST_USER_ID" 2>&1)
    if echo "$output" | grep -q "Deleted\|deleted"; then
        pass "user delete 成功"
    else
        fail "user delete 失败: ${output:0:200}"
    fi
    TEST_USER_ID=""
}

step_user_delete_self_protect() {
    header "3.26" "自我删除保护 (E-17 / P-04)"

    # 获取当前登录用户 ID
    local current_user_id
    current_user_id=$($CLI auth whoami 2>&1 | grep "userId" | awk '{print $2}' || true)
    if [ -z "$current_user_id" ]; then
        skip "无法获取当前用户 ID"
        return
    fi

    local output rc
    output=$($CLI user delete "$current_user_id" 2>&1) || rc=$?
    if echo "$output" | grep -q "Cannot delete your own"; then
        pass "自我删除保护生效"
    else
        fail "自我删除保护未生效: ${output:0:200}"
    fi
}

step_auth_logout() {
    header "3.27" "auth logout (V-43)"
    local output
    output=$($CLI auth logout 2>&1)
    if echo "$output" | grep -q "Logged out\|logged out"; then
        pass "auth logout 成功"
    else
        fail "auth logout 失败: $output"
    fi
}

step_auth_whoami_after_logout() {
    header "3.26" "auth whoami 未登录状态 (E-14)"
    local output
    output=$($CLI auth whoami 2>&1)
    if echo "$output" | grep -q "Not logged in\|not logged in"; then
        pass "auth whoami 正确提示未登录"
    else
        fail "auth whoami 异常: ${output:0:200}"
    fi
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
# Phase 1 编排
# ============================================================================
phase1_setup() {
    echo -e "\n${BOLD}════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Phase 1: 数据准备${NC}"
    echo -e "${BOLD}════════════════════════════════════════${NC}"

    step_init || return 1
    step_auth_whoami || return 1
    step_user_create || return 1
    step_role_create || return 1
    # 先分配角色再轮换 token，确保 token claims 包含 tags
    step_user_assign_roles || return 1
    step_user_rotate_token || return 1
    step_import_test_skill || return 1
    step_cli_list
    step_cli_list_tags
    step_cli_list_name
    step_cli_info
    step_cli_info_notfound
    step_cli_search
    step_cli_search_notfound
    step_cli_versions
    step_cli_versions_show
    step_cli_versions_notfound
    step_cli_update
    step_cli_update_tags
    step_cli_update_description
    step_cli_update_notfound
    step_cli_lint_good
    step_cli_lint_bad
    step_cli_lint_notfound
    step_cli_import_duplicate
    step_cli_remove_notfound
    step_cli_rollback
}

# ============================================================================
# Phase 3 编排
# ============================================================================
phase3_cli_and_cleanup() {
    echo -e "\n${BOLD}════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Phase 3: CLI 深度验证 & 清理${NC}"
    echo -e "${BOLD}════════════════════════════════════════${NC}"

    step_eval_list
    step_eval_run
    step_eval_results
    step_pipeline_validate_good
    step_pipeline_validate_bad
    step_pipeline_graph
    step_pipeline_run
    step_migrate_check
    step_manifest_migrate
    step_manifest_migrate_patch
    step_manifest_migrate_apply
    step_upgrade
    step_sync_check
    step_role_list
    step_role_get
    step_role_get_notfound
    step_role_update
    step_role_delete
    step_role_delete_builtin_protect
    step_remove_skill
    step_auth_reset_password
    step_user_get
    step_user_get_notfound
    step_user_create_duplicate
    step_user_delete
    step_user_delete_self_protect
    step_auth_logout
    step_auth_whoami_after_logout
}

# ============================================================================
# 主入口
# ============================================================================
main() {
    local protocol="${1:-all}"

    echo -e "${BOLD}MCP 端到端验证 — 完整版${NC}"
    echo -e "时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo -e "版本: $($CLI --version 2>/dev/null || echo 'unknown')"
    echo -e "范围: $protocol"

    # Phase 1: 数据准备（总是执行）
    phase1_setup || { print_conclusion; exit 1; }

    # Phase 2: MCP 协议验证
    case "$protocol" in
        http)
            run_http_mcp
            ;;
        sse)
            run_sse_mcp
            ;;
        stdio)
            run_stdio_mcp
            ;;
        cli)
            info "跳过 MCP 协议验证（仅 CLI 模式）"
            ;;
        all)
            run_http_mcp
            run_sse_mcp
            run_stdio_mcp
            ;;
        *)
            echo "用法: $0 [http|sse|stdio|cli|all]"
            exit 1
            ;;
    esac

    # Phase 3: CLI 深度验证 & 清理（总是执行）
    phase3_cli_and_cleanup || true

    print_conclusion

    [ $FAIL_COUNT -eq 0 ]
}

main "$@"
