# Deployment Guide

agent-browser-farm runs as a standalone service. It allocates browser sessions across backends and exposes them via a unified HTTP + WebSocket API.

## Deployment Topologies

### Topology A: Desktop Browsers Only

Single host, Docker Compose. Simplest path.

```
┌─── Linux/Cloud Host ───────────────┐
│                                     │
│  agent-browser-farm  (:9222)        │
│       │                             │
│       └── Browserless  (:3000)      │
│            ├── Chromium             │
│            ├── Firefox              │
│            └── WebKit               │
└─────────────────────────────────────┘
```

```bash
# Clone and start
git clone https://github.com/tangle-network/agent-browser-farm.git
cd agent-browser-farm
cp .env.example .env
# Edit .env: set API_TOKEN
docker compose up -d
```

Both services run in Docker. Farm on `:9222`, Browserless on `:3000` (internal). Clients talk to the farm only.

**Hardware**: 2+ CPU cores, 4GB+ RAM. Each concurrent browser uses ~300-500MB.

### Topology B: Desktop + Mobile (Hybrid)

Farm on a Linux host. Mac host(s) for iOS Safari and macOS Safari. Android emulators on Linux.

```
┌─── Linux Host ──────────────────────┐     ┌─── macOS Host (Mac Mini/Studio) ──┐
│                                     │     │                                    │
│  agent-browser-farm  (:9222)  ◄─────│─────│── Appium  (:4723)                 │
│       │                             │     │    └── iOS Simulators (iPhone/iPad)│
│       ├── Browserless  (:3000)      │     │                                    │
│       │    ├── Chrome               │     │   safaridriver  (:9500+)           │
│       │    ├── Firefox              │     │    └── Safari.app                  │
│       │    └── WebKit               │     │                                    │
│       │                             │     └────────────────────────────────────┘
│       └── Android Emulators         │
│            └── ADB + CDP            │
│                                     │
└─────────────────────────────────────┘
```

**Linux host setup:**
```bash
# Start the farm + Browserless
docker compose up -d

# Set up Android emulators (optional)
ANDROID_HOME=/path/to/sdk ./scripts/setup-android.sh
```

**Mac host setup:**
```bash
# Install Appium, create simulator templates, pre-install WDA
./scripts/setup-mac-host.sh

# Start Appium
appium --port 4723 --use-drivers xcuitest
```

**Register backends at runtime:**
```bash
FARM=http://linux-host:9222

# iOS Safari (iPhone + iPad simulators)
curl -X POST $FARM/backends \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "type": "ios-safari",
    "url": "http://mac-host:4723",
    "templates": {"iPhone": "IPHONE_TEMPLATE_UDID", "iPad": "IPAD_TEMPLATE_UDID"},
    "capacity": 8
  }'

# macOS Safari
curl -X POST $FARM/backends \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"type": "safari-desktop", "capacity": 4}'

# Android emulators
curl -X POST $FARM/backends \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"type": "android", "avdName": "chrome-farm", "capacity": 4}'
```

Or register programmatically in a startup script:
```typescript
import { createApp, BrowserlessBackend, IosSafariBackend, AndroidBackend, SafariDesktopBackend } from 'agent-browser-farm'

const app = createApp({
  backends: [
    new BrowserlessBackend({ url: 'http://localhost:3000' }),
    new IosSafariBackend({
      appiumUrl: 'http://mac-host:4723',
      templates: { iPhone: 'UDID1', iPad: 'UDID2' },
      capacity: 8,
    }),
    new SafariDesktopBackend({ capacity: 4 }),
    new AndroidBackend({ avdName: 'chrome-farm', capacity: 4 }),
  ],
})
```

### Topology C: Physical Devices

Same as Topology B, but with USB-connected devices added to the pool.

```bash
# Physical Android devices (auto-discovers via adb devices)
curl -X POST $FARM/backends \
  -H 'Content-Type: application/json' \
  -d '{"type": "android-device"}'

# Physical iOS devices (requires Apple Developer Team ID for WDA signing)
curl -X POST $FARM/backends \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "ios-device",
    "url": "http://mac-host:4723",
    "devices": [
      {"udid": "00008101-000A1234ABCD5678", "name": "iPhone 15 Pro"},
      {"udid": "00008103-000B5678EFGH9012", "name": "iPad Air"}
    ],
    "xcodeOrgId": "YOUR_APPLE_TEAM_ID"
  }'
```

## Hardware Recommendations

| Backend | Hardware | Capacity |
|---------|----------|----------|
| Browserless (desktop) | 2 CPU / 4GB RAM | ~10 concurrent sessions |
| Browserless (desktop) | 4 CPU / 8GB RAM | ~20 concurrent sessions |
| Android emulators | 4 CPU / 8GB RAM (x86_64 or ARM) | 4 concurrent emulators |
| iOS simulators | Mac Mini M2+ / 16GB RAM | 8-10 concurrent simulators |
| iOS simulators | Mac Studio M2+ / 32GB RAM | 12-16 concurrent simulators |
| macOS Safari | Any Mac | 4 concurrent safaridriver processes |
| Physical devices | USB hub + devices | 1 session per device |

## Environment Variables

See `.env.example` for the full list. Key production settings:

```bash
# Auth — always set in production
API_TOKEN=your-secure-random-token

# Tune to your hardware
MAX_SESSIONS=20
MAX_PER_CLIENT=5

# Increase for long-running agent sessions
SESSION_TIMEOUT=600
IDLE_TIMEOUT=600
```

## Running Without Docker

```bash
pnpm install
pnpm build
node dist/main.js
```

Set `BROWSERLESS_URL` to an existing Browserless instance, or register backends programmatically.

## Health Monitoring

```bash
# Pool status across all backends
curl http://localhost:9222/health

# List backends with health
curl -H 'Authorization: Bearer TOKEN' http://localhost:9222/backends
```

The farm runs periodic health checks (default: every 30s) against all backends. Unhealthy backends are deprioritized but not removed — they recover automatically when the health check passes again.

## Scaling

The farm is single-process, in-memory. For horizontal scaling:
- Run multiple farm instances behind a load balancer
- Each instance manages its own set of backends
- Sessions are pinned to the instance that created them (no shared state)

For most workloads, a single instance handles 50-100+ concurrent sessions easily — the bottleneck is always backend capacity (browser processes, simulators, devices), not the farm process.
