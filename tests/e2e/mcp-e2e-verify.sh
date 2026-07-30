#!/usr/bin/env bash
# =============================================================================
# v0.1 MCP end-to-end verification
#
# Verifies the retained local Registry surface only:
#   * isolated SQLite/local-fs Registry and RBAC setup
#   * BM25 `skill_search` (including ignored legacy mode/hybridAlpha inputs)
#   * HTTP, SSE, and stdio MCP transports
#   * exactly five MCP tools: list, search, view, file, feedback
#
# Usage:
#   bash tests/e2e/mcp-e2e-verify.sh [http|sse|stdio|all]
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI=(node "$PROJECT_ROOT/dist/index.js")
LOGIN_HELPER="$SCRIPT_DIR/_login-helper.mjs"
FIXTURE="$PROJECT_ROOT/tests/fixtures/test-skill"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
ERRORS=()
SERVER_PID=""
SERVER_LOG=""
SSE_CURL_PID=""
TEST_USER_ID=""
TEST_USER_TOKEN=""
IMPORTED_SLUG="test-skill"
MCP_ACCEPT_HEADER="Accept: application/json, text/event-stream"

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); ERRORS+=("$1"); echo -e "  ${RED}✗ $1${NC}"; }
info() { echo -e "  ${CYAN}→ $1${NC}"; }
header() { echo -e "\n${BOLD}[$1] $2${NC}"; echo "  ─────────────────────────────────────────"; }

assert_contains() {
    local description="$1" haystack="$2" needle="$3"
    if grep -Fq "$needle" <<<"$haystack"; then
        pass "$description"
    else
        fail "$description — missing: $needle; response: ${haystack:0:300}"
    fi
}

assert_http_code() {
    local description="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$description (HTTP $expected)"
    else
        fail "$description — expected HTTP $expected, got $actual"
    fi
}

cleanup() {
    if [ -n "${SSE_CURL_PID:-}" ]; then
        kill "$SSE_CURL_PID" 2>/dev/null || true
        wait "$SSE_CURL_PID" 2>/dev/null || true
    fi
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "${E2E_ROOT:-}" ] && [ -d "$E2E_ROOT" ]; then
        rm -rf "$E2E_ROOT"
    fi
}
trap cleanup EXIT

stop_server() {
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
        sleep 0.2
    fi
}

