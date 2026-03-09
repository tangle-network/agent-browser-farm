# agent-browser-farm

Session-scoped browser allocation service. Unified API over Browserless, Playwright, Appium, and native drivers — covering every major platform.

## Supported Browsers

| Browser | Type | Backend | Protocol |
|---------|------|---------|----------|
| Chrome | `chrome` | Browserless (Docker) | WebSocket (CDP) |
| Firefox | `firefox` | Browserless (Docker) | WebSocket (Playwright) |
| WebKit | `webkit` | Browserless / Playwright | WebSocket (Playwright) |
| Safari (macOS) | `safari` | safaridriver | WebDriver HTTP |
| iOS Safari (simulator) | `ios-safari` | Appium + xcrun simctl | WebDriver HTTP |
| iOS Safari (device) | `ios-safari` | Appium + USB | WebDriver HTTP |
| Android Chrome (emulator) | `android-chrome` | ADB + CDP | WebSocket (CDP) |
| Android Chrome (device) | `android-chrome` | ADB + USB | WebSocket (CDP) |

## Quick Start

### Docker (desktop browsers)

```bash
docker compose up -d
```

This starts Browserless (Chrome, Firefox, WebKit) and the farm on port 9222.

### Programmatic

```bash
pnpm add agent-browser-farm
```

```typescript
import { createApp, BrowserlessBackend } from 'agent-browser-farm';

const app = createApp({
  port: 9222,
  backends: [
    new BrowserlessBackend({ url: 'http://localhost:3000' }),
  ],
});

// Graceful shutdown
process.on('SIGTERM', () => app.shutdown());
```

## Client SDK

```bash
pnpm add agent-browser-farm
```

```typescript
import { BrowserFarmClient } from 'agent-browser-farm/client';

const farm = new BrowserFarmClient('http://localhost:9222', {
  token: 'your-api-token', // optional
});
```

### Desktop Chrome with Playwright

```typescript
import { chromium } from 'playwright';

const session = await farm.createSession({ browser: 'chrome' });
const browser = await chromium.connectOverCDP(session.wsEndpoint!);
const page = await browser.newPage();
await page.goto('https://example.com');

// Cleanup
await browser.close();
await farm.destroySession(session.sessionId);
```

### iOS Safari with WebDriver

```typescript
const session = await farm.createSession({
  browser: 'ios-safari',
  device: 'iPhone 15',
});

// Use session.webdriverUrl + session.webdriverSessionId
// with any WebDriver client (Selenium, webdriverio, etc.)

await farm.destroySession(session.sessionId);
```

### Android Chrome with CDP

```typescript
import { chromium } from 'playwright';

const session = await farm.createSession({ browser: 'android-chrome' });
const browser = await chromium.connectOverCDP(session.wsEndpoint!);
// Same API as desktop Chrome

await farm.destroySession(session.sessionId);
```

## HTTP API

### `POST /sessions`

Create a browser session.

```bash
curl -X POST http://localhost:9222/sessions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"browser": "chrome", "clientId": "my-app"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `browser` | string | yes | `chrome`, `firefox`, `webkit`, `safari`, `ios-safari`, `android-chrome` |
| `device` | string | no | Device name (e.g. `"iPhone 15"`, `"iPad Pro 11"`) |
| `headless` | boolean | no | Run headless (default: backend-dependent) |
| `timeout` | number | no | Session timeout in seconds (default: 300) |
| `clientId` | string | no | Client identifier for per-tenant limits |

**Response (WebSocket-based browsers):**

```json
{
  "sessionId": "bf-a1b2c3d4",
  "browser": "chrome",
  "token": "uuid",
  "expiresAt": "2026-03-08T12:05:00Z",
  "wsEndpoint": "ws://localhost:9222/session/bf-a1b2c3d4?token=uuid"
}
```

**Response (WebDriver-based browsers):**

```json
{
  "sessionId": "bf-e5f6g7h8",
  "browser": "ios-safari",
  "token": "uuid",
  "expiresAt": "2026-03-08T12:05:00Z",
  "webdriverUrl": "http://mac-host:4723",
  "webdriverSessionId": "appium-session-id"
}
```

### `GET /sessions`

List active sessions. Optional `?clientId=` filter.

### `GET /sessions/:id`

Get session details.

### `DELETE /sessions/:id`

Destroy a session. Backend handles browser kill + state cleanup.

### `GET /health`

Pool status across all backends.

```json
{
  "pools": {
    "browserless-abc": { "capacity": 10, "active": 3, "backend": "browserless", "healthy": true },
    "ios-safari-def": { "capacity": 4, "active": 1, "backend": "ios-safari", "healthy": true }
  }
}
```

### `POST /backends`

Register a backend at runtime.

```bash
# Browserless
curl -X POST http://localhost:9222/backends \
  -d '{"type": "browserless", "url": "http://browserless:3000", "token": "..."}'

