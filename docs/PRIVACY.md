# 数据、权限与本地存储 / Privacy and permissions

Kada runs locally and calls the cloud model you configure. Local storage does not mean offline inference.

## 数据流

1. CLI / macOS 伙伴连接监听 127.0.0.1 的本地服务，使用本地 token 鉴权并拒绝跨源请求。
2. 任务说明、消息以及模型通过工具读取的相关内容会进入所选供应商的模型请求。使用联网适配时，查询和 URL 发送至 DeepSeek 或已配置的 Agent Reach 服务。
3. Pi 会话、用量、目标与产物保存在本机 .harness 中。macOS 伙伴的连接和外观偏好另存本机应用配置目录。源码发行包不含这些目录。

供应商的数据保存、训练与收费政策由你选择的供应商决定。Kada 没有单独加入产品遥测或崩溃上报通道；外部工具、供应商和已安装服务可能有自己的网络行为。

## 本机发现

首次发现默认开启：扫描约定位置的 Agent 配置、Skills、插件/MCP 元数据和少量白名单偏好，生成本地缓存。新任务可获得短概况，并按需读取 Skill 内容。发现过程不调用模型、不导入凭据、不执行发现的插件；准备/执行任务时使用的相关概况和内容可能进入模型上下文。

在 harness.config.json 设置 `"discovery": false` 可关闭发现。用 `npm run discover` 查看，`npm run discover -- --refresh` 显式刷新。范围见 [local-discovery.md](local-discovery.md)。

## 执行权限

- Shell 与文件工具使用当前本地用户权限，没有操作系统沙箱。工作目录和路径检查不能限制任意 Shell 命令的权限。
- 终端环境不会自动注入后台供应商密钥，但命令仍可能读取用户可访问的文件。请先使用工作副本。
- 真实 computer-use 默认关闭；Kada 桌面 UI 本身不启用辅助功能或录屏驱动。
- 原始会话可能包含任务材料。分享日志前应手动删去隐私、供应商密钥、本地 API token 和绝对路径。

## 管理数据

配置和任务数据保留在本机；卸载源码不会自动清理它们。删除前先保存需要的产物，停止相关任务与后台，然后由用户选择删除对应数据目录。升级不会自动迁移、删除或重置历史任务/凭据。

## English summary

Task context and tool-read material can be sent to the configured cloud provider. Web integrations send queries/URLs to their configured service. Local discovery is on by default and can be disabled; it lists local metadata without executing plugins or importing credentials. Task storage stays local, but shell tools have the OS user's permissions and are not sandboxed. Do not post raw sessions, .env, local API tokens or private task files in public issues.