wait_for_file() {
    local file="$1" pattern="$2" attempts="${3:-50}"
    local _
    for _ in $(seq 1 "$attempts"); do
        if [ -f "$file" ] && grep -Fq "$pattern" "$file"; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

start_server() {
    local transport="$1" port="$2"
    header "SERVER" "启动本地 $transport MCP Registry (port $port)"
    SERVER_LOG="$E2E_ROOT/$transport-server.log"
    "${CLI[@]}" serve --transport "$transport" --port "$port" >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!

    local _
    for _ in $(seq 1 50); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            break
        fi
        if curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
            pass "本地 $transport Registry 已就绪 (PID: $SERVER_PID)"
            return 0
        fi
        sleep 0.2
    done

    fail "本地 $transport Registry 启动超时: $(tail -5 "$SERVER_LOG" 2>/dev/null | tr '\n' ' ')"
    return 1
}

# -----------------------------------------------------------------------------
# Isolated local Registry setup
# -----------------------------------------------------------------------------
setup_isolated_registry() {
    header "SETUP" "创建隔离的本地 SQLite / local-fs Registry"

    if [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
        fail "未找到 dist/index.js；请先运行 npm run build"
        return 1
    fi

    E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-mcp-e2e.XXXXXX")"
    export HOME="$E2E_ROOT/home"
    export DATABASE_PATH="$E2E_ROOT/registry/skill-mcp.db"
    export STORAGE_BASE_PATH="$E2E_ROOT/registry/skills"
    export CACHE_FILE_DIR="$E2E_ROOT/registry/cache"
    export AUTH_JWT_SECRET="e2e-local-registry-jwt-secret-at-least-32-bytes"
    unset SKILL_MCP_CONFIG CLOUD_SERVICE_URL DATABASE_URL STORAGE_TYPE SKILL_MCP_SERVER_URL
    mkdir -p "$HOME"

    if "${CLI[@]}" init --username superadmin --password admin888 >"$E2E_ROOT/init.log" 2>&1; then
        pass "独立 Registry 初始化完成"
    else
        fail "独立 Registry 初始化失败: $(tail -5 "$E2E_ROOT/init.log")"
        return 1
    fi

    local login_output
    if login_output=$(node "$LOGIN_HELPER" login superadmin admin888 2>&1) && grep -Fq "Logged in as superadmin" <<<"$login_output"; then
        pass "superadmin 已登录"
    else
        fail "superadmin 登录失败: $login_output"
        return 1
    fi
}

prepare_rbac_skill() {
    header "SETUP" "创建受标签 RBAC 保护的测试 Skill"

    local role_output
    if ! role_output=$("${CLI[@]}" role create --name "E2E Search Role" --tags e2e,verification --description "v0.1 E2E search role" 2>&1); then
        fail "创建 E2E 角色失败: $role_output"
        return 1
    fi
    local role_id
    role_id=$(grep -o 'role_[a-z0-9]*' <<<"$role_output" | head -1 || true)
    if [ -z "$role_id" ]; then
        fail "无法提取 E2E 角色 ID: $role_output"
        return 1
    fi
    pass "E2E RBAC 角色已创建"

    local user_output
    if ! user_output=$("${CLI[@]}" user create --name "MCP E2E User" --username mcp-e2e --password verify123456 --user-type user --role-ids "$role_id" 2>&1); then
        fail "创建 E2E 用户失败: $user_output"
        return 1
    fi
    TEST_USER_ID=$(grep -o 'usr_[a-z0-9]*' <<<"$user_output" | head -1 || true)
    TEST_USER_TOKEN=$(grep -o 'sk-live-[a-z0-9_]*' <<<"$user_output" | head -1 || true)
    if [ -z "$TEST_USER_ID" ] || [ -z "$TEST_USER_TOKEN" ]; then
        fail "无法提取 E2E 用户或 token: $user_output"
        return 1
    fi
    pass "受限用户及 Bearer token 已创建"

    local import_output
    if ! import_output=$("${CLI[@]}" import "$FIXTURE" --category e2e --tags e2e,verification --overwrite 2>&1); then
        fail "导入测试 Skill 失败: $import_output"
        return 1
    fi
    if grep -Eq 'Created|Updated|content unchanged' <<<"$import_output"; then
        pass "test-skill 已导入本地 Registry"
    else
        fail "导入测试 Skill 输出异常: $import_output"
        return 1
    fi
}

verify_local_cli() {
    header "CLI" "验证本地 Skill、版本和 lint"

    local output
    output=$("${CLI[@]}" list 2>&1)
    assert_contains "CLI list 返回 test-skill" "$output" "$IMPORTED_SLUG"

    output=$("${CLI[@]}" search --name "$IMPORTED_SLUG" 2>&1)
    assert_contains "CLI search 返回 test-skill" "$output" "$IMPORTED_SLUG"

    output=$("${CLI[@]}" versions "$IMPORTED_SLUG" 2>&1)
    if grep -Eq 'Version history|VERSION' <<<"$output"; then
        pass "CLI versions 返回版本历史"
    else
        fail "CLI versions 输出异常: ${output:0:300}"
    fi

    output=$("${CLI[@]}" lint "$FIXTURE" 2>&1 || true)
    if grep -Eq 'PASS|pass' <<<"$output"; then
        pass "CLI lint 通过"
    else
        fail "CLI lint 输出异常: ${output:0:300}"
    fi
}

# -----------------------------------------------------------------------------
# HTTP Streamable MCP
# -----------------------------------------------------------------------------
http_rpc() {
    local port="$1" token="$2" session_id="$3" id="$4" method="$5" params="$6"
    local headers=(-H "Content-Type: application/json" -H "$MCP_ACCEPT_HEADER" -H "Authorization: Bearer $token")
    if [ -n "$session_id" ]; then
        headers+=(-H "mcp-session-id: $session_id")
    fi
    curl -sS -X POST "http://127.0.0.1:$port/mcp" "${headers[@]}" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params}" 2>&1 || true
}

assert_http_result() {
    local description="$1" response="$2"
    if grep -Fq '"result"' <<<"$response"; then
        pass "$description"
    else
        fail "$description — response: ${response:0:300}"
    fi
}

verify_tool_list() {
    local label="$1" response="$2"
    local tool
    local expected=(skill_list skill_search skill_view skill_file skill_feedback)
    for tool in "${expected[@]}"; do
        assert_contains "$label 包含 $tool" "$response" "\"name\":\"$tool\""
    done
    if grep -Fq '"name":"skill_pipeline"' <<<"$response"; then
        fail "$label 不应暴露已移除的 skill_pipeline"
    else
        pass "$label 精确保持五个 v0.1 工具"
    fi
}

verify_http_mcp() {
    local port="$1"
    start_server http "$port" || return 1

    header "HTTP" "Gateway 鉴权与 Streamable HTTP MCP"
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/gateway/skills" || true)
    assert_http_code "未认证 Gateway 请求被拒绝" "$code" 401
    code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TEST_USER_TOKEN" "http://127.0.0.1:$port/api/gateway/skills" || true)
    assert_http_code "带 RBAC token 的 Gateway 请求可用" "$code" 200

    local headers="$E2E_ROOT/http-headers" init_response session_id response
    init_response=$(curl -sS -D "$headers" -X POST "http://127.0.0.1:$port/mcp" \
        -H "Content-Type: application/json" -H "$MCP_ACCEPT_HEADER" -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v0.1-e2e","version":"1.0.0"}}}' 2>&1 || true)
    session_id=$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\\r", "", $2); print $2; exit}' "$headers" || true)
    assert_http_result "HTTP MCP initialize 返回 result" "$init_response"
    if [ -n "$session_id" ]; then
        pass "HTTP MCP session 已建立"
    else
        fail "HTTP MCP 未返回 mcp-session-id: ${init_response:0:300}"
        stop_server
        return 1
    fi

    http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 0 notifications/initialized '{}' >/dev/null
    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 2 tools/list '{}')
    assert_http_result "HTTP tools/list 返回 result" "$response"
    verify_tool_list "HTTP tools/list" "$response"

    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 3 tools/call '{"name":"skill_list","arguments":{}}')
    assert_http_result "HTTP skill_list" "$response"
    assert_contains "HTTP skill_list 返回 test-skill" "$response" "$IMPORTED_SLUG"

    # mode/hybridAlpha remain accepted only for legacy validation; ranking remains BM25.
    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 4 tools/call '{"name":"skill_search","arguments":{"query":"验收","limit":5,"mode":"hybrid","hybridAlpha":0.25}}')
    assert_http_result "HTTP BM25 skill_search" "$response"
    assert_contains "HTTP BM25 skill_search 返回 test-skill" "$response" "$IMPORTED_SLUG"
    assert_contains "HTTP BM25 skill_search 返回 BM25 score" "$response" "score="

    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 5 tools/call "{\"name\":\"skill_view\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\"}}")
    assert_http_result "HTTP skill_view" "$response"

    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 6 tools/call "{\"name\":\"skill_file\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}}")
    assert_http_result "HTTP skill_file" "$response"

    response=$(http_rpc "$port" "$TEST_USER_TOKEN" "$session_id" 7 tools/call "{\"name\":\"skill_feedback\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"v0.1 e2e\"}}")
    assert_http_result "HTTP skill_feedback" "$response"

    stop_server
}

