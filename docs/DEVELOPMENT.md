# Development Workflow Guide

This guide explains how to set up your development environment, develop features, and contribute code to the Skill MCP project.

## 🚀 Quick Start (5 minutes)

### 1. Environment Setup

```bash
# Clone repository
git clone https://github.com/BeCrafter/skill-mcp.git
cd skill-mcp

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start development server (default: stdio transport)
npm start
```

### 2. Verify Installation

```bash
# Check code style
npm run lint

# Run tests
npm test

# Check test coverage
npm run test:coverage
```

If all commands pass, you're ready to develop!

## 📁 Project Structure Quick Reference

```
skill-mcp/
├── src/                    # Source code
│   ├── app.ts             # MCP server entry point
│   ├── index.ts           # CLI entry point
│   ├── services/          # Business logic
│   ├── db/                # Database layer
│   ├── storage/           # Storage implementations
│   ├── provider/          # Skill providers (Local/Remote)
│   ├── cache/             # Caching layer
│   ├── cli/               # CLI commands
│   ├── config/            # Configuration management
│   └── utils/             # Utility functions
│
├── tests/                  # Test files
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
│
├── docs/                   # Documentation
│   ├── DEVELOPMENT.md     # This file
│   ├── ARCHITECTURE.md    # System architecture
│   ├── API_REFERENCE.md   # MCP tool reference
│   └── SCENARIOS/         # Deployment scenarios
│
├── .env.example           # Environment variables template
├── package.json           # Dependencies and scripts
├── CONTRIBUTING.md        # Contributing guidelines
└── CLAUDE.md              # Architecture and deployment modes
```

## 🌳 Branch Management

### Main Branches

- **main**: Production-ready code (stable, release versions)
  - Only merged from `release/` or `dev` branches
  - Tagged with version numbers (v1.0.0, v1.0.1, etc.)

- **dev**: Integration branch for development
  - Merge point for all feature branches
  - Relatively stable, tested before release

### Feature Branches

Create branches from `dev` for your work:

```bash
# Feature branches
git checkout dev
git pull origin dev
git checkout -b feature/add-skill-batch-import
git checkout -b feature/improve-cache

# Bugfix branches
git checkout -b bugfix/fix-path-traversal
git checkout -b bugfix/fix-concurrent-access

# Naming: feature/*, bugfix/* (use hyphens, no underscores)
```

### Branch Workflow

```
dev (main development branch)
  ↓
  ├─ Create feature/add-feature
  │  (local development)
  │  ↓
  ├─ git push origin feature/add-feature
  │  (push to remote)
  │  ↓
  ├─ Create Pull Request
  │  (code review)
  │  ↓
  ├─ Merge to dev
  │  (after approval)
  │  ↓
  └─ Delete branch
     (cleanup)
     ↓
  (periodically merge dev → main for releases)
```

## 💻 Development Workflow

### 1. Starting Work

```bash
# Update dev branch
git checkout dev
git pull origin dev

# Create feature branch
git checkout -b feature/my-feature-name

# Verify build
npm run build
npm test
```

### 2. Making Changes

```bash
# Edit files in src/

# Format code
npm run lint:fix

# Run tests for your changes
npm test

# Build to check for TypeScript errors
npm run build
```

### 3. Committing Work

Use conventional commit format (required):

```bash
# Good commits
git commit -m "feat: add skill batch import"
git commit -m "fix: correct storage path calculation"
git commit -m "test: add compliance metrics test"
git commit -m "docs: update deployment guide"

# Bad commits (will be rejected by pre-commit hook)
git commit -m "update"
git commit -m "fix stuff"
```

### 4. Pushing Changes

```bash
# Push feature branch to remote
git push origin feature/my-feature-name

# Create Pull Request on GitHub
# Title: Same as your commit message
# Description: Explain what and why
```

### 5. Handling Review Comments

```bash
# Make requested changes
vim src/...

# Commit with conventional message
git commit -m "fix: address review comments"

# Push updated commits
git push origin feature/my-feature-name

# Request re-review on GitHub
```

