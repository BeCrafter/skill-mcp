# Deployment Scripts

This directory contains deployment and demo scripts for different Skill MCP scenarios.

## Available Scripts

### scenario-b-demo.sh
Demonstrates hybrid deployment: local MCP client + remote storage service.

**Prerequisites**:
- Node.js >= 22
- Two terminal windows

**Purpose**: Shows how to run a gateway that proxies requests to a remote storage service.

**Usage**:
```bash
chmod +x scripts/scenario-b-demo.sh
./scripts/scenario-b-demo.sh
```

### scenario-c-demo.sh
Demonstrates distributed HTTP deployment with separate MCP and storage services.

**Prerequisites**:
- Node.js >= 22
- Two terminal windows

**Purpose**: Shows production-grade deployment with separated services behind load balancer.

**Usage**:
```bash
chmod +x scripts/scenario-c-demo.sh
./scripts/scenario-c-demo.sh
```

## Adding New Scripts

When adding new deployment or demo scripts:

1. Create script in this directory with `.sh` extension
2. Add shebang and proper error handling
3. Make it executable: `chmod +x script-name.sh`
4. Add documentation in this README
5. Reference in main README.md deployment section
6. Test with: `bash scripts/script-name.sh`

## Related Documentation

- See [Deployment Scenarios](../docs/SCENARIOS/) for detailed scenario explanations
- See [Production Deployment](../docs/PRODUCTION_DEPLOYMENT.md) for production guidelines
- See [Architecture](../docs/ARCHITECTURE.md) for system design details