# -----------------------------------------------------------------------------
# SSE MCP
# -----------------------------------------------------------------------------
sse_post() {
    local url="$1" payload="$2"
    curl -sS -o /dev/null -w '%{http_code}' -X POST "$url" \
        -H 'Content-Type: application/json' -H "Authorization: Bearer $TEST_USER_TOKEN" \
        -d "$payload" 2>/dev/null || true
}

sse_call_and_assert() {
    local url="$1" file="$2" id="$3" tool="$4" arguments="$5" expected_text="${6:-}"
    local code
    code=$(sse_post "$url" "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$arguments}}")
    assert_http_code "SSE POST $tool 被接受" "$code" 202
    if wait_for_file "$file" "\"id\":$id"; then
        if grep -Eq "\"id\":$id.*\"result\"|\"result\".*\"id\":$id" "$file"; then
            pass "SSE $tool 返回 result"
        else
            fail "SSE $tool 返回 error: $(grep -F "\"id\":$id" "$file" | tail -1 | cut -c1-300)"
        fi
    else
        fail "SSE $tool 未返回响应"
    fi
    if [ -n "$expected_text" ]; then
        if grep -Fq "$expected_text" "$file"; then
            pass "SSE $tool 返回 $expected_text"
        else
            fail "SSE $tool 未返回 $expected_text"
        fi
    fi
}

