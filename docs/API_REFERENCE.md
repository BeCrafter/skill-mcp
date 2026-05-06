# MCP Tools API Reference

This document provides a complete reference for the three MCP tools exposed by skill-mcp: `skill_list`, `skill_view`, and `skill_file`. These tools implement the model compliance architecture described in [tech-dev-program.md](./tech-dev-program.md) Section 3.

---

## 1. skill_list

**Purpose**: Retrieve the complete list of available skills in the system.

This is the entry point for skill discovery. The model must scan this list on every response to identify potentially relevant skills.

### Parameters

None

### Response Format

Plain text list, one skill per line:

```
- slug-1 [id:uuid-1]: Brief one-line description (max 80 chars)
- slug-2 [id:uuid-2]: Another skill description
- slug-3 [id:uuid-3]: Yet another skill
```

### Example

**Request** (MCP JSON-RPC):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "skill_list",
    "arguments": {}
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "- prompt-writer [id:550e8400-e29b-41d4-a716-446655440000]: Professional prompt writing and optimization\n- code-review [id:550e8400-e29b-41d4-a716-446655440001]: Code review and debugging assistance\n- technical-doc [id:550e8400-e29b-41d4-a716-446655440002]: Technical documentation writing"
      }
    ]
  }
}
```

### Compliance Requirements

- **Must be called frequently**: The model should scan this list before every response
- **Must include slug and id**: Each skill entry includes both `slug` (for stable reference) and `id` (UUID for internal lookup)
- **Description quality matters**: Brief, action-oriented descriptions help with semantic matching
- **Mandatory keyword**: System prompt includes "mandatory" to enforce scanning

### Implementation Notes

- `slug` format: kebab-case, URL-safe, unique
- `id` format: UUID v4
- Description: Truncated to 80 characters if longer
- Only includes `status: "published"` skills
- Results are cached (TTL: typically 5-10 minutes)

---

## 2. skill_view

**Purpose**: Load the complete skill instructions (SKILL.md) for a specific skill.

This is the primary interface for skill execution. The model must call this tool FIRST before attempting to use any skill.

### Parameters

Either `skill_slug` OR `skill_id` (exactly one):

| Parameter | Type | Required | Format | Notes |
|-----------|------|----------|--------|-------|
| `skill_slug` | string | Yes (unless id provided) | kebab-case | Preferred for stable references |
| `skill_id` | string | Yes (unless slug provided) | UUID v4 | From skill_list response |

### Response Format

Multi-part response combining:
1. **System guidance** (activated on tool call)
2. **Complete skill instructions** (SKILL.md content)
3. **File listing** (available supporting files)

### Example

**Request** (by slug):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "skill_view",
    "arguments": {
      "skill_slug": "prompt-writer"
    }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[SYSTEM: User is using \"prompt-writer\" skill. Below is complete instruction, follow strictly.]\n\n# Prompt Writer\n\n## Trigger Conditions\nWhen user asks to: create prompt / optimize prompt / evaluate prompt\n\n## Execution Steps (MUST follow strictly)\n1. Use CRISPE framework (see references/crispe-framework.md)\n2. Draft prompt following framework structure\n3. Self-check using templates/checklist.md\n\n## Known Pitfalls\n- Do NOT start with \"you are\"\n- Do NOT over-constrain\n\n[Available supporting files: references/crispe-framework.md, templates/checklist.md]\n[Tip: Use skill_file(\"prompt-writer\", [\"references/crispe-framework.md\", \"templates/checklist.md\"]) to batch-load files]"
      }
    ]
  }
}
```

