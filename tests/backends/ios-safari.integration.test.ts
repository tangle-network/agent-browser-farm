import { IosSafariBackend } from '../../src/backends/ios-safari.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'IosSafariBackend (simulator)',
  browser: 'ios-safari',
  create: async () => new IosSafariBackend({
    id: 'ios-contract',
    templateUdid: process.env.IOS_TEMPLATE_UDID ?? 'unknown',
    capacity: 1,
  }),
  available: async () => {
    if (process.platform !== 'darwin') return false
    if (!process.env.IOS_TEMPLATE_UDID) return false
    try {
      const { execSync } = await import('node:child_process')
      execSync('which appium', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
})
