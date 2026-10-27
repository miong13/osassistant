import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CharacterInfo, CharacterLoadError, CharacterState, StateAsset } from '../../shared/types'

export const ASSET_SCHEME = 'osa-character'

const STATES = ['idle', 'greet', 'listen', 'think', 'talk', 'tip', 'sleep', 'error'] as const

const assetSchema = z.union([
  z.string().min(1),
  z.object({
    sheet: z.string().min(1),
    frameWidth: z.number().positive(),
    frameHeight: z.number().positive(),
    frames: z.number().int().positive(),
    fps: z.number().positive().max(60)
  })
])

const packSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id may only contain lowercase letters, numbers and -'),
  name: z.string().min(1),
  persona: z.string().default(''),
  greeting: z.string().default('Hi! What can I help you with?'),
  tips: z.array(z.string()).default([]),
  size: z
    .object({ width: z.number().min(32).max(400), height: z.number().min(32).max(400) })
    .default({ width: 140, height: 140 }),
  states: z
    .object({ idle: assetSchema })
    .catchall(assetSchema)
    .superRefine((states, ctx) => {
      for (const key of Object.keys(states)) {
        if (!(STATES as readonly string[]).includes(key))
          ctx.addIssue({ code: 'custom', message: `Unknown state "${key}". Use: ${STATES.join(', ')}` })
      }
    })
})

/** Resolve a file inside a pack folder; null if it would escape the folder. */
export function safeJoin(dir: string, file: string): string | null {
  const full = resolve(dir, file)
  const rel = relative(dir, full)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

export function parsePack(dir: string, json: string, builtIn: boolean): CharacterInfo {
  const data = packSchema.parse(JSON.parse(json))
  const states: Partial<Record<CharacterState, StateAsset>> = {}
  for (const [state, value] of Object.entries(data.states)) {
    const file = typeof value === 'string' ? value : value.sheet
    const full = safeJoin(dir, file)
    if (!full) throw new Error(`State "${state}" points outside the pack folder`)
    if (!existsSync(full)) throw new Error(`Missing file for state "${state}": ${file}`)
    const src = `${ASSET_SCHEME}://${data.id}/${file.split(/[\\/]/).map(encodeURIComponent).join('/')}`
    states[state as CharacterState] =
      typeof value === 'string'
        ? { type: 'image', src }
        : { type: 'sprite', src, frameWidth: value.frameWidth, frameHeight: value.frameHeight, frames: value.frames, fps: value.fps }
  }
  return {
    id: data.id,
    name: data.name,
    persona: data.persona,
    greeting: data.greeting,
    tips: data.tips,
    size: data.size,
    states: states as CharacterInfo['states'],
    builtIn
  }
}

export class CharacterLibrary {
  private characters = new Map<string, CharacterInfo>()
  private dirs = new Map<string, string>()
  private errors: CharacterLoadError[] = []

  constructor(
    private builtInDir: string,
    readonly userDir: string
  ) {}

  load(): { characters: CharacterInfo[]; errors: CharacterLoadError[] } {
    this.characters.clear()
    this.dirs.clear()
    this.errors = []
    mkdirSync(this.userDir, { recursive: true })
    this.scan(this.builtInDir, true)
    this.scan(this.userDir, false)
    return this.list()
  }

  list(): { characters: CharacterInfo[]; errors: CharacterLoadError[] } {
    return { characters: [...this.characters.values()], errors: this.errors }
  }

  get(id: string): CharacterInfo | undefined {
    return this.characters.get(id) ?? this.characters.values().next().value
  }

  /** Absolute path of an asset requested through the custom protocol. */
  assetPath(id: string, file: string): string | null {
    const dir = this.dirs.get(id)
    return dir ? safeJoin(dir, file) : null
  }

  private scan(root: string, builtIn: boolean): void {
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      if (!statSync(dir).isDirectory()) continue
      const manifest = join(dir, 'character.json')
      if (!existsSync(manifest)) continue
      try {
        const info = parsePack(dir, readFileSync(manifest, 'utf8'), builtIn)
        if (this.characters.has(info.id) && builtIn === false && this.characters.get(info.id)!.builtIn) {
          throw new Error(`id "${info.id}" is already used by a built-in character`)
        }
        this.characters.set(info.id, info)
        this.dirs.set(info.id, dir)
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join('.') || 'character.json'}: ${i.message}`).join('; ')
            : err instanceof Error
              ? err.message
              : String(err)
        this.errors.push({ folder: dir, message })
      }
    }
  }
}
