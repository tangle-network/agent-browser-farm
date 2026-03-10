# browser-farm

Session-scoped browser allocation service. Unified API over Browserless, Playwright, Appium, and native drivers.

```
pnpm add @tangle-network/browser-farm
```

## Supported Browsers

| Browser | Type | Backend | Protocol |
|---------|------|---------|----------|
| Chrome | `chrome` | Browserless (Docker) | WebSocket (CDP) |
| Firefox | `firefox` | Browserless (Docker) | WebSocket (Playwright) |
| WebKit | `webkit` | Browserless / Playwright | WebSocket (Playwright) |
| Safari (macOS) | `safari` | safaridriver | WebDriver HTTP |
| iOS Safari (sim) | `ios-safari` | Appium + simctl | WebDriver HTTP |
| iOS Safari (device) | `ios-safari` | Appium + USB | WebDriver HTTP |
| Android Chrome (emu) | `android-chrome` | ADB + CDP | WebSocket (CDP) |
| Android Chrome (device) | `android-chrome` | ADB + USB | WebSocket (CDP) |

## Quick Start

```bash
docker compose up -d  # starts Browserless + farm on :9222
```

Or programmatically:

```typescript
import { createApp, BrowserlessBackend } from '@tangle-network/browser-farm'

const app = createApp({
  port: 9222,
  backends: [new BrowserlessBackend({ url: 'http://localhost:3000' })],
})
```

## Client SDK

```typescript
import { BrowserFarmClient } from '@tangle-network/browser-farm/client'
import { chromium } from 'playwright'

const farm = new BrowserFarmClient('http://localhost:9222')

// Allocate a browser
const session = await farm.createSession({ browser: 'chrome' })

// Connect with Playwright
const browser = await chromium.connectOverCDP(session.wsEndpoint!)
const page = await browser.newPage()
await page.goto('https://example.com')

// Cleanup
await browser.close()
await farm.destroySession(session.sessionId)
```

WebDriver browsers (Safari, iOS) return `webdriverUrl` + `webdriverSessionId` instead of `wsEndpoint`.

## API

### `POST /sessions`

```bash
curl -X POST http://localhost:9222/sessions \
  -H 'Content-Type: application/json' \
  -d '{"browser": "chrome", "clientId": "my-app"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `browser` | string | yes | `chrome`, `firefox`, `webkit`, `safari`, `ios-safari`, `android-chrome` |
| `device` | string | no | Device name (`"iPhone 15"`, `"iPad Pro 11"`) |
| `headless` | boolean | no | Run headless |
| `timeout` | number | no | Session timeout in seconds (default: 300) |
| `clientId` | string | no | Client identifier for per-tenant limits |

Returns `wsEndpoint` (WS browsers) or `webdriverUrl` + `webdriverSessionId` (WebDriver browsers).

### Other Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions` | List active sessions (optional `?clientId=` filter) |
| `GET` | `/sessions/:id` | Session details |
| `GET` | `/sessions/:id/screenshot` | PNG screenshot |
| `DELETE` | `/sessions/:id` | Destroy session |
| `GET` | `/health` | Pool status across all backends |
| `POST` | `/backends` | Register backend at runtime |
| `GET` | `/backends` | List backends with health |
| `DELETE` | `/backends/:id` | Remove backend |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9222` | Server port |
| `API_TOKEN` | | Bearer token for auth (empty = no auth) |
| `BROWSERLESS_URL` | `http://localhost:3000` | Default Browserless URL |
| `BROWSERLESS_TOKEN` | | Browserless auth token |
| `MAX_SESSIONS` | `20` | Global max concurrent sessions |
| `MAX_PER_CLIENT` | `5` | Per-client session limit |
| `SESSION_TIMEOUT` | `300` | Session timeout (seconds) |
| `IDLE_TIMEOUT` | `300` | Idle timeout before reaping (seconds) |

## Architecture

```
Client ─── POST /sessions ──→ Allocator ──→ Backend.createSession()
                                │              ├── BrowserlessBackend  → WS
                                │              ├── PlaywrightBackend   → WS
                                │              ├── SafariDesktopBackend → WebDriver
                                │              ├── IosSafariBackend    → WebDriver
                                │              ├── AndroidBackend      → WS
                                │              └── ...
                                ├── per-client limits
                                ├── session lifecycle
                                └── auto-reap expired/idle

Client ─── ws://farm/session/id ──→ SessionProxy ──→ upstream WS
```

## Docs

- [Deployment Guide](docs/deployment.md) — topologies, hardware, scaling
- [Integration Guide](docs/integration.md) — wiring into orchestrators and drivers

## Development

```bash
pnpm install
pnpm dev              # tsx watch
pnpm test             # unit tests (115 tests)
pnpm test:integration # backend contract tests (requires infra)
pnpm typecheck
pnpm build
```

## License

MIT
