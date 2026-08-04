# @tier0/node-red-contrib-opcda-client

用于在 Node-RED 中连接传统 OPC DA 服务器，支持 Browse、读取和写入 OPC Item。

> 本节点用于 OPC DA，不是 OPC UA。使用前需要准备 OPC Server 地址、Windows/DCOM 账户和 CLSID。

## 提供的节点

| 节点 | 用途 |
| --- | --- |
| `tier0-opcda-server` | 配置 OPC DA 服务器 |
| `tier0-opcda-read` | 读取 OPC Item |
| `tier0-opcda-write` | 写入 OPC Item |

## 使用前检查

- Node-RED 所在主机或容器可以访问 OPC DA 服务器。
- OPC DA 服务器已启用远程 DCOM。
- TCP 135 和服务器使用的动态 RPC 端口可以访问。
- 使用的账户具有 DCOM Launch、Activation、Access 和 OPC Server 访问权限。
- 已取得目标 OPC Server 的 CLSID。

## 安装

### 在线安装

进入 Node-RED 用户目录后执行：

```bash
npm install @tier0/node-red-contrib-opcda-client
```

Docker 中 Node-RED 用户目录通常是 `/data`：

```bash
docker exec -it <node-red-container> sh
cd /data
npm install @tier0/node-red-contrib-opcda-client
exit
docker restart <node-red-container>
```

### Docker 离线安装

客户端 `.tgz` 已包含运行所需依赖，客户服务器只需要复制并安装这一个包。

```bash
docker cp tier0-node-red-contrib-opcda-client-1.0.31.tgz <node-red-container>:/data/
docker exec -it <node-red-container> sh
cd /data
npm install --offline --no-audit --no-fund ./tier0-node-red-contrib-opcda-client-1.0.31.tgz
exit
docker restart <node-red-container>
```

如果在线安装提示 `getaddrinfo EAI_AGAIN registry.npmjs.org`，表示容器无法访问 npm registry，请改用离线安装。

## 快速开始

1. 在 Flow 中添加 `tier0-opcda-read`。
2. 新建一个 `tier0-opcda-server` 配置。
3. 保存并 Deploy。
4. 打开 Server 配置，点击 **Browse** 获取 Item。
5. 点击 **Export** 导出 Item 列表。
6. 在 Read 节点中点击 **Import** 导入列表。
7. 连接 `inject -> tier0-opcda-read -> debug`。
8. 再次 Deploy，等待 Read 节点显示 `Ready`。
9. 点击 Inject，查看 Debug 中的读取结果。

```text
[inject] -> [tier0-opcda-read] -> [debug / function / mqtt]
```

## Server 配置

| 字段 | 填写内容 |
| --- | --- |
| Name | Node-RED 中显示的服务器名称 |
| Address | OPC DA 服务器 IP 或主机名，例如 `192.168.31.31` |
| Domain | Windows/NTLM 域，按现场账户配置填写 |
| User Name | 有权访问 DCOM 和 OPC Server 的账户 |
| Password | 账户密码 |
| ClsId | OPC Server 的 Class ID |
| Timeout | 连接和操作超时，单位 ms |
| Reconnect cooldown | 服务器资源不足时的重试冷却时间，单位分钟，默认 5 分钟 |

现场 Item 较多或 OPC Server 响应较慢时，可先将 Timeout 设置为 `15000` 或 `20000` ms。

## Browse Item

打开 `tier0-opcda-server` 配置页面：

1. 点击 **Browse**。
2. 等待页面显示找到的 Item 数量。
3. 点击 **Export** 下载 `export.json`。
4. 打开 Read 节点，点击 **Import** 导入该文件。

注意：

- 第一次 Browse 前必须先保存并 Deploy Server 配置。
- Node-RED 不会在编辑页面回显已经保存的密码，这是正常现象。
- 同一个 Server 配置不能同时执行多次 Browse。
- Node-RED 启用权限控制时，用户需要 `node-opc-da.list` 权限。

## Read 节点

### 配置项

| 字段 | 说明 |
| --- | --- |
| Server | 选择 OPC DA Server 配置 |
| Name | 节点名称 |
| Cache Read | 勾选后读取 OPC Server 缓存；不勾选时读取 Device |
| Data Change | 勾选后仅在至少一个值变化时输出 |
| Items | 要读取的 Item ID 列表 |

### Cache Read

