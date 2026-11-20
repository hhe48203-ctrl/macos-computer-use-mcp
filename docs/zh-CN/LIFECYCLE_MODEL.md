# REPL 与原生 helper 生命周期模型

[English version](../LIFECYCLE_MODEL.md)

[Issue #4](https://github.com/hhe48203-ctrl/macos-computer-use-mcp/issues/4) 覆盖本地 MCP 和容器连接宿主机两条路径。两套配置共用 [Lifecycle.tla](../../formal/Lifecycle.tla)。

## 运行 TLC

在安装 Java 和 Node.js 的环境中，使用 [TLA⁺ Tools v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) 的 JAR，其中包含 TLC 2.19。在仓库检出目录或解包后的源码归档根目录运行。

```sh
tlc_dir=$(mktemp -d)
curl -fsSL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o "$tlc_dir/tla2tools.jar"
(cd "$tlc_dir" && printf '%s\n' \
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  tla2tools.jar' \
  | shasum -a 256 -c -) && npm run check:tla -- "$tlc_dir/tla2tools.jar"
```

命令先跑 [Local.cfg](../../formal/Local.cfg)，再跑 [Broker.cfg](../../formal/Broker.cfg)。TLC 状态与轨迹文件放在临时目录。两套配置均允许两次原生调用。本地配置允许三个 REPL 执行和两次代际失效。broker 配置允许两个执行、两个会话、一次代际失效，以及每个心跳间隔内一次抽象的租约计时。这个范围可以覆盖执行和调用竞争、迟到回复、进程退役和 helper 或会话更替。有限任务耗尽后，模型允许状态保持不变。配置关闭了 TLC 的死锁检查，通过显式时序性质检查退役进展。

## 模型与实现

| 阶段 | 实现对应与模型边界 |
| --- | --- |
| REPL 排队、取消、重置、超时 | `src/repl.mjs` 和 `src/repl-worker.mjs` 串行执行 REPL，等待已发出的原生调用，按当前执行和 worker 隔离回复，并使旧代际失效。重置、取消和 REPL 超时共用 `Invalidate`，因为三者的生命周期动作相同。 |
| 原生分派、结果和超时 | `src/bridge.mjs` 排队、核对代际，并保存一个等待中的原生请求。模型将分派、可能的状态变更、helper 回包和 REPL 收到结果分开建模。调用报错时，变更仍可能已生效。模型没有重新发送同一调用的迁移。 |
| Broker 会话与断连 | `src/broker.mjs` 接纳一个通过认证的会话，收到释放请求、socket FIN/关闭、租约到期或发现 helper 崩溃后撤销会话。`Send` 和 `Accept` 允许在途请求与客户端取消、宿主机撤销竞争。认证和协议校验由 broker 回归测试独立验证。 |
| Helper 退出与 AX 引用 | 模型分别表示 SIGTERM、SIGKILL 升级、进程退出及宿主机收到退出通知。宿主机可以在退役期间接纳新会话，新请求要等旧进程退出后才可分派。AX 快照 ID 对应已退出 helper 的内存缓存。新进程会对旧 ID 返回 `STALE_ELEMENT`，模型用 helper 代际表示该查找。 |
| 已确认和未确认的退役 | `src/remote-bridge.mjs` 发送释放消息并等待 socket 关闭。客户端本地超时可能先销毁 socket。收到 broker 在 helper 退出后发送的 FIN 可以确认退役。客户端超时或传输故障时，客户端无法确认。宿主机独立约束分派，公开的 reset 结果尚无这两种状态的字段。 |

TLC 检查串行化、拒绝过期执行与回复、分派前等待进程退出、调用最多结算一次、禁止重放，以及跨 helper 代际拒绝过期 AX 引用。它还检查处于退出流程或已崩溃的 helper 最终会被观察到退出。broker 配置另外检查断开、释放中或静默的会话最终会被撤销，已撤销会话中的等待调用最终会结算。

## 假设与覆盖范围

- 假设宿主机能观察到已经送达的 FIN 或关闭通知。半开连接可以一直静默，此时依赖宿主机推进租约时钟并运行到期回调。心跳和有效的入站请求都会刷新租约。计时步是对经过时间的抽象。连接通知和租约计时受公平性条件约束。请求超时和客户端退役超时可以与其他事件竞争，模型允许它们一直未触发。
- 假设无响应的 helper 最终因 SIGKILL 退出，且 Node 收到退出或关闭通知。Swift 的 SIGTERM 处理器尝试清理输入状态。模型单独刻画退役、进程退出和退出通知。macOS 焦点变化及鼠标抬起事件是否送达需另行验证。
- IPC 简化为有序的请求标识和抽象回复。模型覆盖同一个 RemoteBridge 的前后两次连接。客户端 socket 超时后，旧 helper 仍在退出时，新会话可以先完成认证。模型检查这一情形，broker 测试还覆盖独立客户端之间的连接。JavaScript 调度、操作系统事件交付、Swift 清理与桌面行为由相应运行时测试在适用范围内覆盖。新增的两项 `tests/broker.test.mjs` 中的回归测试 使用真实 socket 和可控的子进程，分别验证空闲 helper 崩溃后撤销会话，以及客户端 socket 超时后宿主机仍等待旧进程退出。
