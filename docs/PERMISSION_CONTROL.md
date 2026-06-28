# 权限管控规范 (Permission Control)

本文档是系统权限管控的**唯一权威来源**。所有涉及用户/角色管理的开发和迭代必须严格遵循本文档。文档变更需及时同步更新。

---

## 核心定义

| 术语 | 定义 | 特征 |
|------|------|------|
| **超级管理员** | `userType === "superadmin"` | 有密码，可登录，拥有最高权限 |
| **普通管理员** | `userType === "admin"` | 有密码，可登录，拥有部分管理权限 |
| **普通用户** | `userType` 非 superadmin/admin | **无密码，不可登录**，仅作为被管理实体存在 |
| **内置角色** | `superadmin`、`admin`、`user` | **禁止删除、禁止修改** |
| **自定义角色** | 非内置角色 | 超级管理员和管理员均可创建、修改、删除 |

### 多超管策略

系统允许存在多个超级管理员。**超管之间互相保护** — 任何超管不能修改或删除其他超管（包括自己以外的所有超管）。超管可以修改自身信息。

---

## 用户操作权限矩阵

| 操作 | 超级管理员 | 普通管理员 | 说明 |
|------|:---:|:---:|------|
| 创建普通用户 | ✅ | ✅ | 普通用户无密码 |
| 创建管理员用户 | ✅ | ❌ | 必须 superadmin |
| 创建超级管理员用户 | ✅ | ❌ | 必须 superadmin |
| 修改普通用户 | ✅ | ✅ | |
| 修改管理员用户 | ✅ | ❌ | 必须 superadmin |
| 修改超级管理员 | 仅自己 | ❌ | 超管之间互相保护 |
| 删除普通用户 | ✅ | ✅ | |
| 删除管理员 | ✅ | ❌ | 必须 superadmin |
| 删除超级管理员 | ❌ | ❌ | **任何人都不行，含自删** |
| 自删 | ❌ | ❌ | **任何人都不行** |
| 分配 superadmin/admin 角色 | ✅ | ❌ | 必须 superadmin |
| 分配 user/其他自定义角色 | ✅ | ✅ | |
| 轮换自己的 token | ✅ | ✅ | |
| 轮换普通用户 token | ✅ | ✅ | |
| 轮换管理员 token | ✅ | ❌ | 必须 superadmin |
| 轮换超级管理员 token | 仅自己 | ❌ | 超管之间互相保护 |
| 重置自己的密码 | ✅ | ✅ | 通过 change-password |
| 重置管理员密码 | ✅ | ❌ | 必须 superadmin |
| 重置超级管理员密码 | 仅自己 | ❌ | 超管之间互相保护 |
| 重置普通用户密码 | N/A | N/A | **普通用户无密码，此操作不适用** |

---

## 角色操作权限矩阵

| 操作 | 超级管理员 | 普通管理员 | 说明 |
|------|:---:|:---:|------|
| 创建自定义角色 | ✅ | ✅ | 名称不得为 `superadmin`/`admin`/`user` |
| 修改自定义角色 | ✅ | ✅ | |
| 修改内置角色 | ❌ | ❌ | **内置角色只读，任何人都不能修改** |
| 删除自定义角色 | ✅ | ✅ | |
| 删除内置角色 | ❌ | ❌ | **内置角色只读，任何人都不能删除** |

---

## 实现层守卫

### HTTP 层（`src/http/handlers/admin/`）

| 守卫函数 | 位置 | 作用 |
|----------|------|------|
| `enforceAdminAuth` | 全局中间件 | 验证 token，限制 `userType` 为 admin 或 superadmin |
| `requireSuperadmin(rc)` | 端点级 | 拒绝非 superadmin 调用 |
| `assertSuperadminProtected(target, operatorId)` | 端点级 | 目标是超管且非自身操作时拒绝 |
| `BUILT_IN_ROLES` | roles.handler.ts | `Set(["superadmin", "admin", "user"])`，用于保护内置角色 |

