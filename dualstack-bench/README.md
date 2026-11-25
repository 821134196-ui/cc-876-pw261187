# 双栈连接实验台（IPv4 / IPv6 Happy Eyeballs）

在本机对 IPv4、IPv6 两条连接路径做可控竞速实验：调整每一路的可达性与延迟，
观察何时发起替代连接，哪一路胜出，落选连接如何被取消，并完整覆盖**用户取消**
和**短时间内连续连接（自动取代）**。页面给出每次连接尝试的时间线泳道图与
完成原因，全部用本地端点完成，零外部依赖、无需 root。

## 运行

```bash
node server.js          # 默认 http://localhost:8080 （PORT 环境变量可改端口）
npm test                # 引擎单元测试（node:test，零依赖）
```

## 两种链路模式

| 模式 | 实现 | 可控项 |
|---|---|---|
| 模拟链路（默认） | `SimulatedDialer`，与真实拨号器同一接口 | accept / refuse / blackhole + 0–3000ms 延迟，完全确定 |
| 真实本地 TCP | `TargetManager` 在 `::1` 与 `127.0.0.1` 上各起一个监听 | accept（真实连接）/ refuse（**真实 ECONNREFUSED**） |

真实模式下的延迟注入与黑洞需要 root 拥有的 `iptables`/`tc`，本沙箱无特权，
因此这两项控件在真实模式下禁用并在页面注明；模拟模式提供等价的确定性行为。

## 竞速规则（RFC 8305）

1. 首选地址族（默认 IPv6）立即发起连接，同时排定一个替代连接定时器
   （默认 250ms，可在页面调 0–2000ms）。
2. 定时器到期首选仍未建立 → 发起替代连接（IPv4），两路并行。
3. 首选提前失败 → **不等定时器**，立即拉起替代连接。
4. 任一路先建立即胜出：其余挂起尝试通过 `AbortController` 中止；若另一条
   连接几乎同时建立，则由引擎 `close()` 关闭，杜绝连接泄漏。
5. 每路有独立连接超时（默认 4000ms）；两路皆败按原因记为 `all-failed` 或
   `timeout`。

## 完成原因

| reason | 含义 |
|---|---|
| `primary-won` | 首选地址族在替代定时器到期前直接胜出 |
| `fallback-won` | 等待到期后替代连接胜出 |
| `primary-failed-fallback-won` | 首选失败，替代连接被提前拉起并胜出 |
| `all-failed` | 两路均失败（如 ECONNREFUSED） |
| `timeout` | 挂起尝试达到连接超时 |
| `user-cancelled` | 用户在运行中点击「用户取消」 |
| `superseded` | 短时间内的新连接取代了本次运行 |

## 取消与连续连接（重点保证）

- **单根取消通道**：每次运行只有一个根 `AbortController`，每路尝试派生自己的
  controller 并链接到根。用户取消、取代、落选三种取消都经同一通道到达拨号器，
  不存在状态分叉。
- **终态不留 connecting**：abort 触发的 reject 在运行结束后仍会把该尝试标记为
  `cancelled`（`RACE_LOST` / `USER_CANCELLED` / `SUPERSEDED`），摘要与时间线
  不会出现卡在「连接中」的尝试。
- **连续发起**：「连续发起 3 次」以 120ms 间隔启动运行，每次都 abort 前一次，
  前两次以 `superseded` 结束，仅最后一次存活；所有模拟定时器随 abort 清除
  （测试断言 `hasPending() === false`）。
- 取消一个已结束的运行是幂等 no-op。

## 目录结构

```
lib/happy-eyeballs.js    传输无关的竞速引擎（取消、定时器、原因判定）
lib/simulated-dialer.js  模拟链路拨号器（accept/refuse/blackhole + 延迟）
lib/tcp-dialer.js        真实 TCP 拨号器（net.createConnection + abort destroy）
lib/target-manager.js    ::1 / 127.0.0.1 本地监听管理（同端口 close/relisten）
server.js                HTTP API + SSE 事件流 + 运行/取代生命周期
public/                  页面：参数控件、时间线泳道、记录表、事件表
test/engine.test.js      12 项引擎测试
```

## API 摘要

- `GET /api/state` 当前模式、链路、参数、历史
- `GET /api/events` SSE：运行与尝试的全部生命周期事件
- `POST /api/links` 设置每路 `{mode, latencyMs}`
- `POST /api/run-opts` 设置 `{delayMs, connectTimeoutMs, order}`
- `POST /api/runs/start` / `/cancel` / `/burst` 发起 / 取消 / 连续取代
- `POST /api/mode` 切换 `sim` / `real`
