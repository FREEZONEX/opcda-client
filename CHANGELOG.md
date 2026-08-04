# Changelog

本文件记录实现、兼容性和连接生命周期相关变更。用户安装与节点操作请查看 [README.md](README.md)。

## 1.0.31 - 2026-08-04

### Changed

- 将 `@tier0/node-dcom` 固定为 `1.2.20`，将 `@tier0/node-opc-da` 固定为 `1.0.15`。
- 最终 npm 包内置 DCOM、OPC DA 和运行时依赖，支持单个 `.tgz` 完全离线安装。
- Server 节点增加可配置的 `Reconnect cooldown`，默认 5 分钟。
- Browse 改为 POST 请求，优先读取已部署配置节点中的 credentials。

### Fixed

- 修复 DCOM/RPC 数据被 TCP 拆包或粘包时的 PDU 解析。
- 修复多分片 RPC Response 的组装以及并发响应边界处理。
- 为 RPC 请求分配递增 call ID，并校验响应 call ID，避免错误响应被交给当前请求。
- RPC framing、unexpected PDU、call ID mismatch、connection timeout 和 connection closed 会将 transport 标记为不可复用。
- 不可复用 transport 会先关闭 socket，再清理本地 Session 引用，不再在坏连接上连续发送远程 release RPC。
- 正常关闭、重新部署和健康连接清理时，补全 OPC Group、SyncIO、ItemManager、COM 对象及 DCOM Session 的释放。
- 修复连接建立过程中关闭节点时，外层操作仍等待完整 timeout 的问题。
- 修复 OPC Group 按错误句柄删除、断开事件重复转发和多处结果长度判断错误。
- 修复读取 Quality 分类，使用 OPC Quality category mask 判断 GOOD、UNCERTAIN 和 BAD。
- 写节点增加 payload、类型、AddItems 结果和 Write 结果校验。
- Browse 增加超时、单 Server 单实例限制和失败后的资源清理。
- Browse 错误信息增加已知 HRESULT 的可读说明。

### Reconnect behavior

- 普通临时故障按约 `3s、6s、12s、24s、48s、60s...` 退避，最多连续尝试 10 次。
- 连续 3 次 `0x1c00001b` 后进入配置的资源冷却时间。
- 冷却结束后只进行一次连接探测；仍失败则再次进入冷却。
- 只有成功读取或写入一次后才清零连续失败和资源失败计数。
- Access denied、无效 CLSID、Class not registered 和无效 OPC Server 配置会永久停止自动重连，等待用户修正后重新 Deploy。
