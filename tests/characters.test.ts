import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CharacterLibrary } from '../src/main/characters/loader'

describe('CharacterLibrary', () => {
  it('loads the built-in characters', () => {
    const lib = new CharacterLibrary(join(__dirname, '../resources/characters'), mkdtempSync(join(tmpdir(), 'osa-')))
    const { characters, errors } = lib.load()
    expect(errors).toEqual([])
    expect(characters.map((c) => c.id).sort()).toEqual(['bolt', 'mochi', 'ninja', 'sticky'])
    for (const c of characters) expect(c.states.idle.type).toBe('image')
  })

  it('reports broken packs instead of crashing', () => {
    const user = mkdtempSync(join(tmpdir(), 'osa-'))
    mkdirSync(join(user, 'bad'))
    writeFileSync(join(user, 'bad', 'character.json'), JSON.stringify({ id: 'bad', name: 'Bad', states: { idle: 'missing.svg' } }))
    mkdirSync(join(user, 'escape'))
    writeFileSync(join(user, 'escape', 'character.json'), JSON.stringify({ id: 'escape', name: 'E', states: { idle: '../../etc/passwd' } }))
    mkdirSync(join(user, 'good'))
    writeFileSync(join(user, 'good', 'idle.gif'), '')
    writeFileSync(join(user, 'good', 'character.json'), JSON.stringify({ id: 'good', name: 'Good', states: { idle: 'idle.gif' } }))
    const lib = new CharacterLibrary(join(user, 'none'), user)
    const { characters, errors } = lib.load()
    expect(characters.map((c) => c.id)).toEqual(['good'])
    expect(errors).toHaveLength(2)
    expect(lib.assetPath('good', '../escape/character.json')).toBeNull()
    expect(lib.assetPath('good', 'idle.gif')).toBe(join(user, 'good', 'idle.gif'))
  })
})
