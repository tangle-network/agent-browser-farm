# browser-farm

Session-scoped browser allocation service. Wraps proven open-source tools with a unified allocation API, adding mobile device support and multi-tenant isolation.

## Problem

Sandboxes, CI pipelines, and browser agents need on-demand browser sessions across platforms:
- Desktop browsers (Chrome, Firefox, WebKit) for testing and automation
- iOS Safari for mobile web testing (requires macOS)
- Android Chrome for mobile web testing

No single tool covers all three. Browserless handles desktop. Appium handles mobile. This service unifies them behind one API.

## Prior Art (Build vs Wrap)

| Tool | Does | License | Verdict |
|------|------|---------|---------|
| **Browserless** | Desktop browser pool, session management, WS proxy, queue, cleanup | SSPL (free internal use) | **Wrap for desktop.** Rebuilding this is months of wasted work. |
| **Playwright `launchServer()`** | Single browser WS endpoint | Apache-2.0 | Raw primitive. No pooling, no cleanup, no routing. |
| **Appium + Device Farm plugin** | Mobile device pool, session routing | Apache-2.0 | **Use for mobile.** Only real option for iOS/Android. |
| **Selenoid** | Docker-per-browser session | Apache-2.0 | **Dead.** Archived Dec 2024. |
| **Moon (Aerokube)** | K8s browser orchestration | Commercial ($5/session/mo) | Overkill. Requires K8s. Closed source. |
| **AWS Device Farm** | Real devices in cloud | Commercial ($0.17/min) | Expensive at scale. Good fallback, not primary. |
| **BrowserStack** | Everything | Commercial ($129+/mo/session) | Black box. Not extensible. |

**Decision**: Wrap Browserless for desktop, Appium for mobile. Build only the allocation API and tenant isolation layer.

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │       browser-farm              │
                    │                                       │
  POST /sessions ──│  Allocator                             │
                    │    ├─ route by capability             │
                    │    ├─ enforce tenant concurrency      │
                    │    └─ track session lifecycle         │
                    │                                       │
                    │  Backends:                            │
                    │    ├─ Browserless (Docker)       ─────│──→ Chrome, Firefox, WebKit
                    │    ├─ Appium (macOS host)        ─────│──→ iOS Simulator + Safari
                    │    └─ Appium (Linux host)        ─────│──→ Android Emulator
                    │                                       │
  ws://farm/s/id ──│  Proxy (thin WS relay)                │
                    └──────────────────────────────────────┘
```

### What we build (small)

- **Allocator**: routes session requests to the right backend, enforces per-tenant limits, tracks lifecycle, auto-reaps idle sessions.
- **Proxy**: thin WebSocket relay that maps `ws://farm/session/{id}` → backend WS endpoint. Adds auth, connection tracking, disconnect-triggered cleanup.
- **Backend registry**: register/deregister backend hosts at runtime. Health check loop.

### What we don't build (use off-the-shelf)

- Browser process management → Browserless
- Session queueing and concurrency → Browserless (`CONCURRENT`, `QUEUED` env vars)
- Browser crash recovery → Browserless
- iOS Simulator lifecycle → Appium + `xcrun simctl`
- Android emulator lifecycle → Appium + ADB
- Device discovery → Appium Device Farm plugin

## API

### `POST /sessions`

```json
{
  "browser": "chrome",
  "device": "iPhone 15",
  "headless": true,
  "timeout": 300,
  "clientId": "sandbox-abc123"
}
```

`browser`: `"chrome"` | `"firefox"` | `"webkit"` | `"ios-safari"` | `"android-chrome"`

Response:
```json
{
  "sessionId": "bf-a1b2c3d4",
  "wsEndpoint": "ws://farm:9222/session/bf-a1b2c3d4",
  "browser": "chrome",
  "expiresAt": "2026-03-08T12:05:00Z"
}
```

### `DELETE /sessions/:id`

Release session. Backend handles browser kill + state wipe.

### `GET /health`

```json
{
  "pools": {
    "desktop": { "capacity": 10, "active": 3, "backend": "browserless" },
    "ios": { "capacity": 4, "active": 1, "hosts": 2 },
    "android": { "capacity": 4, "active": 0 }
  }
}
```

### `POST /backends` / `DELETE /backends/:id` / `GET /backends`

Register, deregister, list backend hosts.

## Deployment Topology

### Phase 1: Desktop only (day 1)

```
Linux Host
├── browser-farm (Node.js process)
└── Browserless (Docker container)
    └── Chromium, Firefox, WebKit
```

One command: `docker run -e CONCURRENT=10 ghcr.io/browserless/multi`

The farm service runs alongside, routes sessions to Browserless, adds auth + tenant isolation.

### Phase 2: + Android (week 2)

```
Linux Host
├── browser-farm
├── Browserless (Docker)
└── Appium Server
    └── Android SDK + emulator AVDs (snapshot-booted)
```

Android emulators run on the same Linux host. Appium manages lifecycle. Farm routes `android-chrome` requests to Appium.

### Phase 3: + iOS (when Mac hardware available)

```
Linux Host                        macOS Host (Mac Mini/Studio)
├── browser-farm            ├── Appium Server
├── Browserless (Docker)          ├── Xcode + iOS Simulators
└── Appium (Android)              └── WebDriverAgent
                                       ↑
                              SSH/network from farm
```

Farm registers Mac hosts as backends. `ios-safari` requests routed to available Mac. Each Mac supports 2-4 concurrent simulator sessions.

## License Strategy

**For internal use / agent-dev-container integration:**
- Browserless SSPL is fine. No restrictions on internal use.
- Ship it.

