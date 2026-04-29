#!/bin/bash
# Demo script for Scenario C: Distributed HTTP Deployment

set -e

echo "=== Scenario C Demo: Distributed HTTP Deployment ==="
echo ""
echo "This demo shows two options:"
echo "  C1: Single HTTP server (simple)"
echo "  C2: Distributed (storage + MCP services)"
echo ""
echo "Which would you like to try?"
echo "  1) C1 - Single server (recommended for getting started)"
echo "  2) C2 - Distributed deployment"
echo ""
read -p "Choose (1 or 2): " choice

if [ "$choice" != "1" ] && [ "$choice" != "2" ]; then
  echo "Invalid choice. Exiting."
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Cleanup function
cleanup() {
  echo ""
  echo -e "${YELLOW}Stopping services...${NC}"
  jobs -p | xargs -r kill 2>/dev/null || true
  echo -e "${GREEN}✓ Cleaned up${NC}"
}

trap cleanup EXIT

# Build project
echo ""
echo "Building project..."
npm run build > /dev/null 2>&1 || {
  echo -e "${RED}✗ Build failed${NC}"
  exit 1
}
echo -e "${GREEN}✓ Build successful${NC}"

if [ "$choice" = "1" ]; then
  # Scenario C1
  echo ""
  echo -e "${YELLOW}=== Starting Scenario C1: Single HTTP Server ===${NC}"
  echo "Configuration:"
  echo "  - Transport: HTTP"
  echo "  - Port: 3000"
  echo "  - Mode: standalone (local data)"
  echo "  - MCP + Admin API on same server"
  echo ""

  export $(cat src/config/examples/.env.scenario-c1 | xargs)
  export TRANSPORT_PORT=3000

  npm start 2>&1 | sed 's/^/[C1-Server] /'

else
  # Scenario C2
  echo ""
  echo -e "${YELLOW}=== Starting Scenario C2: Distributed Deployment ===${NC}"
  echo ""

  # Start storage service
  echo -e "${YELLOW}Starting Storage Service (port 3000)...${NC}"
  echo "Configuration:"
  echo "  - Transport: HTTP"
  echo "  - Port: 3000"
  echo "  - Mode: standalone (local data)"
  echo "  - MCP_ONLY_MODE: true (only /api/gateway/*)"
  echo "  - Auth: API Key enabled"
  echo ""

  export $(cat src/config/examples/.env.scenario-c2-storage | xargs)
  export TRANSPORT_PORT=3000
  export ENABLE_API_KEY_AUTH=true
  export API_KEYS=demo-c2-storage-key

  npm start 2>&1 | sed 's/^/[C2-Storage] /' &
  STORAGE_PID=$!

  # Wait for storage
  echo "Waiting for storage service to be ready..."
  max_attempts=30
  attempt=0
  while ! curl -s -H "Authorization: Bearer demo-c2-storage-key" http://localhost:3000/api/gateway/health > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
      echo -e "${RED}✗ Storage service did not start${NC}"
      kill $STORAGE_PID 2>/dev/null || true
      exit 1
    fi
    sleep 0.5
  done
  echo -e "${GREEN}✓ Storage service ready${NC}"
  echo ""

  # Start MCP service(s)
  echo -e "${YELLOW}Starting MCP Service (port 4000)...${NC}"
  echo "Configuration:"
  echo "  - Transport: HTTP"
  echo "  - Port: 4000"
  echo "  - Mode: gateway (connects to storage)"
  echo "  - MCP_ONLY_MODE: true (only /mcp/*)"
  echo ""

  export TRANSPORT_TYPE=http
  export TRANSPORT_PORT=4000
  export DEPLOYMENT_MODE=gateway
  export CLOUD_SERVICE_URL=http://localhost:3000
  export AUTH_TOKEN=demo-c2-storage-key
  export MCP_ONLY_MODE=true

  npm start 2>&1 | sed 's/^/[C2-MCP] /' &
  MCP_PID=$!

  sleep 2
  echo -e "${GREEN}✓ MCP service started${NC}"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✓ Server is running!${NC}"
echo "=========================================="
echo ""

if [ "$choice" = "1" ]; then
  echo "Scenario C1: Single HTTP Server"
  echo ""
  echo "MCP endpoint: http://localhost:3000/mcp"
  echo "Admin API: http://localhost:3000/api"
  echo ""
  echo "Try:"
  echo "  curl http://localhost:3000/api/health"
  echo "  curl http://localhost:3000/api/gateway/health"
  echo ""
else
  echo "Scenario C2: Distributed Deployment"
  echo ""
  echo "Storage Service: http://localhost:3000"
  echo "  - Admin API: http://localhost:3000/api/gateway/*"
  echo "  - Requires: Authorization: Bearer demo-c2-storage-key"
  echo ""
  echo "MCP Service: http://localhost:4000"
  echo "  - MCP endpoint: http://localhost:4000/mcp"
  echo "  - Connects to storage at http://localhost:3000"
  echo ""
  echo "Try:"
  echo "  curl -H 'Authorization: Bearer demo-c2-storage-key' http://localhost:3000/api/gateway/health"
  echo ""
fi

echo "Press Ctrl+C to stop."
echo ""

wait

