# Working on the repository

[中文版本](docs/zh-CN/AGENTS.md)

## Setup and checks

- Use Node.js 22.13 or later on the 22.x line, or Node.js 24 or later, for development. Install with `npm ci --ignore-scripts`.
- Run `npm run check` for ESLint and portable JS tests, including the documentation checks. Use `npm run lint` to run ESLint alone. These commands need no native helper or desktop permissions. List new macOS-only test files in `scripts/check.mjs`.
- Run `npm run check:native` for Swift or native bridge changes. It builds into `.build` and runs the full Node regression suite on macOS with Xcode Command Line Tools. Use a separate checkout if an MCP client is using the current helper.
- Use `npm run doctor` to inspect the built helper and its macOS permissions. For desktop behavior, choose the relevant `npm run test:*` command from [the README](README.md#development-validation-and-license). Use owned fixtures and run desktop tests one at a time on an unlocked, authorized desktop. Benchmarks and human trials need a reserved desktop.
- Report the checks run and any coverage gaps. Offscreen tests, live desktop tests, and human concurrent-use trials each cover different behavior. Verify actual release archives using [the release evidence guide](docs/VALIDATION.md).

## Code map and invariants

- `src/server.mjs` exposes `js` and `js_reset` over MCP stdio. Keep stdout reserved for protocol traffic. With `CU_BROKER_URL` it uses `RemoteBridge`; otherwise it uses local `Bridge`.
- `src/repl.mjs` and `src/repl-worker.mjs` own evaluation and session lifetime. `src/bridge.mjs` supervises the Swift helper on the host. `src/broker.mjs` and `src/remote-bridge.mjs` are the container split: the broker owns helper lifetime, auth, policy and lease expiry; the container never spawns the helper. Cancellation, timeout, reset, disconnect and lease expiry must retire pending native work. After an interrupted mutation, observe the target again before retrying.
- `src/container-host.mjs` and `Dockerfile` package the Node MCP server for a locked-down container while the helper stays on macOS. Prefer that path over bind-mounting the host into the container.
- `src/cua.mjs` implements app/window bindings and coordinate handling. `src/tools.mjs` validates native requests. Reject ambiguous targets and stale snapshots or coordinates. Keep behavior aligned with the [JS API](docs/JS_API.md).
- `native/` owns macOS Accessibility, capture, input, and the cursor overlay. Preserve background routing by default, require explicit foreground opt-in, and use normal macOS permission grants. See [architecture](docs/ARCHITECTURE.md).

Update the Chinese counterparts of changed bilingual docs. Keep local artifacts and research out of commits. Initialize Git for new projects and commit changes by feature. Create a release tag after that version passes acceptance.
