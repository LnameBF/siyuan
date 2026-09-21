# SiYuan 解锁镜像构建说明

本文档说明本仓库（fork）+ 补丁仓库组合构建解锁版 Docker 镜像的原理与流程。

> 注意：上游同步会重置整个源码树，本文档与 `.github/workflows/build-docker.yml`
> 一样由流水线在同步时自动保留（见流程图第 3 步），可放心编辑维护。

## 一、整体架构：三个仓库各司其职

| 仓库 | 内容 | 角色 |
|---|---|---|
| `siyuan-note/siyuan`（官方上游） | 思源官方源码，按版本 tag 发布 | 提供被构建的源码 |
| `LnameBF/siyuan`（本仓库，分支 master） | 官方源码 + **唯一自有改动**：WebSocket BFCache 修复 | 构建主体，流水线所在地 |
| `LnameBF/siyuan-unlock`（补丁仓库） | 只有 `.patch` 补丁文件，跟随原作者 appdev/siyuan-unlock 更新 | 构建时提供解锁补丁 |

解锁效果 = **本仓库源码（构建时）+ 补丁仓库的 4 个补丁**，两者在 CI 里组合，
互相不侵入：本仓库源码树里看不到任何解锁痕迹，补丁仓库里也没有源码。

## 二、打补丁原理

### 补丁是什么

补丁文件就是 `git diff` 输出的标准 unified diff 文本，例如 `mock-vip-user.patch`：

```diff
--- a/kernel/api/setting.go
+++ b/kernel/api/setting.go
@@ -822,18 +822,20 @@ var getPublish = contractHandler(...
 var getCloudUser = contractHandler(apicontract.GetCloudUser, ...
-	user, err := model.RefreshUser(request.Token)   # 删除：向官方云端刷新用户
+	user := &conf.User{ UserId: "0", ... }           # 插入：返回伪造的本地 VIP 用户
```

### git apply 如何工作

- 按补丁头部的**上下文行**（改动前后各几行原文）在目标文件中定位插入/删除位置；
- 行号有偏移没关系（`Hunk #1 succeeded at NNN (offset N lines)` 只是警告），
  只要上下文内容能对上就能应用；
- **一个补丁文件内任何一个 hunk 失败，整个补丁原子回滚**，不会改出一半；
- 补丁只改 CI 的临时工作区，**不提交、不留痕**，下次构建从干净源码重新来。

### 为什么"构建时打补丁"而不是直接改源码

补丁与上游版本强绑定（上下文行必须匹配）。上游几乎每版都重构，直接把解锁
改动提交进源码，每次升级都要手动解决一遍冲突；以补丁形式存在，则：

- 本仓库同步上游 = 纯粹的版本前进，永远无冲突；
- 上游版本变化导致补丁失效时，失败被隔离在"打补丁"这一步，一眼定位；
- 补丁仓库跟随原作者维护，他适配了新版本你 sync fork 即可。

### 应用顺序

```
disable-update → default-config → mock-vip-user → hide-account-entry
```

四个补丁修改的文件互不重叠，顺序理论上可换，但保持与原作者流水线一致的
固定顺序，便于对照排查。

## 三、4 个解锁补丁 + 1 个源码修复

| 名称 | 作用 |
|---|---|
| `disable-update` | 移除内核的版本更新检查（updater*.go），避免提示升级到官方版 |
| `default-config` | 修改出厂默认配置：同步默认 S3 而非官方云、生成冲突文档、界面默认中文、关闭按钮改为最小化 |
| `mock-vip-user` | 把"获取云端用户"接口替换为返回本地伪造的终身 VIP 用户（`SetUser` 持久化），并停掉定时刷新真实云端用户的任务。付费功能判定（`IsPaidUser` 等）由此全部通过 |
| `hide-account-entry` | 前端隐藏账户痕迹：设置页同步 tab 的账户分组、顶栏 VIP 入口的点击行为 |

**WebSocket BFCache 修复**（`app/src/layout/Model.ts`）不是补丁，而是直接
提交在本仓库源码里的自有改动，原因：

- 它是行为级修复（pagehide 主动断开 + beforeunload 退出 BFCache），需要随
  官方对该文件的演进而维护，做成补丁反而脆弱；
