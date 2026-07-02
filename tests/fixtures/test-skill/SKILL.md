---
name: test-skill
description: 用于 CLI 验收的测试技能包，包含检索信号和 eval cases
version: 1.0.0
tags:
  - test
  - cli
  - verification
triggers:
  - 测试
  - test
  - 验收
when_to_use: 当需要对 skill-mcp CLI 进行功能验收时使用此技能
---

# Test Skill

这是一个用于 CLI 验收测试的技能包。

## 功能

- 验证 import 命令
- 验证 list/info/search 命令
- 验证 versions/rollback 命令
- 验证 update/remove 命令
- 验证 lint 命令
- 验证 eval 命令

## 使用方式

```bash
skillmcp import ./tests/fixtures/test-skill
skillmcp list
skillmcp info test-skill
```
