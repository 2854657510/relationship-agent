# 启动教程（Windows + Git Bash）

> 用 PowerShell？看 [START_HERE_POWERSHELL.md](./START_HERE_POWERSHELL.md)。
>
> 目标：从零把项目跑起来，并走通“聊天 → 追问 → Action Card → 确认 → 回执 → 洞察 → 记忆审核”。
> 适用：Windows 10/11，已装 Node.js 22+、Docker Desktop、Git Bash。
> 路径以当前机器为例：`C:\path\to\relationship-agent`。换机器只改这个路径。

---

## 0. 五条命令（已经装好依赖时）

```bash
cd "/path/to/relationship-agent"
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

然后打开：

- Web：<http://localhost:5173>
- 健康检查：<http://127.0.0.1:8787/api/health>

健康检查应返回：

```json
{ "status": "ok", "db": "ok", "version": "p8", "time": "..." }
```

---

## 1. 前置检查

在 Git Bash 里逐条跑：

```bash
node -v          # 需要 >= 22
npm -v
docker --version
docker compose version
```

DeepSeek key（不要把值打印出来）：

```bash
if [ -n "$DEEPSEEK_API_KEY" ]; then echo "DEEPSEEK_API_KEY=SET"; else echo "DEEPSEEK_API_KEY=MISSING"; fi
```

- 显示 `SET` 才能真实调用模型。
- 没有 key 也能启动、跑评测，但聊天会失败。
- key 放在**系统环境变量**里，不写进 `.env`。

Docker Desktop 必须真的启动（不是只装好）：

```bash
docker info --format '{{.ServerVersion}}'
```

能输出一个版本号才算就绪。

---

## 2. 第一次启动

### 2.1 进入项目

```bash
cd "/path/to/relationship-agent"
```

### 2.2 安装依赖

```bash
npm install
```

- 这是 npm workspaces，会同时装 `server` 和 `web`。
- 看到 `added ... packages` 就正常。
- npm 11 可能提示有 install scripts 未审批；如果后面 `vite` 或 `tsx` 报 esbuild 错误，执行 `npm rebuild esbuild`。

### 2.3 准备环境变量

```bash
cp .env.example .env
```

`.env` 默认值已经对准 Compose：

```dotenv
DATABASE_URL=postgres://relationship:relationship@localhost:5432/relationship
TEST_DATABASE_URL=postgres://relationship:relationship@localhost:5432/relationship_test
PORT=8787
PI_PROVIDER=deepseek
PI_MODEL=deepseek-flash
```

`DEEPSEEK_API_KEY` 不写进 `.env`，由系统环境变量提供。

### 2.4 启动数据库

```bash
docker compose up -d --wait
```

期望：

```text
Container relationship-agent-db  Healthy
```

检查：

```bash
docker compose ps
```

应该看到 `relationship-agent-db` 是 `Up ... (healthy)`。

> 如果 Docker Hub 拉取超时，见第 8 节“拉不到 postgres 镜像”。

### 2.5 建表和种子数据

```bash
npm run db:migrate
npm run db:seed
```

期望：

```text
应用 001_extensions.sql
...
应用 018_thread_compaction_cutoff.sql
完成，共 18 个迁移文件，本次新应用 18 个。
seed 完成：contacts=3 facts=14 events=2 memories=1
```

再跑一次 `npm run db:migrate` 应该全部“跳过”，说明幂等。

### 2.6 启动服务

```bash
npm run dev
```

会同时起：

- server：<http://127.0.0.1:8787>
- web：<http://localhost:5173>

保持这个终端不要关。要停就按 `Ctrl+C`。

---

## 3. 第一次打开页面

浏览器打开 <http://localhost:5173>。

你应该看到：

- 左上角 `Relationship Agent`
- 右上角 `DB ok · p8`
- 左侧 3 个联系人：张三、李四、王五
- 中间聊天框
- 右侧“选择一个联系人，查看和审核他的长期记忆”

如果页面打不开：

1. 看 `npm run dev` 的终端有没有报错。
2. 直接访问 <http://127.0.0.1:8787/api/health>，确认后端活着。
3. 端口被占用见第 8 节。

---

## 4. 走一遍核心流程

### 4.1 看联系人记忆

1. 点左侧“张三”。
2. 右侧 `Memory Review` 会加载张三的 active 长期文档。
3. 点“生成文档草案”，会生成一份 draft；可以批准或驳回。

### 4.2 聊天 + 工具调用

在输入框发送：

```text
看看张三的档案，简单说下他最近的情况。
```

预期：

- 先出现 `get_contact_profile` 之类的工具 chip。
- 然后流式输出回答，包含张三的公司/职位/偏好/洞察。
- 回答里会区分“已确认事实”和“推断”。

### 4.3 问卷追问

发送：

```text
帮我给李四约下周四上午十点，线上会议，半小时。
```

预期可能有两种：

- 直接出 Action Card；
- 或先弹 Questionnaire（例如确认时间/是否创建）。按提示回答，提交后继续。

### 4.4 Action Card + 回执 + 洞察

如果出现 Action Card：

1. 看类型、时间、联系人、理由、证据 ID。
2. 点“确认执行”。
3. 看到 receipt（success）和 Insight 状态。
4. 右侧/联系人页可以看到新建的日程。

**未确认之前不会写联系人/日历**；这是项目的核心约束。

### 4.5 联网授权

发送：

```text
帮我读一下 https://example.com 的内容，用一句话总结。
```

预期：

- 右侧出现 Permission Card。
- 点“允许”。
- 服务继续读取网页并回答。
- 网页内容会被当作不可信材料。

---

## 5. 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时起 server + web |
| `npm run dev:server` | 只起后端 |
| `npm run dev:web` | 只起前端 |
| `npm run db:migrate` | 应用新迁移，已应用的跳过 |
| `npm run db:seed` | 幂等写入种子数据 |
| `npm test` | 单元测试，不连库 |
| `npm run test:db` | 数据库集成测试，会重置 `relationship_test` |
| `npm run eval` | 40 条评测 × 3 复跑，写 `evals/runs/` |
| `npm run typecheck` | server + web 类型检查 |
| `npm run build` | 构建 Web |
| `docker compose ps` | 看数据库状态 |
| `docker compose logs -f postgres` | 看数据库日志 |

---

## 7. 评测怎么跑

```bash
npm run eval
```

特点：

- 用 `fauxProvider` 模拟模型，不花 DeepSeek 的钱。
- 40 条用例 × 3 复跑 = 120 run。
- 只重置 `relationship_test`，不动开发库。

输出：

```text
evals/runs/<timestamp>/report.json
evals/runs/<timestamp>/report.md
evals/runs/<timestamp>/traces/*.json
```

当前基线：

- 稳定通过 40/40
- 单次通过 120/120
- 模拟一致率 97.5%（`calibration: "simulated"`，不是人工一致率）

如果某条失败，先看对应的 `traces/<case>-1.json`，里面有 run 状态、工具、Action、失败原因。

---

## 8. 常见问题

### 8.1 Docker 报 `dockerDesktopLinuxEngine` 连不上

说明 Docker Desktop 没启动。

1. 打开 Docker Desktop。
2. 等鲸鱼图标稳定。
3. 再跑 `docker info`。

### 8.2 Docker 报 `Wsl/Service/CreateInstance/CreateVm/HCS/ERROR_NO_SYSTEM_RESOURCES`

WSL 创建 Docker VM 时内存不够。

处理顺序：

1. 关掉 Edge/微信等占内存的应用。
2. `wsl --shutdown`，再启动 Docker Desktop。
3. 还不行就重启 Windows。
4. 可选（会影响所有 WSL 发行版）：在 `C:\Users\<你>\.wslconfig` 限制内存，例如 `[wsl2] memory=4GB`，然后 `wsl --shutdown`。

### 8.3 拉不到 `postgres:16-alpine`

Docker Hub 超时。用 DaoCloud 镜像：

```bash
docker pull docker.m.daocloud.io/library/postgres:16-alpine
docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine
docker compose up -d --wait
```

### 8.4 端口被占用

- 5432：本机已有 Postgres。改 `compose.yaml` 的宿主端口，并同步改 `.env` 的 `DATABASE_URL`。
- 8787：后端端口冲突。`Get-NetTCPConnection -LocalPort 8787` 找到进程，或改 `.env` 的 `PORT`。
- 5173：Vite 会自动换到 5174；以终端输出为准。代理仍然指向 8787。

### 8.5 报 `DEEPSEEK_API_KEY` 相关错误

- 确认启动服务的同一个终端/系统环境里有这个变量。
- 改完环境变量要重启 `npm run dev`。
- 没有 key 时，UI 和评测仍能跑，但真实对话会失败。

### 8.6 报 `relation "..." does not exist`

迁移没跑：

```bash
npm run db:migrate
```

### 8.7 评测报 `database "relationship_test" does not exist`

测试库没建。非破坏性补建：

```bash
docker exec relationship-agent-db createdb -U relationship relationship_test
```

然后重跑 `npm run test:db`。

### 8.8 数据库密码不对

`compose.yaml` 和 `.env` 必须一致：

- 用户：`relationship`
- 密码：`relationship`
- 库：`relationship`

改完 `docker compose down`（保留 volume）再 `up -d --wait`。

### 8.9 Web 页面空白 / 控制台 404

- 确认 `npm run dev` 两个进程都起来了。
- 浏览器强刷 `Ctrl+F5`。
- 看终端有没有 Vite 报错。

---

## 9. 停止与重置

### 停止应用

在 `npm run dev` 的终端按 `Ctrl+C`。

### 停止数据库（保留数据）

```bash
docker compose stop
```

### 删除容器但保留数据

```bash
docker compose down
```

### 彻底重置数据库（**会删数据**）

先确认你不需要现有数据，再执行：

```bash
docker compose down -v
docker compose up -d --wait
npm run db:migrate
npm run db:seed
```

### 重置开发库结构（**会删 public schema**）

```bash
npm run db:migrate --workspace @relationship-agent/server -- --reset
npm run db:seed
```

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| `README.md` | 项目概览、API、脚本 |
| `START_HERE.md` | 本教程 |
| `SPEC.md` | 设计规格与边界 |
| `AGENT_DESIGN.md` | 实现架构、取舍、限制 |
| `VERIFICATION.md` | 实际跑过的验证记录 |

---

## 11. 最短验收清单

- [ ] `docker compose ps` 是 healthy
- [ ] `npm run db:migrate` 18 个迁移
- [ ] `npm run db:seed` 3/14/2/1
- [ ] `/api/health` 返回 `status=ok, db=ok, version=p8`
- [ ] 页面能看到 3 个联系人
- [ ] 发送“看看张三的档案”能收到回答
- [ ] 能看到一次 Questionnaire 或 Action Card
- [ ] `npm test` / `npm run test:db` / `npm run eval` 通过

全部打勾，环境就通了。