# iOS Safari (simulators with iPhone + iPad templates)
curl -X POST http://localhost:9222/backends \
  -d '{"type": "ios-safari", "url": "http://mac:4723", "templates": {"iPhone": "UDID1", "iPad": "UDID2"}, "capacity": 8}'

# Android emulator
curl -X POST http://localhost:9222/backends \
  -d '{"type": "android", "avdName": "chrome-farm", "capacity": 4}'

# Physical Android device
curl -X POST http://localhost:9222/backends \
  -d '{"type": "android-device", "devices": ["SERIAL1", "SERIAL2"]}'

# Physical iOS device
curl -X POST http://localhost:9222/backends \
  -d '{"type": "ios-device", "url": "http://mac:4723", "devices": [{"udid": "...", "name": "iPhone 15"}], "xcodeOrgId": "TEAM_ID"}'

# macOS Safari
curl -X POST http://localhost:9222/backends \
  -d '{"type": "safari-desktop", "capacity": 4}'

# Playwright WebKit
curl -X POST http://localhost:9222/backends \
  -d '{"type": "playwright"}'
```

### `GET /backends`

List registered backends with health status.

### `DELETE /backends/:id`

Remove a backend (fails if it has active sessions).

## Backends

### Browserless (desktop)

Wraps [Browserless](https://github.com/browserless/browserless) Docker containers. Handles Chrome, Firefox, and WebKit via Playwright protocol over WebSocket.

```typescript
import { BrowserlessBackend } from 'agent-browser-farm';

new BrowserlessBackend({
  url: 'http://localhost:3000',
  token: 'optional-browserless-token',
});
```

### Playwright WebKit (emulated Safari)

Uses `playwright.webkit.launchServer()` for WebKit sessions. Same rendering engine as Safari. Supports device emulation profiles (iPhone 15, iPad Pro 11, iPad Air, etc.).

```typescript
import { PlaywrightBackend } from 'agent-browser-farm';

new PlaywrightBackend({ headless: true });
```

Requires: `pnpm add playwright-core && pnpm exec playwright install webkit`

### Safari Desktop (real Safari.app)

Uses macOS's built-in `safaridriver`. Real Safari.app — not emulated. WebDriver HTTP protocol.

```typescript
import { SafariDesktopBackend } from 'agent-browser-farm';

new SafariDesktopBackend({ capacity: 4 });
```

Requires: macOS, `safaridriver --enable` (one-time sudo), Safari > Develop > Allow Remote Automation.

### iOS Safari (simulators)

Real Safari on iOS simulators via Appium + XCUITest. Supports iPhone and iPad device types. Clones from pre-warmed templates for fast startup (~3-5s).

```typescript
import { IosSafariBackend } from 'agent-browser-farm';

