import { BrowserlessBackend } from '../../src/backends/browserless.js'
import { backendContractSuite } from './contract.js'

const BROWSERLESS_URL = process.env.BROWSERLESS_URL ?? 'http://localhost:3000'

backendContractSuite({
  name: 'BrowserlessBackend (chrome)',
  browser: 'chrome',
  create: async () => new BrowserlessBackend({ url: BROWSERLESS_URL, id: 'bl-contract' }),
  available: async () => {
    try {
      const res = await fetch(`${BROWSERLESS_URL}/json/version`, {
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  },
})
