# PowerShell 启动教程（Windows）

> 这是 `START_HERE.md` 的 PowerShell 版本。命令可直接复制到 Windows PowerShell 5.1 或 PowerShell 7。
> 项目路径以当前机器为例；换机器只改第一行路径。

---

## 0. 最短启动（已装依赖）

```powershell
Set-Location "C:\path\to\relationship-agent"
docker compose up -d --wait
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

打开：

- Web：<http://localhost:5173>
- 健康检查：<http://127.0.0.1:8787/api/health>

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health | ConvertTo-Json -Compress
```

期望：

```json
{"status":"ok","db":"ok","version":"p8","time":"..."}
```

> 这里用 `npm.cmd` 而不是 `npm`，是为了绕开 PowerShell 的脚本执行策略（见第 5 节）。如果你已经放行 `npm.ps1`，用 `npm` 也可以。

---

## 1. 前置检查

```powershell
node -v
npm.cmd -v
docker --version
docker compose version
```

DeepSeek key：

```powershell
if ($env:DEEPSEEK_API_KEY) {
  "DEEPSEEK_API_KEY=SET (length $($env:DEEPSEEK_API_KEY.Length))"
} else {
  "DEEPSEEK_API_KEY=MISSING"
}
```

Docker 是否真的启动：

```powershell
docker info --format '{{.ServerVersion}}'
```

能输出一个版本号才算就绪。

如果 Docker Desktop 没启动：

```powershell
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```

等 20–60 秒，再跑 `docker info`。

---

## 2. 第一次启动

### 2.1 进入项目

```powershell
Set-Location "C:\path\to\relationship-agent"
```

### 2.2 安装依赖

```powershell
npm.cmd install
```

如果 npm 11 提示 install scripts 未审批，后续 `vite`/`tsx` 报 esbuild 错误时执行：

```powershell
npm.cmd rebuild esbuild
```

### 2.3 准备 `.env`

只在文件不存在时复制，避免覆盖你改过的配置：

```powershell
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
}
```

`DEEPSEEK_API_KEY` 不写进 `.env`，由系统环境变量提供。

### 2.4 启动数据库

```powershell
docker compose up -d --wait
docker compose ps
```

期望 `relationship-agent-db` 是 `Up ... (healthy)`。

### 2.5 建表 + seed

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
```

期望：

```text
完成，共 18 个迁移文件，本次新应用 18 个。
seed 完成：contacts=3 facts=14 events=2 memories=1
```

### 2.6 启动

```powershell
npm.cmd run dev
```

保持这个 PowerShell 窗口不要关。停止按 `Ctrl+C`。

---

## 3. 打开页面

```powershell
Start-Process "http://localhost:5173"
```

页面应显示：

- 左上角 `Relationship Agent`
- 右上角 `DB ok · p8`
- 左侧 3 个联系人：张三、李四、王五
- 中间聊天框
- 右侧记忆审核面板

---

## 4. 第一次体验

### 4.1 看记忆

1. 点左侧“张三”。
2. 右侧 `Memory Review` 显示张三的 active 长期文档。
3. 点“生成文档草案”，可批准或驳回。

### 4.2 聊天

在输入框发送：

```text
看看张三的档案，简单说下他最近的情况。
```

预期：先出现工具 chip，再流式输出张三的事实/偏好/洞察。

### 4.3 问卷 / Action Card

发送：

```text
帮我给李四约下周四上午十点，线上会议，半小时。
```

可能先出 Questionnaire，按提示回答；也可能直接出 Action Card。
确认后才写入日程；未确认零写入。

### 4.4 联网授权

发送：

```text
帮我读一下 https://example.com 的内容，用一句话总结。
```

右侧出现 Permission Card，点“允许”后继续。

---

## 5. PowerShell 特有的坑

### 5.1 `npm` 报“禁止运行脚本”

错误类似：

```text
npm.ps1 无法加载，因为在此系统上禁止运行脚本
```

两种处理：

**A. 不改系统设置（推荐先试）**：所有命令用 `npm.cmd`。

```powershell
npm.cmd run dev
```

**B. 放行当前用户的脚本**：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

这会改变当前用户的 PowerShell 执行策略；不确定就问一下自己是否接受。

### 5.2 `&&` 不能用

Windows PowerShell 5.1 不支持 `cmd1 && cmd2`。请一行一条命令：

```powershell
docker compose up -d --wait
npm.cmd run db:migrate
npm.cmd run db:seed
```

### 5.3 `curl` 不是 Linux 的 curl

PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，参数不一样。查健康检查用：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health | ConvertTo-Json -Compress
```

