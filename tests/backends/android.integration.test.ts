import { AndroidBackend } from '../../src/backends/android.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'AndroidBackend (emulator)',
  browser: 'android-chrome',
  create: async () => new AndroidBackend({ id: 'and-contract', capacity: 1 }),
  available: async () => {
    if (!process.env.ANDROID_HOME) return false
    try {
      const { execSync } = await import('node:child_process')
      execSync('adb version', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
})
