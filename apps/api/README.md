# FastAPI 后端

- Python 包：`server/`
- 依赖：`requirements.txt`
- 配置：仓库根目录 `.env`
- API 入口：`server.main:app`

从仓库根目录启动：

```powershell
.\tools\start.cmd
```

该入口不会修改系统执行策略；它只对本次 PowerShell 子进程使用 `ExecutionPolicy Bypass`。
