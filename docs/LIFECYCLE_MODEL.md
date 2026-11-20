# REPL and native helper lifecycle model

[中文版本](zh-CN/LIFECYCLE_MODEL.md)

[Issue #4](https://github.com/hhe48203-ctrl/macos-computer-use-mcp/issues/4) covers the local MCP path and the container-to-host path. Both configurations use [Lifecycle.tla](../formal/Lifecycle.tla).

## Run TLC

With Java and Node.js available, use the JAR from the [TLA⁺ tools v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4), which contains TLC 2.19. Run from the repository root.

```sh
tlc_dir=$(mktemp -d)
curl -fsSL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o "$tlc_dir/tla2tools.jar"
(cd "$tlc_dir" && printf '%s\n' \
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  tla2tools.jar' \
  | shasum -a 256 -c -) && npm run check:tla -- "$tlc_dir/tla2tools.jar"
```

The command runs [Local.cfg](../formal/Local.cfg) first and [Broker.cfg](../formal/Broker.cfg) second, using a temporary directory for TLC state and trace files. Each configuration allows two native invocations. The local one allows three REPL evaluations and two invalidations. The broker one allows two evaluations, two sessions, one invalidation, and one abstract lease tick per heartbeat interval. The bounds allow competing evaluations and calls, late replies, retirement, and a replacement helper or session. Stuttering is permitted at the end of finite workloads. The model disables TLC's deadlock check and checks retirement progress with explicit temporal properties.

## Model and implementation

| Lifecycle step | Implementation and model boundary |
| --- | --- |
| REPL queue, cancellation, reset, deadline | [repl.mjs](../src/repl.mjs) and [repl-worker.mjs](../src/repl-worker.mjs) queue evaluations, drain native calls, fence replies by active evaluation and worker, and invalidate the old generation. `Invalidate` groups reset, cancellation, and the REPL deadline because they share the same lifecycle transition. |
| Native dispatch, result, and timeout | [bridge.mjs](../src/bridge.mjs) queues requests, checks the bridge generation, and holds a single pending slot. The model splits dispatch, a possible mutation, the helper reply, and publication to the REPL. A failed invocation can have applied a mutation. No transition resends that invocation. |
| Broker session and disconnect | [broker.mjs](../src/broker.mjs) accepts one authenticated session. It revokes on release, socket FIN/close, lease expiry, or observed helper crash. `Send` and `Accept` let a frame already in transit race client-side cancellation and host-side revocation. Auth and protocol validation are exercised separately by the broker regression tests. |
| Helper exit and AX references | Explicit model steps cover SIGTERM, SIGKILL escalation, process exit, and host observation. The host may accept a new broker session during retirement and hold its request behind the native dispatch fence. AX snapshot IDs refer to the old helper's in-memory cache. A fresh process rejects the old ID as `STALE_ELEMENT`. The model uses helper epochs to represent that lookup. |
| Confirmed versus unconfirmed retirement | [remote-bridge.mjs](../src/remote-bridge.mjs) sends a release frame and waits for socket close, with a local timeout that can destroy the socket first. A broker FIN sent after helper exit can confirm retirement. Client timeout or transport failure leaves retirement unconfirmed. The host independently enforces the process-exit fence. The public reset result does not expose this distinction. |

TLC checks serialization, rejection of stale evaluations and replies, process-exit fencing, at-most-once settlement, no replay, and rejection of expired AX references across helper epochs. It also checks that a helper in shutdown or crashed state is eventually observed to have exited. The broker configuration additionally checks that a lost, releasing, or silent session is eventually revoked and that pending invocations from revoked sessions eventually settle.

## Assumptions and coverage

- The host observes a delivered FIN or close. A half-open link can stay silent, in which case progress requires the host lease clock to advance and the expiry callback to run. Heartbeats and valid incoming requests refresh the lease. The tick is an abstraction of elapsed time. Fairness assumes enabled socket and timer processing eventually runs.
- An unresponsive helper eventually exits after SIGKILL and Node receives the exit or close notification. The Swift signal handler attempts input cleanup on SIGTERM. The model represents that shutdown, process exit, and exit observation separately from any macOS focus changes or mouse-up delivery.
- IPC is reduced to ordered request identity and abstract replies. The model checks the listed bounds under these assumptions. JavaScript scheduling, OS event delivery, Swift cleanup, and desktop effects are covered by their corresponding runtime tests where applicable. The two added [broker regressions](../tests/broker.test.mjs) use a real socket and a controllable subprocess to exercise idle crash revocation and host fencing after a client-side socket timeout.
