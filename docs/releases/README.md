# Releases

每个版本的发布范围契约（保留/移除能力、稳定契约、DB 兼容性、验收）与常青发布指南。

## 当前实现版本

**v0.1** — 纯 BM25 Skill Registry。详见 [v0.1.md](./v0.1.md)。

## 版本清单

| 版本 | 状态 | 范围契约 |
|------|------|---------|
| [v0.1](./v0.1.md) | 当前 | 本地 SQLite + local-fs、BM25 `skill_search`、同步导入、版本回滚、RBAC、stdio/SSE/Streamable HTTP、C2 远程代理 |

## 发布流程

npm 发布、版本号、GitHub Actions、回滚见 [publishing.md](./publishing.md)。

## 新增一个版本

1. 复制 `v0.1.md` 为 `v0.x.md`，更新范围契约（保留/移除清单、稳定契约、验收）。
2. 在上方「版本清单」表格新增一行，并把「当前实现版本」指针指向新版本。
3. 若引入/移除运行时能力，同步 `docs/deployment/`、`docs/cli/guide.md` 与 `CLAUDE.md` 边界描述。

> 版本范围契约按版本一文件维护；跨版本的发布机制（npm、CI）始终在 `publishing.md`，不复制到各版本文件。
