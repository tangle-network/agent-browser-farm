# Integration Guide

browser-farm is a standalone background service. It doesn't embed into other packages — other systems call its HTTP API to allocate browser sessions and connect to them.

## Integration Points

```
┌─────────────────────────────────────────────────────────────┐
│                     browser-farm                       │
│                        (port 9222)                           │
│                                                              │
│  POST /sessions → allocate browser → return wsEndpoint       │
│  ws://farm/session/:id → CDP/Playwright relay                │
│  DELETE /sessions/:id → tear down browser                    │
└──────────┬──────────────────────────────────┬────────────────┘
           │                                  │
           ▼                                  ▼
┌─────────────────────┐          ┌─────────────────────────┐
│ agent-dev-container  │          │  browser-agent-driver    │
│   (orchestrator)     │          │  (AI browser agent)      │
│                      │          │                          │
│ Allocates sessions   │          │ Connects to wsEndpoint   │
│ per sidecar, injects │          │ via connectOverCDP()     │
│ BROWSER_ENDPOINT     │          │ instead of local launch  │
└──────────────────────┘          └─────────────────────────┘
```

## agent-dev-container (Orchestrator)

The orchestrator manages sandboxed sidecars. Each sidecar runs browser-agent-driver. The orchestrator is responsible for allocating a browser session from the farm and injecting the endpoint into the sidecar's environment.

### Existing Infrastructure

The orchestrator already has `REMOTE_BROWSER_ENDPOINTS` support:

```typescript
// container-config.ts — parseRemoteBrowserEndpoints()
// Format: "name1=ws://host:port,name2=ws://host2:port2"
// Parsed into Record<string, string>
```

This is a static mapping — all sidecars share the same endpoints. For the farm, we want **dynamic per-sidecar allocation** instead.

### Integration Path

In the orchestrator's sidecar startup flow (container-config.ts), add a farm allocation step:

```typescript
import { BrowserFarmClient } from 'browser-farm/client'

const farm = new BrowserFarmClient(process.env.BROWSER_FARM_URL!, {
  token: process.env.BROWSER_FARM_TOKEN,
})

// On sidecar start: allocate a session
async function allocateBrowserForSidecar(sidecarId: string, browser: string = 'chrome') {
  const session = await farm.createSession({
    browser,
    clientId: sidecarId,
    timeout: 600, // match sidecar lifetime
  })

  // Inject the specific wsEndpoint into the sidecar's env
  return {
    BROWSER_ENDPOINT: session.wsEndpoint,
    BROWSER_SESSION_ID: session.sessionId,
  }
}

// On sidecar stop: release the session
async function releaseBrowserForSidecar(sessionId: string) {
  await farm.destroySession(sessionId)
}
```

Each sidecar gets its own isolated browser session. The farm handles concurrency limits, health checks, and cleanup.

### Environment Variables (Orchestrator)

```bash
# Point the orchestrator at the farm
BROWSER_FARM_URL=http://farm-host:9222
BROWSER_FARM_TOKEN=your-token

# Optional: default browser type for sidecars
BROWSER_FARM_DEFAULT_BROWSER=chrome
```

### No Sandbox SDK Changes Needed

The Sandbox SDK doesn't need to know about the farm. The orchestrator allocates sessions and injects `BROWSER_ENDPOINT` — the sidecar's driver just connects to whatever endpoint it receives. The farm is invisible to SDK consumers.

## browser-agent-driver (AI Browser Agent)

The driver currently launches browsers locally:

```typescript
// Current: local browser launch
const browser = await browserType.launch({ headless: true })
```

To use farm-allocated browsers, the driver needs a remote connection path:

```typescript
// Remote: connect to farm-allocated session
import { chromium } from 'playwright'

const endpoint = process.env.BROWSER_ENDPOINT
if (endpoint) {
  // Farm-allocated browser — connect over CDP
  const browser = await chromium.connectOverCDP(endpoint)
} else {
  // Local fallback — launch directly
  const browser = await browserType.launch({ headless: true })
}
```

This is ~10 lines of change in the driver's browser initialization. The rest of the driver (navigation, AI loop, actions) works identically — Playwright's API is the same whether the browser is local or remote.

### What Works Over CDP

All desktop and Android browsers served by the farm use CDP or Playwright WebSocket protocol. Playwright's `connectOverCDP()` works with all of them:

| Farm Browser | Driver Connection |
|-------------|-------------------|
| `chrome` | `chromium.connectOverCDP(wsEndpoint)` |
| `firefox` | `firefox.connect(wsEndpoint)` |
| `webkit` | `webkit.connect(wsEndpoint)` |
| `android-chrome` | `chromium.connectOverCDP(wsEndpoint)` |

### WebDriver Browsers (Safari, iOS Safari)

Safari and iOS Safari use WebDriver HTTP protocol, not WebSocket. The driver would need a WebDriver client (like `webdriverio`) to control these browsers. This is a separate integration — most agent workflows target Chrome/Firefox/WebKit where CDP works.

## abd-app (Frontend)

abd-app doesn't integrate with the farm directly. If the app needs to show browser previews (mobile device frames, Safari rendering), it would:

1. Call the farm's HTTP API to allocate a session
2. Connect to the session's WebSocket endpoint for CDP
3. Use CDP's `Page.screencastFrame` to stream frames to the UI

```typescript
// Example: streaming browser frames to the UI
const session = await fetch('http://farm:9222/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ browser: 'chrome' }),
}).then(r => r.json())

// Connect via CDP and use Page.startScreencast
const ws = new WebSocket(session.wsEndpoint)
```

This is optional and out of scope for the initial integration. The primary path is orchestrator → farm → driver.

## Blueprint Agents (Tangle)

Blueprint agents running in sandboxes get browsers through the same path as any other sidecar:

1. Orchestrator allocates a farm session for the sandbox
2. `BROWSER_ENDPOINT` is injected into the sandbox environment
3. The blueprint's driver connects to it

No blueprint-specific integration needed. The farm is a shared service that the orchestrator manages.

## Integration Order

1. **Deploy the farm** — Docker Compose on a Linux host (see DEPLOYMENT.md)
2. **Update browser-agent-driver** — Add `BROWSER_ENDPOINT` env check, use `connectOverCDP()` when set
3. **Update agent-dev-container** — Add per-sidecar session allocation/teardown in the orchestrator
4. **Optional: abd-app** — Add browser preview streaming if needed

Steps 2 and 3 are independent and can be done in parallel. The farm runs standalone and serves any client that calls its API.

## Network Topology

```
┌─── Cloud / Linux Host ─────────────────────────┐
│                                                  │
│  browser-farm (:9222)                      │
│       ├── Browserless (:3000, internal)          │
│       └── Android emulators (optional)           │
│                                                  │
│  agent-dev-container (orchestrator)              │
│       └── Sidecars (each gets BROWSER_ENDPOINT)  │
│             └── browser-agent-driver             │
│                  └── connectOverCDP(endpoint)     │
│                                                  │
└──────────────────────────────────────────────────┘

         ┌─── macOS Host (optional) ───────────┐
         │  Appium (:4723)                      │
         │  iOS Simulators                      │
         │  safaridriver                        │
         └──────────────────────────────────────┘
```

The farm and orchestrator should run on the same host or local network — WebSocket latency matters for CDP. The Mac host (for iOS/Safari) can be remote since WebDriver HTTP is less latency-sensitive.
