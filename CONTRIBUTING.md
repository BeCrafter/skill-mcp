# Contributing to Skill MCP

Thank you for your interest in contributing! This guide explains how to set up your development environment, follow our coding standards, and submit your work.

## 📋 Quick Start (5 minutes)

### 1. Clone and Setup

```bash
git clone https://github.com/BeCrafter/skill-mcp.git
cd skill-mcp
npm install
npm run build
npm start
```

### 2. Verify Your Setup

```bash
npm run lint    # Should pass
npm test        # Should pass
npm run test:coverage  # Optional coverage report
```

### 3. Create a Feature Branch

```bash
git checkout dev                           # Start from dev branch
git checkout -b feature/your-feature-name  # Create feature branch
```

## 🌳 Branch Strategy

We use a branching strategy to keep development organized:

```
main
  ↑ (merge from dev for releases)
  │
dev (integration branch)
  ↑ (merge from feature branches)
  ├── feature/add-skill-batch-import
  ├── feature/improve-cache-performance
  ├── bugfix/fix-path-traversal
  └── ...
```

### Branch Naming Conventions

- **Feature branches**: `feature/short-description`
  - Example: `feature/add-skill-batch-import`, `feature/improve-error-handling`
  
- **Bugfix branches**: `bugfix/short-description`
  - Example: `bugfix/fix-path-traversal`, `bugfix/fix-concurrent-access`
  
- **Chore branches**: `chore/short-description`
  - Example: `chore/update-dependencies`, `chore/improve-ci`

## 💻 Code Style and Standards

### ESLint and Formatting

Our project uses ESLint for code quality checks. Before committing:

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

### TypeScript Strict Mode

- All code must pass `strict: true` TypeScript checks
- No `any` types without lint warnings
- Use explicit types for public APIs

### Naming Conventions

- **Functions**: camelCase
  - `getUserSkills()`, `calculateStoragePath()`
  
- **Classes**: PascalCase
  - `SkillRepository`, `LocalStorageProvider`
  
- **Constants**: UPPER_SNAKE_CASE
  - `MAX_CACHE_SIZE`, `DEFAULT_PORT`
  
- **Files**: kebab-case for utilities, PascalCase for classes
  - `skill.repository.ts`, `SkillService.ts`

## ✍️ Commit Message Format

We follow conventional commits for clear, semantic commit messages.

### Format

```
<type>: <subject>

<body (optional)>

<footer (optional)>
```

### Types

- **feat**: New feature or enhancement
- **fix**: Bug fix
- **docs**: Documentation changes (README, guides, etc.)
- **test**: Adding or updating tests
- **perf**: Performance improvements
- **refactor**: Code restructuring (no feature/fix change)
- **chore**: Build tools, CI configuration, dependencies

### Examples

✅ Good commit messages:
```
feat: add skill batch import with progress tracking

fix: correct storage path calculation for nested skills

docs: update deployment guide for scenario C2

test: add compliance metrics test framework

perf: optimize cache lookup for frequently accessed skills

chore: upgrade eslint to v9.21
```

❌ Bad commit messages:
```
update              # Too vague
fix stuff           # Unclear what was fixed
add feature         # Missing specifics
WIP                 # Not a final commit message
as per review       # Not self-contained
```

### Writing Good Commit Messages

- **Subject line** (max 50 chars)
  - Use imperative mood ("add", not "added" or "adds")
  - Don't end with a period
  - Start with type prefix (feat, fix, docs, etc.)

- **Body** (wrap at 72 chars)
  - Explain WHAT and WHY, not HOW
  - Include relevant issue numbers
  - Separate from subject with blank line

- **Example with body**:
```
feat: add skill batch import with progress tracking

Implement batch import feature allowing users to import multiple
skills at once with real-time progress updates. Uses streaming
API to avoid timeout on large imports.

Fixes #123
Related to #456
```

## 🧪 Testing Requirements

### Test Types

- **Unit tests**: Test individual functions/classes in isolation
  - Location: `tests/unit/`
  - Run: `npm test`

- **Integration tests**: Test component interactions
  - Location: `tests/integration/`
  - Run: `npm test`

- **E2E tests**: Test complete workflows
  - Location: `tests/e2e/`
  - Run: `npm test`

### Writing Tests

1. **Always add tests for new features**
   ```bash
   npm test                              # Run all tests
   npx vitest run tests/unit/services/   # Run specific directory
   npx vitest run -t "skill list"        # Run tests matching pattern
   ```

2. **Test both happy path and error cases**
   ```typescript
   describe("createSkill", () => {
     it("should create skill with valid input", () => {
       // Happy path
     });
     
     it("should reject duplicate skill names", () => {
       // Error case
     });
   });
   ```

3. **Aim for >80% coverage**
   ```bash
   npm run test:coverage
   ```

## 📝 Pull Request Process

### Before Submitting PR

1. **Update your branch**
   ```bash
   git fetch origin dev
   git rebase origin/dev
   ```

2. **Run full test suite**
   ```bash
   npm run lint
   npm run build
   npm test
   npm run test:coverage
   ```

3. **Update documentation** if needed
   - Update API docs for new endpoints
   - Update README if user-facing behavior changed
   - Add CHANGELOG entry for significant changes

