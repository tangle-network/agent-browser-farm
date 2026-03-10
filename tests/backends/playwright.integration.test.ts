import { PlaywrightBackend } from '../../src/backends/playwright.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'PlaywrightBackend (webkit)',
  browser: 'webkit',
  create: async () => new PlaywrightBackend({ id: 'pw-contract', headless: true }),
  available: async () => {
    try {
      await import('playwright-core').catch(() => import('playwright'))
      return true
    } catch {
      return false
    }
  },
})