verify_sse_mcp() {
    local port="$1"
    start_server sse "$port" || return 1

    header "SSE" "建立 SSE 会话并验证五个 MCP 工具"
    local sse_file="$E2E_ROOT/sse-events" endpoint full_url code response
    : > "$sse_file"
    curl -sS -N -H "Authorization: Bearer $TEST_USER_TOKEN" "http://127.0.0.1:$port/mcp/sse" >"$sse_file" 2>"$E2E_ROOT/sse-curl.log" &
    SSE_CURL_PID=$!

    if ! wait_for_file "$sse_file" 'event: endpoint'; then
        fail "SSE 未返回 endpoint: $(cat "$sse_file")"
        stop_server
        return 1
    fi
    endpoint=$(awk '/event: endpoint/{getline; sub(/^data: /, ""); gsub(/\r/, ""); print; exit}' "$sse_file")
    if [ -z "$endpoint" ]; then
        fail "无法解析 SSE endpoint: $(cat "$sse_file")"
        stop_server
        return 1
    fi
    pass "SSE endpoint 已建立"
    full_url="http://127.0.0.1:$port$endpoint"

    code=$(sse_post "$full_url" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v0.1-e2e","version":"1.0.0"}}}')
    assert_http_code "SSE initialize 被接受" "$code" 202
    if wait_for_file "$sse_file" '"id":1'; then
        pass "SSE initialize 返回响应"
    else
        fail "SSE initialize 未返回响应"
    fi
    sse_post "$full_url" '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

    code=$(sse_post "$full_url" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
    assert_http_code "SSE tools/list 被接受" "$code" 202
    if wait_for_file "$sse_file" '"id":2'; then
        response=$(cat "$sse_file")
        verify_tool_list "SSE tools/list" "$response"
    else
        fail "SSE tools/list 未返回响应"
    fi

    sse_call_and_assert "$full_url" "$sse_file" 3 skill_list '{}' "$IMPORTED_SLUG"
    sse_call_and_assert "$full_url" "$sse_file" 4 skill_search '{"query":"验收","mode":"vector","hybridAlpha":0.75}' "$IMPORTED_SLUG"
    sse_call_and_assert "$full_url" "$sse_file" 5 skill_view "{\"skill_slug\":\"$IMPORTED_SLUG\"}" "$IMPORTED_SLUG"
    sse_call_and_assert "$full_url" "$sse_file" 6 skill_file "{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}" 'SKILL.md'
    sse_call_and_assert "$full_url" "$sse_file" 7 skill_feedback "{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"v0.1 e2e\"}"

    kill "$SSE_CURL_PID" 2>/dev/null || true
    wait "$SSE_CURL_PID" 2>/dev/null || true
    SSE_CURL_PID=""
    stop_server
}

# -----------------------------------------------------------------------------
# stdio MCP
# -----------------------------------------------------------------------------
verify_stdio_mcp() {
    header "STDIO" "验证 stdio MCP 与五个工具"

    local output_file="$E2E_ROOT/stdio-output" error_file="$E2E_ROOT/stdio-error"
    local init_req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v0.1-e2e","version":"1.0.0"}}}'
    local initialized='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local tools_req='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

    (
        printf '%s\n' "$init_req"; sleep 0.2
        printf '%s\n' "$initialized"; sleep 0.1
        printf '%s\n' "$tools_req"; sleep 0.2
        printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skill_list","arguments":{}}}'; sleep 0.2
        printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"skill_search","arguments":{"query":"验收","mode":"hybrid","hybridAlpha":0.5}}}'; sleep 0.2
        printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_view\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\"}}}"; sleep 0.2
        printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_file\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"file_paths\":[\"SKILL.md\"]}}}"; sleep 0.2
        printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"skill_feedback\",\"arguments\":{\"skill_slug\":\"$IMPORTED_SLUG\",\"outcome\":\"success\",\"context\":\"v0.1 e2e\"}}}"
    ) | SKILL_MCP_AUTH_TOKEN="$TEST_USER_TOKEN" "${CLI[@]}" serve --transport stdio >"$output_file" 2>"$error_file" &
    local stdio_pid=$!

    local _
    for _ in $(seq 1 50); do
        if ! kill -0 "$stdio_pid" 2>/dev/null; then break; fi
        sleep 0.2
    done
    kill "$stdio_pid" 2>/dev/null || true
    wait "$stdio_pid" 2>/dev/null || true

    local output
    output=$(cat "$output_file")
    if [ -z "$output" ]; then
        fail "stdio 未产生 MCP 输出: $(tail -5 "$error_file")"
        return
    fi
    assert_contains "stdio initialize 返回响应" "$output" '"id":1'
    verify_tool_list "stdio tools/list" "$output"

    local id
    for id in 3 4 5 6 7; do
        if grep -Eq "\"id\":$id.*\"result\"|\"result\".*\"id\":$id" <<<"$output"; then
            pass "stdio tools/call id=$id 返回 result"
        else
            fail "stdio tools/call id=$id 未返回 result: ${output:0:500}"
        fi
    done
    assert_contains "stdio BM25 skill_search 返回 test-skill" "$output" "$IMPORTED_SLUG"
}