### Alternative (by id):
```json
{
  "arguments": {
    "skill_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Compliance Requirements

- **Activation guidance injection**: Response includes `[SYSTEM: ...]` prefix to reinforce instruction adherence
- **Security scanning**: SKILL.md content is scanned for injection patterns before returning
- **File tree listing**: Supporting files are enumerated to guide the model's `skill_file` calls
- **Strict instruction format**: All SKILL.md files must include:
  - Trigger Conditions
  - Execution Steps (numbered, in order)
  - Known Pitfalls (do/don't rules)

### Implementation Notes

- Response is wrapped with activation guidance (system message format)
- File tree includes only files actually in the package
- Security scan uses pattern matching for common injection attempts
- Cached (TTL: typically 10-30 minutes)

---

## 3. skill_file

**Purpose**: Batch-load supporting files from a skill package (references, templates, scripts).

This tool MUST be called with multiple file paths when the skill_view instructions reference them. It supports concurrent file loading.

### Parameters

| Parameter | Type | Required | Format | Notes |
|-----------|------|----------|--------|-------|
| `skill_slug` | string | Yes | kebab-case | From skill_list or skill_view |
| `file_paths` | string[] | Yes | Array of paths | E.g., `["references/framework.md", "templates/checklist.md"]` |

### Response Format

Array of file content objects, one per requested file:

```typescript
[
  {
    type: "text",          // For .md, .txt, .json, etc.
    text: "# File content..."
  },
  {
    type: "text",
    text: "## Another file..."
  },
  {
    type: "image",         // For .png, .jpg, .gif, etc.
    mimeType: "image/png",
    text: "iVBORw0KGgoAAAANS...base64-encoded..."
  }
]
```

### Example

**Request** (batch multiple files):
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "skill_file",
    "arguments": {
      "skill_slug": "prompt-writer",
      "file_paths": [
        "references/crispe-framework.md",
        "references/create-framework.md",
        "templates/checklist.md"
      ]
    }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# CRISPE Framework\n\n**C** = Clarity\n**R** = Role\n..."
      },
      {
        "type": "text",
        "text": "# CREATE Framework\n\n**C** = Context\n**R** = Role\n..."
      },
      {
        "type": "text",
        "text": "# Self-Check Checklist\n\n- [ ] Clarity\n- [ ] Role\n..."
      }
    ]
  }
}
```

### Compliance Requirements

- **Batch loading**: Pass multiple paths in ONE call (not separate calls)
- **Only referenced files**: Load only files explicitly mentioned in skill_view instructions
- **File path validation**: Paths must be relative and cannot contain `..` or `/` traversal patterns
- **Permission-based access**: User must have permission to access the skill before file loading
- **Security scan**: Files are scanned for injection patterns

### Optimization

- Concurrent loading: All paths loaded in parallel (Promise.all)
- Text file caching: .md, .txt, .json files cached (TTL: 5-10 minutes)
- Binary file streaming: .png, .jpg, .gif, .mp4 etc. returned as base64
- Cache hit performance: Repeated file access returns cached results

### Implementation Notes

- File list is pre-validated against manifest.json files list
- Non-existent files return error 404
- Oversized files (>10MB) may be rejected or streamed
- Base64 encoding adds ~33% size overhead (plan accordingly)

---

## 4. Admin API Endpoints

These endpoints are for internal management and server administration. They are NOT authenticated by default.

### GET /api/admin/skills

List all available skills with pagination.

**Request**:
```bash
curl http://localhost:3000/api/admin/skills?offset=0&limit=50
```

**Response**:
```json
{
  "success": true,
  "data": [
    { "id": "...", "slug": "prompt-writer", "name": "prompt-writer", "version": "0.0.1" }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50
}
```

### GET /api/admin/skills/{slug}

Get a specific skill by slug.

**Response**:
```json
{
  "success": true,
  "data": { "id": "...", "slug": "prompt-writer", "name": "...", "description": "..." }
}
```

### PUT /api/admin/skills/{slug}

Update skill metadata.

**Request**:
```bash
curl -X PUT http://localhost:3000/api/admin/skills/prompt-writer \
  -H "Content-Type: application/json" \
  -d '{"category": "writing", "tags": ["prompt", "ai"]}'
```

### DELETE /api/admin/skills/{slug}

Delete a skill and its files.

### POST /api/admin/skills

Import a new skill from a source path.

**Request**:
```bash
curl -X POST http://localhost:3000/api/admin/skills \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/skill", "category": "writing"}'
```

### GET /api/admin/skills/{slug}/entry

Get the entry file (SKILL.md) content.