- 开启：读取 OPC Server 缓存，通常更快、对下位设备压力更小。
- 关闭：由 OPC Server 从 Device 读取，实时性取决于服务器和设备状态。

### 触发读取

Read 节点每收到一条输入消息读取一次。输入消息的 payload 内容不会作为读取参数。

如果节点还在 `Reading`，新的触发消息不会启动第二个并发读取。

### 输出格式

读取成功后，`msg.payload` 是数组：

```json
[
  {
    "itemID": "Channel1.Device1.Tag1",
    "errorCode": 0,
    "quality": "GOOD",
    "timestamp": "2026-08-04T08:00:00.000Z",
    "value": 123.45
  }
]
```

| 字段 | 说明 |
| --- | --- |
| `itemID` | OPC Item ID |
| `errorCode` | OPC DA 返回码，成功通常为 `0` |
| `quality` | `GOOD`、`UNCERTAIN`、`BAD` 或 `UNKNOWN` |
| `timestamp` | OPC Server 返回的时间戳 |
| `value` | 当前值 |

当前版本只有在本次所有数据质量均为 `GOOD` 时才输出。如果节点显示 `Bad Quality`，请检查 OPC Server 中相应 Item 的质量。

## Write 节点

将写入内容放到 `msg.payload`，格式必须是非空数组：

```json
[
  {
    "itemID": "Channel1.Device1.Setpoint",
    "type": "float",
    "value": 42.5
  },
  {
    "itemID": "Channel1.Device1.Enabled",
    "type": "boolean",
    "value": true
  }
]
```

支持的 `type`：

```text
double, short, integer, float, byte, long, boolean,
uuid, string, char, date, currency, array
```

输出结果：

- 写入成功：`msg.payload` 为 `true`
- 写入失败：`msg.payload` 为 `false`
- 输入格式错误或服务器拒绝写入时，消息中还可能包含 `msg.error` 和 `msg.details`

## 节点状态

| 状态 | 用户操作 |
| --- | --- |
| Ready | 可以触发读取或写入 |
| Reading / Writing | 等待当前操作完成 |
| Good Quality | 最近一次读取正常 |
| Bad Quality | 检查 OPC Server 中 Item 的通信和质量 |
| Mismatch Data | 检查配置的 Item 是否有效、是否全部成功添加 |
| Reconnecting | 等待节点自动重连 |
| Resource cooldown | 等待配置的冷却时间，并检查 OPC Server 客户端数和资源使用情况 |
| Reconnect stopped | 修正账户、权限或 CLSID 后重新 Deploy |
| Disconnected / Error | 查看 Node-RED 日志，节点通常会自动重连 |

## 常见问题

### 节点显示 Ready，点击 Inject 没有输出

- 确认 Read 节点已经添加 Item。
- 检查节点是否变成 `Bad Quality`。
- 确认上一次读取没有一直停留在 `Reading`。
- 在 Read 后连接 Debug 节点。
- 添加 Catch 和 Status 节点，查看 Flow 中的错误和状态。
- 查看 Node-RED 容器日志。

### Browse 提示账号、权限或密码错误

- 保存并 Deploy Server 配置后再 Browse。
- 重新输入账号密码并 Deploy。
- 检查 DCOM 和 OPC Server 权限。
- 检查 CLSID 是否属于目标 OPC DA Server。
- 启用 Node-RED 权限控制时，授予 `node-opc-da.list`。

### 出现 `HRESULT 0x1c00001b (469762075)`

检查 OPC Server 的客户端数、Session、Group、COM 对象、内存和句柄是否达到上限，同时确认是否还有其他采集器连接该服务器。节点会显示 `Resource cooldown`，冷却后自动尝试恢复。

### 出现 `Received unexpected PDU from server`、connection timeout 或 connection closed

节点会自动断开当前异常连接并重连。若频繁出现，请检查：

- 其他采集器是否同时造成 OPC Server 负载波动
- OPC Server 和 Windows DCOM 日志
- 防火墙、NAT 和动态 RPC 端口
- Timeout 是否小于现场一次读取需要的时间

## 截图

### Server

![OPC DA server configuration](images/opcda_server.png)

### Read

![OPC DA read node](images/opcda_read.png)

### Write

![OPC DA write node](images/opcda_write.png)

## 版本变更

实现层面的修复和兼容性说明请查看 [CHANGELOG.md](CHANGELOG.md)。

## License

Apache-2.0。项目基于原始 `node-red-contrib-opcda-client` 维护。