**For selling as a hosted service:**
- SSPL prohibits offering Browserless as a service without buying their commercial license.
- Two options:
  1. Buy Browserless commercial license (~$200-500/mo depending on usage). Simplest.
  2. Replace Browserless with custom `Playwright.launchServer()` pool. More work but fully Apache-2.0.
- Decision: start with SSPL internally, switch to custom or buy license when revenue justifies it.

## 0-to-1 Checklist

### Phase 1: Desktop browsers (target: 1-2 days)

- [ ] `pnpm init` + TypeScript + Hono setup
- [ ] Browserless Docker container config (multi-browser image)
- [ ] `POST /sessions` → allocate session from Browserless, return WS endpoint
- [ ] `DELETE /sessions/:id` → kill session
- [ ] `GET /health` → Browserless health + capacity
- [ ] WS proxy: `ws://farm/session/{id}` → Browserless WS endpoint
- [ ] Session timeout reaper (idle sessions auto-killed)
- [ ] Per-client concurrency limits
- [ ] Bearer token auth per session
- [ ] Dockerfile for the farm service itself
- [ ] Integration test: Playwright connects via farm, loads page, disconnects, session cleaned up
- [ ] Wire into agent-dev-container: `REMOTE_BROWSER_ENDPOINTS` → farm URL

### Phase 2: Android (target: 1-2 days after Phase 1)

- [ ] Android SDK + AVD snapshot setup script
- [ ] Appium server config for Android
- [ ] AndroidPool backend: allocate emulator → start Appium session → return WS endpoint
- [ ] Emulator lifecycle: snapshot boot (~2s), kill on release, port isolation
- [ ] Integration test: Playwright connects to Android Chrome via farm
- [ ] Add `android-chrome` to `/health` capacity reporting

### Phase 3: iOS (target: 1 week, requires Mac hardware)

- [ ] Mac host setup script: Xcode CLI tools, Appium, WebDriverAgent
- [ ] MacPool backend: SSH → boot simulator → start Appium → return WS endpoint
- [ ] Simulator lifecycle: `xcrun simctl` create/boot/shutdown/delete
- [ ] Mac host registry + health checks
- [ ] Integration test: Playwright WebKit connects to iOS Safari via farm
- [ ] Add `ios-safari` to `/health` capacity reporting

### Phase 4: Production hardening

- [ ] Prometheus metrics: session count, allocation latency, pool utilization, error rate
- [ ] Structured logging (same format as agent-dev-container)
- [ ] Crash recovery: detect zombie browser processes, reclaim leaked ports
- [ ] Graceful shutdown: drain active sessions before exit
- [ ] Session recording opt-in (Browserless supports this natively)
- [ ] Rate limiting per client
- [ ] CI pipeline: lint, test, Docker build, push to registry

### Phase 5: Commercial (when ready)

- [ ] Multi-tenant billing integration (usage-based: session-minutes)
- [ ] Dashboard: active sessions, pool utilization, per-tenant usage
- [ ] Replace Browserless with custom Playwright pool (if SSPL is a blocker) OR buy commercial license
- [ ] SLA monitoring + alerting
- [ ] Docs site

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **HTTP/WS**: Hono + `ws`
- **Desktop browsers**: Browserless Docker image (wrapping Playwright)
- **Mobile**: Appium 3.x + Device Farm plugin
- **SSH (Mac pool)**: `ssh2` package
- **Config**: env vars (same pattern as orchestrator)
- **Containerization**: Docker (farm service + Browserless sidecar)

## Directory Structure

```
browser-farm/
├── src/
│   ├── server.ts              # Hono HTTP + WS upgrade handler
│   ├── allocator.ts           # Session allocation, routing, lifecycle
│   ├── proxy.ts               # WS relay (session ID → backend endpoint)
│   ├── backends/
│   │   ├── types.ts           # Backend interface
│   │   ├── browserless.ts     # Wraps Browserless Docker API
│   │   ├── appium-android.ts  # Android emulator via Appium
│   │   └── appium-ios.ts      # iOS Simulator via Appium on remote Mac
│   └── config.ts
├── scripts/
│   ├── setup-android.sh       # Android SDK + AVD snapshot setup
│   └── setup-mac-host.sh      # Xcode + Appium + WDA on macOS
├── tests/
├── docker-compose.yml         # Farm service + Browserless
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Security Model

- **Session isolation**: Browserless creates fresh profiles per session. Appium creates fresh simulator/emulator instances.
- **Auth**: bearer token generated at allocation, required for WS proxy connection.
- **Network**: internal only. Farm API not exposed to public internet.
- **Mac SSH**: key-based auth. Keys provisioned out-of-band (not managed by this service).
- **Concurrency caps**: per-client and per-pool limits prevent resource exhaustion.
- **Cleanup guarantee**: idle timeout (default 5 min) + disconnect detection + periodic reaper sweep.

## Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Browser crash mid-session | Browserless detects, WS drops | Client reconnects, gets new session |
| Mac SSH drops | Health check fails (30s interval) | Mark host unhealthy, route to another |
| Emulator hangs | Appium session timeout | Kill emulator process, reclaim port |
| Farm service crash | Systemd/Docker restart | Sessions lost — clients reconnect |
| Port leak | Periodic port scan on known ranges | Force-kill orphaned processes |
| Disk full (recordings) | Disk usage monitor | Purge oldest recordings, alert |

## Non-Goals

- Managing Mac hardware lifecycle (OS updates, Xcode installs, provisioning profiles)
- Real physical device management (USB hubs, device provisioning) — use AWS Device Farm for this
- Video recording infrastructure (Browserless and Playwright handle this client-side)
- Building a Selenium Grid replacement
- Supporting browsers we don't need (Edge, Opera, IE)