### CLI 层（`src/cli/commands/`）

CLI 命令通过 `requireAuth()` 验证登录状态，然后在命令内部按上述矩阵执行权限检查。CLI 直接操作数据库，不经过 HTTP 中间件，因此必须独立实现完整的权限校验。

---

## 验证测试用例

### 基础环境初始化

```bash
npm run build
rm -rf ~/.skill-mcp
alias skillmcp="node dist/index.js"
skillmcp init --username admin --password admin888
skillmcp auth login  # 登录超级管理员 admin
```

### 超级管理员创建管理员

```bash
skillmcp user create --username admin01 --password admin888 --user-type admin
```

### 普通管理员登录

```bash
skillmcp auth login  # 登录 admin01
```

### 普通管理员创建用户和角色

```bash
# 普通用户无密码
skillmcp user create --username user01 --user-type user
skillmcp role create --name pm --tags prd,ui,ue --description 产品经理
skillmcp role create --name dev --tags rd,fe,op,qa --description 技术研发
```

### 提取 ID

```bash
user_id=$(skillmcp user list | grep 'user01' | awk '{print $1}' | head -1)
admin_id=$(skillmcp user list | grep 'admin01' | awk '{print $1}' | head -1)
super_id=$(skillmcp user list | grep 'superadmin' | awk '{print $1}' | head -1)
user_role=$(skillmcp role list | grep -w 'user' | awk '{print $1}' | head -1)
super_role=$(skillmcp role list | grep -w 'superadmin' | awk '{print $1}' | head -1)
admin_role=$(skillmcp role list | grep -w 'admin' | grep -v 'superadmin' | awk '{print $1}' | head -1)
role_id=$(skillmcp role list | grep -E 'dev|pm' | awk '{print $1}' | head -1)
```

### TC-01: 管理员不能删除超级管理员

```bash
skillmcp user delete ${super_id}  # → 应拒绝
```

### TC-02: 管理员不能删除自己

```bash
skillmcp user delete ${admin_id}  # → 应拒绝
```

### TC-03: 管理员不能删除内置角色

```bash
skillmcp role delete ${user_role}    # → 应拒绝
skillmcp role delete ${super_role}   # → 应拒绝
skillmcp role delete ${admin_role}   # → 应拒绝
```

### TC-04: 管理员可以为普通用户授予普通角色

```bash
skillmcp user assign-roles --role-ids ${role_id} ${user_id}  # → 应成功
```

### TC-05: 删除自定义角色后用户角色为空

```bash
skillmcp role delete ${role_id}  # → 应成功
skillmcp user list               # user01 的角色应为空
```

### TC-06: 管理员可以删除普通用户

```bash
skillmcp user create --username user02 --user-type user
user02_id=$(skillmcp user list | grep 'user02' | awk '{print $1}' | head -1)
skillmcp user delete ${user02_id}  # → 应成功
skillmcp user list                  # user02 应已消失
```

### TC-07: 管理员不能创建管理员用户

```bash
skillmcp user create --username admin02 --password admin888 --user-type admin  # → 应拒绝
```

### TC-08: 管理员不能将 superadmin/admin 角色分配给用户

```bash
skillmcp user assign-roles --role-ids ${super_role} ${user_id}  # → 应拒绝
skillmcp user assign-roles --role-ids ${admin_role} ${user_id}  # → 应拒绝
```

### TC-09: 管理员可以创建自定义角色

```bash
skillmcp role create --name qa --tags testing --description 测试  # → 应成功
```

### TC-10: 管理员不能创建内置名称角色

```bash
skillmcp role create --name superadmin --tags fake --description 假的  # → 应拒绝
skillmcp role create --name admin --tags fake --description 假的      # → 应拒绝
skillmcp role create --name user --tags fake --description 假的       # → 应拒绝
```

### TC-11: 管理员可以修改自定义角色

```bash
qa_id=$(skillmcp role list | grep -w 'qa' | awk '{print $1}' | head -1)
skillmcp role update ${qa_id} --tags testing,automation  # → 应成功
```