- 流水线在同步上游后，会从 git 历史中按 commit 信息（`BFCache freeze`）
  自动提取该修复并重新套用到新版本上，无需人工干预。

## 四、构建流水线（.github/workflows/build-docker.yml）

### 触发条件

| 方式 | 行为 |
|---|---|
| push 到 master | 构建当前源码 + 4 补丁 |
| 手动 Run workflow | 可填版本号（如 v3.8.4）强制同步到该版本再构建；留空构建当前代码 |
| 每日 04:30（北京时间） | 检查官方最新 release，与当前版本相同则跳过 |

### 流程

```
检出本仓库（官方源码 + WS 修复）
        │
        ├──【定时或指定版本时】上游同步：
        │     1. 官方最新 release == 当前版本 → 跳过，结束
        │     2. 从 git 历史提取 WS 修复补丁
        │     3. 源码树整体重置到上游新 tag（read-tree，保留 fork 历史）
        │        同时保留流水线文件和本文档
        │     4. 重新套用 WS 修复（幂等：已存在跳过，冲突走三方合并）
        │     5. ★预检：试套 4 个解锁补丁，任一失败 →
        │        整体回滚到同步前状态 + 警告通知，本次不构建
        │     6. 提交 "chore: sync upstream vX.Y.Z" 并推送 master
        │
        ├── 打补丁：clone 补丁仓库 → 按序 git apply 4 个补丁
        │
        ├── 构建：生成 .dockerignore 白名单 → docker build 三阶段
        │        （node 编译前端 → go 编译内核 → alpine 运行时）
        │        打 tag：v<版本号> + latest
        │
        └── 推送：登录阿里云 ACR（读 Secrets）→ 推两个 tag
             crpi-590g36lcopret480.cn-chengdu.personal.cr.aliyuncs.com/heiok_top/siyuan_unlock
```

### 预检回滚机制（关键设计）

上游新版本可能让补丁上下文失效。流水线在真正提交同步**之前**先试套全部
补丁，失败则回滚——保证 master 永远停留在"补丁可用"的版本上，线上镜像
构建链路不会被一次上游发版打断。

## 五、日常维护

### 官方发布新版本后

1. 次日定时任务自动尝试同步 + 预检；
2. 补丁兼容 → 自动完成同步、构建、推镜像，无需任何操作；
3. 补丁不兼容 → CI 打出 `::warning::` 并停在当前版本，等原作者
   （appdev/siyuan-unlock）更新补丁后，给补丁仓库 sync fork，
   下个定时周期自动跟上。

### 需要配置的 Secrets（仓库 Settings → Secrets → Actions）

- `ACR_USERNAME` / `ACR_PASSWORD`：阿里云容器镜像服务的访问凭证
  （与本地 `docker login` 相同的账号密码）

### 服务器更新

```bash
docker compose pull && docker compose up -d
```

compose 拉的是 `latest` tag；更新后浏览器需**硬刷新**（Ctrl+Shift+R），
已打开的标签页仍在执行旧版 JS。

## 六、常见问题

**Q：为什么有的补丁文件叫 account-v3.8.3.patch，现在却没有了？**
历史版本 v3.8.3 时代账户补丁按版本拆分；上游 v3.8.4 重构后原作者统一收敛
为 `hide-account-entry.patch`，版本专属补丁已删除。

**Q：CI 日志里 offset N lines 是错误吗？**
不是。只是目标行号与补丁记录的行号有偏差，上下文校验通过即正确应用。

**Q：在 Windows 本地手动构建要注意什么？**
Windows 的 git `autocrlf=true` 会把 `entrypoint.sh`/`Dockerfile` 检出为
CRLF，导致容器内 shell 报 `illegal option` / `no such file or directory`。
构建前执行 `sed -i 's/\r$//' kernel/entrypoint.sh Dockerfile`，或配置
`.gitattributes` 强制 LF（CI 的 Linux 环境无此问题）。

**Q：想临时改一下解锁行为？**
小改动：在补丁仓库对应 `.patch` 里直接改 diff 内容；涉及行为逻辑的改动
（类似 WS 修复）建议直接提交到本仓库源码，并让 commit 信息包含
`BFCache freeze` 之外的可识别关键字——流水线只自动重放 WS 修复这一个补丁。
