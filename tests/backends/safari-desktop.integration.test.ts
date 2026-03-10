import { SafariDesktopBackend } from '../../src/backends/safari-desktop.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'SafariDesktopBackend',
  browser: 'safari',
  create: async () => new SafariDesktopBackend({ id: 'sd-contract', capacity: 2, basePort: 9600 }),
  available: async () => {
    if (process.platform !== 'darwin') return false
    try {
      // Spawn safaridriver, try to create a session, then clean up
      const { execFileSync, spawnSync } = await import('node:child_process')
      execFileSync('which', ['safaridriver'], { stdio: 'ignore' })
      // Quick probe: start safaridriver on a temp port and hit /status
      const { spawn } = await import('node:child_process')
      const driver = spawn('safaridriver', ['--port', '9599'], { stdio: 'ignore' })
      await new Promise(r => setTimeout(r, 1000))
      try {
        const res = await fetch('http://localhost:9599/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'safari' } } }),
          signal: AbortSignal.timeout(10000),
        })
        if (res.ok) {
          const data = await res.json() as { value: { sessionId: string } }
          // Delete the probe session
          await fetch(`http://localhost:9599/session/${data.value.sessionId}`, {
            method: 'DELETE', signal: AbortSignal.timeout(5000),
          }).catch(() => {})
          driver.kill()
          return true
        }
        driver.kill()
        return false
      } catch {
        driver.kill()
        return false
      }
    } catch {
      return false
    }
  },
})
