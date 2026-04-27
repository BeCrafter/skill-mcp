#!/bin/bash
# Demo script for Scenario B: Local MCP + Remote Storage

set -e

echo "=== Scenario B Demo: Local MCP + Remote Storage ==="
echo ""
echo "This script will start two services:"
echo "  1. Remote Storage Server (HTTP on port 3000)"
echo "  2. Local MCP Client (stdio)"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if ports are available
check_port() {
  local port=$1
  if nc -z localhost $port 2>/dev/null; then
    echo -e "${RED}✗ Port $port is already in use${NC}"
    return 1
  fi
  return 0
}

# Cleanup function
cleanup() {
  echo ""
  echo -e "${YELLOW}Stopping services...${NC}"
  jobs -p | xargs -r kill 2>/dev/null || true
  echo -e "${GREEN}✓ Cleaned up${NC}"
}

trap cleanup EXIT

# Check ports
echo "Checking ports..."
if ! check_port 3000; then
  echo "Please stop the service using port 3000 and try again."
  exit 1
fi

# Build project
echo ""
echo "Building project..."
npm run build > /dev/null 2>&1 || {
  echo -e "${RED}✗ Build failed${NC}"
  exit 1
}
echo -e "${GREEN}✓ Build successful${NC}"

# Start storage server
echo ""
echo -e "${YELLOW}Starting Remote Storage Server...${NC}"
echo "Configuration:"
echo "  - Transport: HTTP"
echo "  - Port: 3000"
echo "  - Mode: standalone (local data)"
echo "  - Auth: API Key enabled"
echo "  - API Key: demo-key-scenario-b"
echo ""

export $(cat src/config/examples/.env.scenario-b-server | xargs)
export ENABLE_API_KEY_AUTH=true
export API_KEYS=demo-key-scenario-b

npm start 2>&1 | sed 's/^/[Storage] /' &
STORAGE_PID=$!

# Wait for storage to start
echo "Waiting for storage server to be ready..."
max_attempts=30
attempt=0
while ! curl -s -H "Authorization: Bearer demo-key-scenario-b" http://localhost:3000/api/gateway/health > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ $attempt -ge $max_attempts ]; then
    echo -e "${RED}✗ Storage server did not start${NC}"
    kill $STORAGE_PID 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

echo -e "${GREEN}✓ Storage server ready${NC}"
echo ""

# Show health check
echo "Storage server health check:"
curl -s -H "Authorization: Bearer demo-key-scenario-b" http://localhost:3000/api/gateway/health | python3 -m json.tool

echo ""
echo -e "${YELLOW}Starting Local MCP Client...${NC}"
echo "Configuration:"
echo "  - Transport: stdio"
echo "  - Mode: gateway (remote provider)"
echo "  - Remote URL: http://localhost:3000"
echo "  - API Key: demo-key-scenario-b"
echo ""

export TRANSPORT_TYPE=stdio
export DEPLOYMENT_MODE=gateway
export CLOUD_SERVICE_URL=http://localhost:3000
export AUTH_TOKEN=demo-key-scenario-b

# Clear unneeded env vars
unset ENABLE_API_KEY_AUTH
unset API_KEYS

npm start 2>&1 | sed 's/^/[MCP-Client] /' &
MCP_PID=$!

echo -e "${GREEN}✓ Local MCP client started${NC}"
echo ""

# Wait a bit for MCP to initialize
sleep 2

# Show usage information
echo "=========================================="
echo -e "${GREEN}✓ Both services are running!${NC}"
echo "=========================================="
echo ""
echo "The local MCP client is now ready to connect to the remote storage."
echo ""
echo "You can now:"
echo "1. Connect Claude IDE to the local MCP (stdio transport)"
echo "2. The MCP will fetch skills from the remote storage at http://localhost:3000"
echo ""
echo "Test the storage API directly:"
echo "  curl -H 'Authorization: Bearer demo-key-scenario-b' http://localhost:3000/api/gateway/skills"
echo ""
echo "Press Ctrl+C to stop both services."
echo ""

# Wait for processes
wait

