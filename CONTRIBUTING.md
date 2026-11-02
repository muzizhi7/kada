# Contributing / 参与开发

先读[项目范围](SPEC.md)和[项目约束](AGENTS.md)。模型、循环、工具、会话、持久化、重试、压缩与恢复复用Pi；新能力优先使用配置、标准Skills、extension和薄适配。真实computer-use继续关闭。

使用Node24.7或更高版本，运行：

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=moderate
```

`check`包含类型检查、全部产品测试、构建和提交候选文件检查。普通测试使用脚本化模型，不需要API Key。macOS原生入口另外运行`npm run test:pet`，会使用隔离目录测试输入、定制、首次发现和真实进程重开；它需要已登录的桌面。CI配置Linux/macOS产品检查和macOS编译，交互测试由本机完成。

目标任务、配置、凭据和首次扫描结果留在本机，勿提交`.env`、`harness.config.json`或`.harness/`。`check:commit`检查Git候选路径及常见凭据，不暂存、删除或上传文件；它不能替代人工检查。

需要真实线上模型时，明确使用相应的`--execute`脚本，先设置总预算，保留首次发现、失败与重试开销。不能修改已冻结的任务和判据来取得有利结果；原始检查、补充语义复核和泛化结论分开。已有对照见[实验记录](docs/experiments/)。

提交说明写清问题、行为变化、Pi复用点、实际验证及剩余限制。历史任务按原策略恢复，不自动迁移或清理用户资料。提交准备与公开发布分开，发布前另行明确许可证和分发范围。

新增办公/编程案例见[冻结协议](docs/experiments/2026-11-01-office-code-protocol.md)。本地先准备 `scripts/cases/requirements.txt` 的开发依赖，再运行 `npm run test:cases`。CI 为 Linux/macOS 都配置 Python3.12 和这些依赖，因此办公判据不会静默跳过；线上模型对照仍须手动 `--execute`，CI 不使用密钥付费。Python 环境使用[官方 setup-python](https://github.com/actions/setup-python)。

加案例时同时提交任务说明、合成输入、公开检查、独立语义检查和参考解。参考解须通过；至少两个真实缺陷须被拒绝。检查可观察行为，避免把调用次数等实现细节当作错误。发现检查器误报时保留冻结原始结果，另外记录纠正依据与对两组全部产物的复核，不能只重跑有利样本。

## License and review

Contributions are accepted under the repository MIT license. Include only material you have the right to contribute and preserve third-party notices. Use a branch and pull request with the concrete problem, resulting behavior, actual validation and limits. Issues/PRs are the public feedback channels; do not attach private task records or credentials.

The source package remains private in package.json to avoid accidental npm publishing. This does not restrict cloning, modifying or redistributing Kada under LICENSE. The initial distribution is GitHub source archives.