### 5.4 环境变量只对当前窗口生效

临时设置（当前 PowerShell 窗口）：

```powershell
$env:DEEPSEEK_API_KEY = "你的key"
```

永久设置（用户级，设置后要新开窗口）：

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "你的key", "User")
```

不要把 key 写进 `.env` 或提交到 Git。

### 5.5 路径有中文和空格

一定要加引号：

```powershell
Set-Location "C:\path\to\relationship-agent"
```

### 5.6 `docker` 命令找不到

装完 Docker Desktop 后要新开一个 PowerShell 窗口，PATH 才会刷新。还不行就重启终端/电脑。

---

## 6. 常用命令

```powershell
# 启动
npm.cmd run dev

# 只启动后端
npm.cmd run dev:server

# 只启动前端
npm.cmd run dev:web

# 迁移 / seed
npm.cmd run db:migrate
npm.cmd run db:seed

# 测试
npm.cmd test
npm.cmd run test:db

# 评测
npm.cmd run eval

# 类型检查 / 构建
npm.cmd run typecheck
npm.cmd run build

# 数据库状态 / 日志
docker compose ps
docker compose logs -f postgres
```

---

## 8. 评测

```powershell
npm.cmd run eval
```

- 用 faux provider，不花 DeepSeek 的钱。
- 40 条 × 3 复跑 = 120 run。
- 只重置 `relationship_test`，不动开发库。
- 报告：`evals\runs\<timestamp>\report.md`。

---

## 9. 停止与重置

停止应用：

```text
在 npm.cmd run dev 的窗口按 Ctrl+C
```

停止数据库（保留数据）：

```powershell
docker compose stop
```

删除容器但保留数据：

```powershell
docker compose down
```

彻底重置数据库（**会删数据**，确认后再执行）：

```powershell
docker compose down -v
docker compose up -d --wait
npm.cmd run db:migrate
npm.cmd run db:seed
```

只重置开发库结构（**会删 public schema**）：

```powershell
npm.cmd run db:migrate:reset --workspace @relationship-agent/server
npm.cmd run db:seed
```

---

## 10. 常见问题速查

| 现象 | 处理 |
|---|---|
| `dockerDesktopLinuxEngine` 连不上 | 启动 Docker Desktop，等鲸鱼图标稳定 |
| `ERROR_NO_SYSTEM_RESOURCES` | 关 Edge/微信、`wsl --shutdown`、重启 Docker；不行就重启电脑 |
| 拉不到 `postgres:16-alpine` | 用 DaoCloud 镜像拉取再打 tag（见下） |
| 8787 被占用 | `Get-NetTCPConnection -LocalPort 8787 -State Listen`，找到进程后停掉，或改 `.env` 的 `PORT` |
| 5173 被占用 | Vite 会自动换到 5174，以终端输出为准 |
| `relation "..." does not exist` | `npm.cmd run db:migrate` |
| `database "relationship_test" does not exist` | `docker exec relationship-agent-db createdb -U relationship relationship_test` |
| 密码认证失败 | `compose.yaml` 和 `.env` 的 user/password/db 必须一致 |
| `npm.ps1` 禁止运行 | 用 `npm.cmd`，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |

Docker Hub 超时：

```powershell
docker pull docker.m.daocloud.io/library/postgres:16-alpine
docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine
docker compose up -d --wait
```

---

## 11. 最短验收

```powershell
docker compose ps
npm.cmd run db:migrate
npm.cmd run db:seed
Invoke-RestMethod http://127.0.0.1:8787/api/health | ConvertTo-Json -Compress
npm.cmd test
npm.cmd run test:db
npm.cmd run eval
```

全部通过，再打开 <http://localhost:5173> 走一遍聊天、问卷、Action Card、联网授权、记忆审核。