new IosSafariBackend({
  appiumUrl: 'http://localhost:4723',
  templates: {
    iPhone: 'template-iphone-udid',
    iPad: 'template-ipad-udid',
  },
  capacity: 8,
});
```

Setup: `./scripts/setup-mac-host.sh`

### iOS Device (physical)

Real Safari on physical iOS devices via Appium. Requires USB connection and Apple Developer account for WDA code signing.

```typescript
import { IosDeviceBackend } from 'agent-browser-farm';

new IosDeviceBackend({
  appiumUrl: 'http://localhost:4723',
  devices: [
    { udid: 'DEVICE_UDID_1', name: 'iPhone 15 Pro' },
    { udid: 'DEVICE_UDID_2', name: 'iPad Air' },
  ],
  xcodeOrgId: 'YOUR_TEAM_ID',
});
```

### Android (emulators)

Android Chrome via direct ADB + CDP. No Appium — uses Chrome's built-in CDP protocol. Same WebSocket protocol as desktop Chrome.

```typescript
import { AndroidBackend } from 'agent-browser-farm';

new AndroidBackend({
  avdName: 'chrome-farm',
  capacity: 4,
});
```

Setup: `./scripts/setup-android.sh`

### Android Device (physical)

Physical Android devices connected via USB. Auto-discovers devices or accepts explicit serial list.

```typescript
import { AndroidDeviceBackend } from 'agent-browser-farm';

new AndroidDeviceBackend({
  devices: ['SERIAL1', 'SERIAL2'], // optional — auto-discovers if omitted
});
```

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9222` | Server port |
| `API_TOKEN` | _(empty)_ | Bearer token for API auth. Empty = no auth. |
| `BROWSERLESS_URL` | `http://localhost:3000` | Default Browserless backend URL |
| `BROWSERLESS_TOKEN` | _(empty)_ | Browserless auth token |
| `MAX_SESSIONS` | `20` | Global max concurrent sessions |
| `MAX_PER_CLIENT` | `5` | Max concurrent sessions per clientId |
| `SESSION_TIMEOUT` | `300` | Default session timeout (seconds) |
| `IDLE_TIMEOUT` | `300` | Idle session timeout before reaping (seconds) |
| `REAPER_INTERVAL` | `30` | Reaper sweep interval (seconds) |
| `HEALTH_CHECK_INTERVAL` | `30` | Backend health check interval (seconds) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Deployment

### Desktop only (Docker)

```bash
docker compose up -d
# Farm on :9222, Browserless on :3000
```

### Hybrid (desktop + mobile)

```
Linux/Cloud Host                    macOS Host (Mac Mini/Studio)
├── agent-browser-farm              ├── Appium (port 4723)
├── Browserless (Docker)            ├── Xcode + iOS simulators
└── Android SDK + emulators         ├── safaridriver
                                    └── WebDriverAgent
```

Register Mac backends at runtime via `POST /backends` or programmatically in your startup script.

## Architecture

```
Client
  │
  ├── POST /sessions ──→ Allocator ──→ Backend.createSession()
  │                        │              ├── BrowserlessBackend  → WS endpoint
  │                        │              ├── PlaywrightBackend   → WS endpoint
  │                        │              ├── SafariDesktopBackend → WebDriver URL
  │                        │              ├── IosSafariBackend    → WebDriver URL
  │                        │              ├── IosDeviceBackend    → WebDriver URL
  │                        │              ├── AndroidBackend      → WS endpoint
  │                        │              └── AndroidDeviceBackend → WS endpoint
  │                        │
  │                        ├── enforce per-client limits
  │                        ├── track session lifecycle
  │                        └── auto-reap expired/idle sessions
  │
  └── ws://farm/session/id ──→ SessionProxy ──→ upstream WS (CDP/Playwright)
```

**Dual-protocol design**: Desktop and Android browsers use WebSocket (CDP/Playwright protocol) via the farm's WS proxy. Safari and iOS use WebDriver HTTP (safaridriver/Appium) — clients connect directly to the WebDriver URL.

## Development

```bash
pnpm install
pnpm dev          # tsx watch mode
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc → dist/
```

## License

MIT
