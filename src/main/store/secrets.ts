import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * API keys, encrypted with the OS keychain (safeStorage) and stored as base64.
 * Keys stay in the main process and are never sent to the renderer.
 */
export class SecretStore {
  private data: Record<string, string> = {}

  constructor(private file: string) {
    try {
      if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      this.data = {}
    }
  }

  get(id: string): string | undefined {
    const stored = this.data[id]
    if (!stored) return undefined
    try {
      if (stored.startsWith('plain:')) return stored.slice(6)
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return undefined
    }
  }

  has(id: string): boolean {
    return Boolean(this.data[id])
  }

  set(id: string, value: string | null): void {
    if (!value) delete this.data[id]
    else if (safeStorage.isEncryptionAvailable())
      this.data[id] = safeStorage.encryptString(value).toString('base64')
    else this.data[id] = 'plain:' + value
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }
}