print_conclusion() {
    echo -e "\n${BOLD}========================================${NC}"
    echo -e "${BOLD}  v0.1 MCP E2E 验证结论${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo -e "  ${GREEN}通过: $PASS_COUNT${NC}"
    echo -e "  ${RED}失败: $FAIL_COUNT${NC}"
    if [ "$FAIL_COUNT" -eq 0 ]; then
        echo -e "\n  ${GREEN}${BOLD}✓ 本地 BM25 Registry、RBAC 和三种 MCP transport 全部通过${NC}"
    else
        echo -e "\n  ${RED}${BOLD}✗ 端到端验证存在失败项${NC}"
        local error
        for error in "${ERRORS[@]}"; do echo -e "    ${RED}• $error${NC}"; done
    fi
}

main() {
    local protocol="${1:-all}"
    case "$protocol" in http|sse|stdio|all) ;; *)
        echo "Usage: $0 [http|sse|stdio|all]" >&2
        exit 2
    esac

    echo -e "${BOLD}Skill MCP v0.1 — 本地 BM25 E2E 验证${NC}"
    echo "版本: $("${CLI[@]}" --version 2>/dev/null || echo unknown)"
    echo "范围: $protocol"

    setup_isolated_registry || { print_conclusion; exit 1; }
    prepare_rbac_skill || { print_conclusion; exit 1; }
    verify_local_cli

    local port=$((40000 + RANDOM % 10000))
    case "$protocol" in
        http) verify_http_mcp "$port" ;;
        sse) verify_sse_mcp "$port" ;;
        stdio) verify_stdio_mcp ;;
        all)
            verify_http_mcp "$port"
            verify_sse_mcp "$port"
            verify_stdio_mcp
            ;;
    esac

    print_conclusion
    [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