### TC-12: 管理员不能修改内置角色

```bash
skillmcp role update ${super_role} --tags fake  # → 应拒绝
skillmcp role update ${admin_role} --tags fake  # → 应拒绝
skillmcp role update ${user_role} --tags fake   # → 应拒绝
```

### TC-13: 管理员不能轮换其他管理员的 token

```bash
skillmcp user rotate-token ${admin_id}  # → 应拒绝
```

### TC-14: 管理员不能重置超级管理员密码

```bash
skillmcp auth reset-password --username admin --password newpass123  # → 应拒绝
```

### TC-15: 普通用户无密码

```bash
# user01 已用 --user-type user 创建（无 --password），验证创建成功即可
```

### TC-16: 多超管 — 超级管理员可以创建第二个超级管理员

```bash
skillmcp auth login  # 切换回超级管理员 admin
skillmcp user create --username super02 --password admin888 --user-type superadmin  # → 应成功
```

### TC-17: 多超管 — 第二个超管不能删除第一个超管

```bash
skillmcp auth login  # 登录 super02
super02_id=$(skillmcp user list | grep 'super02' | awk '{print $1}' | head -1)
skillmcp user delete ${super_id}  # → 应拒绝: "Cannot operate on superadmin user"
# HTTP PUT /api/admin/users/${super_id} 同样返回 403 (assertCanOperateOn)
```

### TC-18: 多超管 — 第一个超管也不能删除第二个超管

```bash
skillmcp auth login  # 登录 admin (superadmin)
skillmcp user delete ${super02_id}  # → 应拒绝: "Cannot operate on superadmin user"
# HTTP PUT /api/admin/users/${super02_id} 同样返回 403 (assertCanOperateOn)
```

### TC-19: 管理员不能修改管理员用户

```bash
# HTTP 层测试（CLI 无 user update 命令）
curl -X PUT /api/admin/users/${admin_id} -H "Authorization: Bearer ${admin_token}" -d '{"name":"renamed"}'  # → 应返回 403
```

### TC-20: 超管可以修改自己，不能修改其他超管

```bash
# HTTP 层测试
curl -X PUT /api/admin/users/${super_id} -H "Authorization: Bearer ${super_token}" -d '{"name":"renamed"}'   # → 应成功（操作自己）
curl -X PUT /api/admin/users/${super02_id} -H "Authorization: Bearer ${super_token}" -d '{"name":"renamed"}'  # → 应返回 403（操作其他超管）
```

### TC-21: 管理员不能删除管理员

```bash
skillmcp user delete ${admin2_id}  # → 应拒绝: "Only superadmin can operate on admin users"
```

### TC-22: 管理员可以轮换普通用户 token

```bash
skillmcp user rotate-token ${user_id}  # → 应成功
```

### TC-23: 超管可以轮换自己 token，不能轮换其他超管 token

```bash
skillmcp user rotate-token ${super_id}     # → 应成功（轮换自己）
skillmcp user rotate-token ${super02_id}   # → 应拒绝: "Cannot operate on superadmin user"
```

### TC-24: 超管可以重置管理员密码

```bash
skillmcp auth reset-password --username admin01 --password newpass123  # → 应成功
```

### TC-25: 任何人都可以重置自己密码

```bash
# 超管重置自己
skillmcp auth reset-password --username admin --password newpass123  # → 应成功
# 管理员重置自己
skillmcp auth reset-password --username admin01 --password newpass123  # → 应成功
```

---

## 变更日志

| 日期 | Commit | 变更摘要 |
|------|--------|----------|
| 2026-06-26 | — | 初版：用户/角色权限矩阵、多超管策略、18 条验证用例 |
| 2026-06-27 | — | 统一 HTTP/CLI 错误消息；修复超管重置密码逻辑（仅自己）；修复超管操作自己逻辑（仅自己）；补充 TC-19 至 TC-25 |
