#!/bin/bash
# Skill MCP Server - 快速启动脚本
# 用法: ./docker/start.sh [c1|c2|gateway]

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 显示帮助
show_help() {
    echo -e "${BLUE}Skill MCP Server - Docker 启动脚本${NC}"
    echo ""
    echo "用法: $0 [PROFILE]"
    echo ""
    echo "PROFILE:"
    echo "  c1        单体部署（开发/测试）"
    echo "  c2        分布式部署（生产推荐）"
    echo "  gateway   带 HTTPS 网关的分布式部署"
    echo "  help      显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0 c1        # 启动单体部署"
    echo "  $0 c2        # 启动分布式部署"
    echo "  $0 gateway   # 启动带 HTTPS 网关的部署"
    echo ""
    echo "环境变量:"
    echo "  STORAGE_SVC_TOKEN  服务间认证 token（C2/gateway 模式必需）"
    echo "  DOMAIN             域名（gateway 模式必需）"
    echo "  ACME_EMAIL         Let's Encrypt 邮箱（gateway 模式必需）"
}

# 检查环境变量
check_env() {
    local profile=$1
    
    if [[ "$profile" == "c2" || "$profile" == "gateway" ]]; then
        if [[ -z "$STORAGE_SVC_TOKEN" ]]; then
            echo -e "${YELLOW}警告: STORAGE_SVC_TOKEN 未设置${NC}"
            echo -e "${YELLOW}使用默认值 'changeme'，建议设置正确的 token:${NC}"
            echo -e "${BLUE}export STORAGE_SVC_TOKEN=\$(skill-mcp user create svc-gateway --role <role-id> | grep -oP 'token: \K.*')${NC}"
            echo ""
        fi
    fi
    
    if [[ "$profile" == "gateway" ]]; then
        if [[ -z "$DOMAIN" ]]; then
            echo -e "${YELLOW}警告: DOMAIN 未设置，使用 localhost${NC}"
            echo -e "${BLUE}export DOMAIN=your-domain.com${NC}"
            export DOMAIN="localhost"
        fi
        if [[ -z "$ACME_EMAIL" ]]; then
            echo -e "${YELLOW}警告: ACME_EMAIL 未设置，使用默认值${NC}"
            export ACME_EMAIL="admin@example.com"
        fi
    fi
}

# 启动服务
start_services() {
    local profile=$1
    
    echo -e "${BLUE}启动 Skill MCP Server (${profile} 模式)...${NC}"
    echo ""
    
    cd "$PROJECT_DIR"
    
    case $profile in
        c1)
            docker compose --profile c1 up -d --build
            echo ""
            echo -e "${GREEN}✓ 服务已启动${NC}"
            echo -e "  访问: http://localhost:3000"
            echo -e "  健康检查: curl http://localhost:3000/api/health"
            ;;
        c2)
            docker compose --profile c2 up -d --build
            echo ""
            echo -e "${GREEN}✓ 服务已启动${NC}"
            echo -e "  Storage: http://localhost:3000"
            echo -e "  MCP: http://localhost:4000"
            echo -e "  健康检查: curl http://localhost:3000/api/health"
            ;;
        gateway)
            docker compose --profile c2 --profile gateway up -d --build
            echo ""
            echo -e "${GREEN}✓ 服务已启动${NC}"
            echo -e "  HTTPS: https://${DOMAIN}"
            echo -e "  MCP端点: https://${DOMAIN}/mcp"
            ;;
    esac
}

# 主函数
main() {
    local profile=${1:-help}
    
    case $profile in
        c1|c2|gateway)
            check_env "$profile"
            start_services "$profile"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${RED}错误: 未知的 profile '$profile'${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