### 6. Merging

```bash
# After PR is approved and CI passes:
# Click "Merge pull request" on GitHub
# Or merge locally:

git checkout dev
git pull origin dev
git merge --no-ff feature/my-feature-name
git push origin dev
```

## ✍️ Commit Message Convention

We use conventional commits for semantic versioning and changelog generation.

### Format

```
<type>(<optional-scope>): <subject>

<optional body explaining what and why>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **test**: Test-related changes
- **perf**: Performance improvements
- **refactor**: Code restructuring
- **chore**: Build/config/dependencies

### Examples

```bash
# Feature with scope
git commit -m "feat(import): add batch skill import"

# Bug fix
git commit -m "fix: correct storage path for nested skills"

# Documentation
git commit -m "docs: update deployment guide for scenario C2"

# Test
git commit -m "test: add compliance metrics framework"

# Performance
git commit -m "perf: optimize cache lookup performance"

# Chore
git commit -m "chore: update dependencies"
```

### Detailed Commit Example

```
feat(import): add batch skill import with progress tracking

Implement batch import feature allowing users to import multiple
skills at once with real-time progress updates. Uses streaming
API to avoid timeout on large imports.

Benefits:
- Faster bulk imports for administrators
- Better UX with progress feedback
- Prevents timeout on large skill packages

Fixes #123
Relates to #456
```

## 🧪 Testing

### Running Tests

```bash
# All tests
npm test

# Specific test file
npx vitest run tests/unit/services/skill-service.test.ts

# Tests matching pattern
npx vitest run -t "skill list"

# Watch mode (auto-run on file changes)
npm run test:watch

# Coverage report
npm run test:coverage
```

### Test Structure

```
tests/
├── unit/              # Isolated unit tests
│   ├── services/
│   ├── utils/
│   └── ...
├── integration/       # Component integration tests
└── e2e/              # End-to-end workflow tests
```

### Writing Tests

```typescript
// Good test structure
describe("SkillService", () => {
  it("should list all published skills", () => {
    // Arrange
    const mockRepo = createMockRepository();
    
    // Act
    const result = skillService.list();
    
    // Assert
    expect(result).toHaveLength(2);
  });

  it("should reject duplicate skill names", () => {
    // Test error case
    expect(() => skillService.create({
      name: "existing-skill"
    })).toThrow("Duplicate skill name");
  });
});
```

## 🔧 Common Development Tasks

### Build Project

```bash
# Compile TypeScript to dist/
npm run build

# Watch mode (auto-compile)
npm run dev
```

### Lint Code

```bash
# Check for issues
npm run lint

# Auto-fix issues
npm run lint:fix
```

### Start Server

```bash
# Default: stdio transport (local development)
npm start

# HTTP transport
TRANSPORT_TYPE=http npm start

# Different deployment mode
DEPLOYMENT_MODE=gateway npm start
```

### View Database

```bash
# Connect to SQLite database
sqlite3 data/skill-mcp.db

# List tables
.tables

# View skills
SELECT id, name, version FROM skills;

# Exit
.quit
```

### Clear Local Data

```bash
# Remove compiled code
npm run clean

# Remove database and skills
rm -rf data/

# Fresh start
npm install && npm run build && npm start
```

## 🐛 Debugging

### Add Debug Logs

```typescript
// Use pino logger
import { logger } from "../config/logger";

logger.debug({ skillId: "123" }, "Processing skill");
logger.warn("This might be a problem");
logger.error({ error }, "Something failed");
```

### Run with Debug Output

```bash
# Set log level
LOG_LEVEL=debug npm start

# Trace level (most verbose)
LOG_LEVEL=trace npm start
```

### Debug Tests

```bash
# Run single test with output
npm test -- tests/unit/services/skill-service.test.ts --reporter=verbose
```

## 📦 Configuration

### Environment Variables

See [.env.example](../.env.example) for all available variables.

Common configurations:

```bash
# Local development
DEPLOYMENT_MODE=standalone
TRANSPORT_TYPE=stdio
STORAGE_TYPE=local-fs
DATABASE_PATH=./data/skill-mcp.db
LOG_LEVEL=debug