### Creating a PR

1. Push your branch
   ```bash
   git push origin feature/your-feature-name
   ```

2. Create PR on GitHub with:
   - **Title**: Short, descriptive (same as commit message)
   - **Description**: 
     - What problem does this solve?
     - How does it work?
     - Any testing notes?
   - **Checklist**: Verify all items before submitting

### PR Checklist Template

```markdown
## PR Description
Brief explanation of changes

## Problem Solved
- [ ] Fixes issue #123
- [ ] Implements feature #456

## Changes
- [ ] New feature
- [ ] Bug fix
- [ ] Documentation
- [ ] Refactoring

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests passed
- [ ] E2E tests verified
- [ ] Manual testing completed

## Quality
- [ ] Code follows project style
- [ ] ESLint: `npm run lint` passed
- [ ] TypeScript: `npm run build` passed
- [ ] All tests: `npm test` passed
- [ ] Documentation updated
- [ ] Commit messages follow convention

## Deployment Notes
(If applicable, describe deployment impact)
```

### Code Review Process

1. **At least 1 approval required** before merge
2. **Automated checks must pass**:
   - GitHub Actions CI (lint, test, build)
   - Code coverage requirements
3. **Address review comments**:
   - Don't force-push during review (it clears discussion)
   - Reply to comments to explain changes
   - Request re-review after making changes
4. **Maintainers merge** when approved and CI passes

## 🚀 Release and Versioning

### Semantic Versioning

We follow [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0): Breaking API changes
- **MINOR** (0.X.0): New features (backward compatible)
- **PATCH** (0.0.X): Bug fixes (backward compatible)

### Release Process

1. **Prepare release branch**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b release/v0.0.1
   ```

2. **Update version**
   - Update `package.json` version
   - Update `CHANGELOG.md`
   - Commit: `chore: bump version to 0.0.1`

3. **Merge to main**
   ```bash
   git checkout main
   git merge --no-ff release/v0.0.1
   git tag -a v0.0.1 -m "Release v0.0.1"
   git push origin main --tags
   ```

4. **Merge back to dev**
   ```bash
   git checkout dev
   git merge --no-ff release/v0.0.1
   git push origin dev
   ```

## 🔍 Code Review Guidelines

### What We Look For

✅ **Positive signals**:
- Clear, focused changes (one feature per PR)
- Good test coverage
- Follows project conventions
- Thoughtful error handling
- Well-documented code (especially complex logic)
- Performance considered

❌ **Concerns**:
- Large PRs (break into smaller chunks)
- Missing or inadequate tests
- No error handling
- Breaking changes without deprecation
- Performance implications not discussed
- Inconsistent with project style

### Questions for Reviewers

- Does this solve the problem?
- Is the approach reasonable?
- Are there edge cases not handled?
- Is performance acceptable?
- Are tests adequate?
- Does documentation need updates?

## 📚 Additional Resources

- **System Architecture**: See [CLAUDE.md](./CLAUDE.md) for design & architecture
- **Configuration**: See [.env.example](./.env.example) for environment setup
- **Development Workflow**: See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)
- **API Reference**: See [docs/API_REFERENCE.md](./docs/API_REFERENCE.md) for MCP tools
- **Testing Framework**: See [docs/TESTING_GUIDE.md](./docs/TESTING_GUIDE.md)
- **Project Organization**: See [docs/ORGANIZATION.md](./docs/ORGANIZATION.md) for code structure

## ❓ Questions?

- **Issues**: Use GitHub Issues for bug reports and feature requests
- **Discussions**: Use GitHub Discussions for general questions
- **Pull Requests**: Comment on PRs for specific code feedback

## ✍️ Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin (DCO)](https://developercertificate.org/) — a lightweight alternative to a CLA. Every commit must be signed off, certifying that you have the right to submit it under the project's open source license.

### How to sign off

Add `-s` (or `--signoff`) to every `git commit`:

```bash
git commit -s -m "feat: add foo"
```

This appends a line to your commit message:

```
Signed-off-by: Random J Developer <random@developer.example.org>
```

The name and email **must match** your git `user.name` / `user.email` config.

### Why DCO

- **No paperwork**: unlike a CLA, there is nothing for you to sign offline.
- **Per-commit attestation**: each commit individually certifies the DCO terms (full text at https://developercertificate.org/).
- **Standard practice**: used by Linux kernel, Docker, GitLab, Kubernetes, and many CNCF projects.

### What if I forget?

If you forget on a commit during a feature branch, amend it before pushing:

```bash
git commit --amend -s --no-edit
```

For an entire range of commits already pushed, rebase and add sign-offs:

```bash
git rebase HEAD~N --signoff   # N = number of commits to fix
git push --force-with-lease
```

CI will reject PRs whose commits are not all signed off.

## 📜 License

By contributing, you agree that your contributions will be licensed under the project's current license (currently MIT; see [`docs/ADVANCED/LICENSING.md`](./docs/ADVANCED/LICENSING.md) for the planned BUSL-1.1 transition policy).

The DCO sign-off above is your attestation that you have the right to submit your contribution under that license.

---

**Thank you for contributing! 🙏**

Your efforts help make skill-mcp better for everyone. Whether it's code, tests, documentation, or ideas, we appreciate your participation.
