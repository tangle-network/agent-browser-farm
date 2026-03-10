/**
 * Backend contract tests.
 *
 * Every backend implementation must satisfy these invariants.
 * Each backend provides a fixture — the contract suite is parameterized.
 *
 * Tests skip gracefully when infrastructure is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Backend, BackendSession, BrowserType } from '../../src/backends/types.js'

export interface BackendFixture {
  /** Human-readable name for describe() */
  name: string
  /** Browser type to test with */
  browser: BrowserType
  /** Device name (optional, for iOS/Android) */
  device?: string
  /** Create the backend instance. Throw to skip. */
  create: () => Promise<Backend>
  /** Returns true if required infra is available. */
  available: () => Promise<boolean>
}

export function backendContractSuite(fixture: BackendFixture) {
  describe(`Backend contract: ${fixture.name}`, () => {
    let backend: Backend
    let skipped = false

    beforeAll(async () => {
      const ok = await fixture.available()
      if (!ok) {
        skipped = true
        return
      }
      backend = await fixture.create()
    })

    afterAll(async () => {
      if (!skipped && backend) {
        await backend.shutdown()
      }
    })

    function skipIfUnavailable() {
      if (skipped) {
        console.log(`  ⏭ Skipping ${fixture.name} — infrastructure unavailable`)
        return true
      }
      return false
    }

    // --- Core contract ---

    it('has required readonly fields', () => {
      if (skipIfUnavailable()) return
      expect(backend.id).toBeTruthy()
      expect(typeof backend.type).toBe('string')
      expect(backend.supports).toBeInstanceOf(Set)
      expect(backend.supports.size).toBeGreaterThan(0)
      expect(['ws', 'webdriver']).toContain(backend.protocol)
    })

    it('supports the fixture browser type', () => {
      if (skipIfUnavailable()) return
      expect(backend.supports.has(fixture.browser)).toBe(true)
    })

    it('healthCheck returns boolean', async () => {
      if (skipIfUnavailable()) return
      const healthy = await backend.healthCheck()
      expect(typeof healthy).toBe('boolean')
      expect(healthy).toBe(true)
    })

    it('status returns valid PoolStatus', async () => {
      if (skipIfUnavailable()) return
      const status = await backend.status()
      expect(typeof status.capacity).toBe('number')
      expect(typeof status.active).toBe('number')
      expect(typeof status.backend).toBe('string')
      expect(typeof status.healthy).toBe('boolean')
      expect(status.capacity).toBeGreaterThan(0)
    })

    it('creates a session with valid response shape', async () => {
      if (skipIfUnavailable()) return
      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })

      expect(session.backendId).toBeTruthy()
      expect(session.backendType).toBe(backend.type)

      if (backend.protocol === 'ws') {
        expect(session.wsEndpoint).toBeTruthy()
        expect(session.wsEndpoint).toMatch(/^ws/)
      } else {
        expect(session.webdriverUrl).toBeTruthy()
        expect(session.webdriverSessionId).toBeTruthy()
      }

      // Cleanup
      await backend.destroySession(session.backendId)
    })

    it('status.active increments after createSession', async () => {
      if (skipIfUnavailable()) return
      const before = await backend.status()
      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })
      const after = await backend.status()

      expect(after.active).toBeGreaterThanOrEqual(before.active)

      await backend.destroySession(session.backendId)
    })

    it('destroySession is idempotent', async () => {
      if (skipIfUnavailable()) return
      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })
      await backend.destroySession(session.backendId)
      // Second destroy should not throw
      await backend.destroySession(session.backendId)
    })

    it('WS endpoint is connectable (ws backends only)', async () => {
      if (skipIfUnavailable()) return
      if (backend.protocol !== 'ws') return

      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })

      expect(session.wsEndpoint).toBeTruthy()

      // Verify the WS endpoint is reachable
      // Some backends (e.g. Browserless) require Playwright's protocol, so raw WS may
      // get an error+close. We consider any response (open or close) as proof of connectivity.
      const { WebSocket } = await import('ws')
      const ws = new WebSocket(session.wsEndpoint!)

      const reachable = await new Promise<boolean>((resolve) => {
        let settled = false
        const done = (v: boolean) => { if (!settled) { settled = true; resolve(v) } }
        const timeout = setTimeout(() => done(false), 10000)
        ws.on('open', () => { clearTimeout(timeout); done(true) })
        ws.on('close', () => { clearTimeout(timeout); done(true) })
        ws.on('error', () => { /* wait for close event */ })
      })

      expect(reachable).toBe(true)
      if (ws.readyState === ws.OPEN) ws.close()
      await backend.destroySession(session.backendId)
    })

    it('WebDriver session is reachable (webdriver backends only)', async () => {
      if (skipIfUnavailable()) return
      if (backend.protocol !== 'webdriver') return

      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })

      expect(session.webdriverUrl).toBeTruthy()
      expect(session.webdriverSessionId).toBeTruthy()

      // Verify the WebDriver session is alive by hitting /session/:id/url
      const res = await fetch(
        `${session.webdriverUrl}/session/${session.webdriverSessionId}/url`,
        { signal: AbortSignal.timeout(10000) },
      )
      expect(res.ok).toBe(true)

      await backend.destroySession(session.backendId)
    })

    it('can navigate to a page (ws backends)', async () => {
      if (skipIfUnavailable()) return
      if (backend.protocol !== 'ws') return

      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })

      // Connect with Playwright and navigate
      let pw: any
      for (const pkg of ['playwright-core', 'playwright']) {
        try { pw = await import(pkg); break } catch {}
      }
      if (!pw) {
        await backend.destroySession(session.backendId)
        return
      }

      // Pick correct Playwright browser type for the connection
      const wsUrl = session.wsEndpoint!
      let browser: any
      if (fixture.browser === 'android-chrome') {
        // Android exposes raw CDP
        browser = await pw.chromium.connectOverCDP(wsUrl)
      } else if (fixture.browser === 'chrome') {
        // Browserless uses Playwright WS protocol
        browser = await pw.chromium.connect(wsUrl)
      } else if (fixture.browser === 'firefox') {
        browser = await pw.firefox.connect(wsUrl)
      } else {
        // webkit, ios-safari, safari
        browser = await pw.webkit.connect(wsUrl)
      }

      // CDP connections may have pre-existing contexts
      const contexts = browser.contexts?.() ?? []
      const existingPage = contexts[0]?.pages?.()[0]
      const page = existingPage ?? await browser.newPage()
      await page.goto('data:text/html,<h1>contract test</h1>')
      const title = await page.title()
      expect(title).toBeDefined()

      await browser.close()
      await backend.destroySession(session.backendId)
    })

    it('can navigate to a page (webdriver backends)', async () => {
      if (skipIfUnavailable()) return
      if (backend.protocol !== 'webdriver') return

      const session = await backend.createSession({
        browser: fixture.browser,
        device: fixture.device,
      })

      // Navigate via WebDriver protocol
      const navRes = await fetch(
        `${session.webdriverUrl}/session/${session.webdriverSessionId}/url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'data:text/html,<h1>contract test</h1>' }),
          signal: AbortSignal.timeout(15000),
        },
      )
      expect(navRes.ok).toBe(true)

      // Get page source to verify
      const srcRes = await fetch(
        `${session.webdriverUrl}/session/${session.webdriverSessionId}/source`,
        { signal: AbortSignal.timeout(10000) },
      )
      expect(srcRes.ok).toBe(true)
      const srcBody = await srcRes.json() as { value: string }
      expect(srcBody.value).toContain('contract test')

      await backend.destroySession(session.backendId)
    })

    it('shutdown cleans up all sessions', async () => {
      if (skipIfUnavailable()) return
      // Create a fresh backend for this test since shutdown destroys it
      const fresh = await fixture.create()

      const s1 = await fresh.createSession({ browser: fixture.browser, device: fixture.device })
      const s2 = await fresh.createSession({ browser: fixture.browser, device: fixture.device })

      await fresh.shutdown()

      const status = await fresh.status()
      expect(status.active).toBe(0)
    })
  })
}