# HTTP server
DEPLOYMENT_MODE=standalone
TRANSPORT_TYPE=http
TRANSPORT_PORT=3000

# Gateway mode
DEPLOYMENT_MODE=gateway
CLOUD_SERVICE_URL=http://localhost:3001
```

### Build Configuration

- **TypeScript**: `tsconfig.json`
- **ESLint**: `eslint.config.js`
- **Tests**: `vitest.config.ts`

## 🚀 Version Management

### Semantic Versioning

We follow [SemVer](https://semver.org/):
- **MAJOR.MINOR.PATCH**
- Example: v1.2.3 (major=1, minor=2, patch=3)

### When to Bump Version

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes, incompatible API
- **MINOR** (1.0.0 → 1.1.0): New features, backward compatible
- **PATCH** (1.0.0 → 1.0.1): Bug fixes, backward compatible

### Release Process

```bash
# 1. Update version in package.json
# 2. Create release branch
git checkout -b release/v1.0.0

# 3. Commit version change
git commit -m "chore: bump version to 1.0.0"

# 4. Merge to main
git checkout main
git merge --no-ff release/v1.0.0

# 5. Tag release
git tag -a v1.0.0 -m "Release v1.0.0"

# 6. Push to remote
git push origin main --tags

# 7. Merge back to dev
git checkout dev
git merge --no-ff release/v1.0.0
git push origin dev
```

## 🔄 Pre-commit Hooks

We use pre-commit hooks to maintain code quality. Before each commit, the following checks run automatically:

1. **ESLint** - Code style and quality
2. **Tests** - Unit and integration tests
3. **Commit Message** - Format validation

If any check fails, the commit is rejected.

### Bypassing Hooks (Emergency Only)

```bash
# Skip pre-commit hook (NOT recommended)
git commit --no-verify

# Note: CI will still check, so PR will fail if issues remain
```

### Manual Hook Run

```bash
# Run hook manually
.git/hooks/pre-commit .git/COMMIT_EDITMSG
```

## 📚 Additional Resources

- **Contributing**: See [CONTRIBUTING.md](../CONTRIBUTING.md) for PR guidelines
- **Architecture**: See [CLAUDE.md](../CLAUDE.md) for system design
- **API Reference**: See [docs/API_REFERENCE.md](./API_REFERENCE.md) for MCP tools
- **Scenarios**: See [docs/SCENARIOS/](./SCENARIOS/) for deployment examples

## ❓ Troubleshooting

### Build Fails

```bash
# Clean and rebuild
npm run clean
npm install
npm run build
```

### Tests Fail

```bash
# Run specific test to see details
npm test -- tests/unit/specific.test.ts

# Run with verbose output
npm test -- --reporter=verbose
```

### Pre-commit Hook Issues

```bash
# Verify hook is executable
ls -la .git/hooks/pre-commit

# Make executable if needed
chmod +x .git/hooks/pre-commit

# Test hook manually
.git/hooks/pre-commit
```

### Database Issues

```bash
# Reset database
rm data/skill-mcp.db*

# Fresh start
npm start
```

## 🎯 Best Practices

1. **Commit Often**: Small, focused commits are easier to review
2. **Test Before Push**: Run `npm test` before pushing
3. **Update Documentation**: Docs should stay current with code
4. **Review Your Own Code First**: Before requesting review
5. **Be Descriptive**: Commit messages and PR descriptions help reviewers
6. **Keep PRs Focused**: One feature per PR, not multiple features
7. **Respond to Feedback**: Address review comments promptly
8. **Clean Up Branches**: Delete branch after merge

---

**Happy coding! 🎉**

If you have questions, check [CONTRIBUTING.md](../CONTRIBUTING.md) or open a GitHub issue.