**Response**: Raw markdown content

### POST /api/admin/skills/{slug}/files

Batch-read multiple skill files.

**Request**:
```bash
curl -X POST http://localhost:3000/api/admin/skills/prompt-writer/files \
  -H "Content-Type: application/json" \
  -d '{"paths": ["references/crispe-framework.md", "templates/checklist.md"]}'
```

### GET /api/admin/skills/{slug}/file-tree

Get the file tree structure of a skill.

### GET /api/admin/skills/name/{name}

Search skills by name.

### GET /api/admin/logs

Get access logs for a skill.

**Request**:
```bash
curl http://localhost:3000/api/admin/logs?skill_slug=prompt-writer&limit=50
```

### GET /api/admin/stats

Get server statistics.

**Response**:
```json
{
  "success": true,
  "data": { "totalSkills": 5 }
}
```

### GET /api/health

Health check endpoint (legacy, for backward compatibility).

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-04-29T10:00:00.000Z"
}
```

---

## 5. Gateway API Endpoints

These endpoints are used by `RemoteProvider` when running in `DEPLOYMENT_MODE=gateway`. They mirror the MCP tools but use HTTP REST instead of JSON-RPC.

### Authentication

All Gateway endpoints require API Key authentication:

```bash
Authorization: Bearer YOUR_API_KEY
```

### GET /api/gateway/skills

List all available skills (equivalent to `skill_list` MCP tool).

**Request**:
```bash
curl -H "Authorization: Bearer api-key" \
  http://storage:3000/api/gateway/skills
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "slug": "prompt-writer",
      "description": "Professional prompt writing and optimization"
    }
  ]
}
```

### GET /api/gateway/skills/{slug}

Get skill metadata and entry file content.

**Request**:
```bash
curl -H "Authorization: Bearer api-key" \
  http://storage:3000/api/gateway/skills/prompt-writer
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "slug": "prompt-writer",
    "name": "prompt-writer",
    "description": "Professional prompt writing...",
    "version": "0.0.1",
    "entry": "# Prompt Writer\n\n## Trigger Conditions..."
  }
}
```

### POST /api/gateway/skills/{slug}/files

Batch-read supporting files from a skill.

**Request**:
```bash
curl -X POST \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "paths": [
      "references/crispe-framework.md",
      "templates/checklist.md"
    ]
  }' \
  http://storage:3000/api/gateway/skills/prompt-writer/files
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "path": "references/crispe-framework.md",
      "type": "text",
      "content": "# CRISPE Framework\n\n**C** = Clarity..."
    },
    {
      "path": "templates/checklist.md",
      "type": "text",
      "content": "# Self-Check Checklist\n\n- [ ] Clarity..."
    }
  ]
}
```

---

## Error Handling

### Common Errors

| Status | Scenario | Message |
|--------|----------|---------|
| 401 | Missing/invalid API key | `"error": "Invalid or missing API key"` |
| 404 | Skill not found | `"error": "Skill 'invalid-slug' not found"` |
| 400 | Invalid file path (traversal) | `"error": "Invalid file path"` |
| 500 | Server error | `"error": "Internal server error"` |

### Error Response Format

```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

---

## Performance Characteristics

| Operation | Typical Latency | Cached? | Notes |
|-----------|-----------------|---------|-------|
| skill_list | <100ms | Yes (5-10m) | Fast index scan |
| skill_view | 50-500ms | Yes (10-30m) | First call slower |
| skill_file (1 file) | 10-100ms | Yes (5-10m) | Cached after first call |
| skill_file (3 files) | 30-150ms | Yes (5-10m) | Parallel loading |
| /api/gateway/* | ~50ms | Yes | HTTP overhead minimal |

---

## Version Compatibility

- **MCP Protocol**: 2024-11-05 and later
- **Node.js**: >= 22
- **API Stability**: Stable (backward compatible)

---

## See Also

- [tech-dev-program.md](./tech-dev-program.md) - Detailed design rationale
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - How to test skill operations
- [CODE_REVIEW_FINDINGS.md](../CODE_REVIEW_FINDINGS.md) - Security considerations
