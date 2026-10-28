import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { combineToolHosts } from '../src/main/mcp/manager'
import { Reminders, dueTime } from '../src/main/reminders'

// 2026-10-29 14:30 local time.
const NOW = new Date(2026, 9, 29, 14, 30, 0).getTime()
const signal = new AbortController().signal
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

describe('dueTime', () => {
  it('handles "in N minutes"', () => {
    expect(dueTime({ in_minutes: 20 }, NOW)).toBe(NOW + 20 * 60_000)
  })

  it('uses today for a later clock time, tomorrow for an earlier one', () => {
    expect(dueTime({ at: '15:00' }, NOW)).toBe(local(2026, 10, 29, 15, 0))
    expect(dueTime({ at: '9:15' }, NOW)).toBe(local(2026, 10, 30, 9, 15))
  })

  it('uses an explicit date', () => {
    expect(dueTime({ at: '08:00', date: '2026-11-03' }, NOW)).toBe(local(2026, 11, 3, 8, 0))
  })

  it('rejects bad or contradictory input', () => {
    expect(() => dueTime({}, NOW)).toThrow(/exactly one/)
    expect(() => dueTime({ in_minutes: 5, at: '15:00' }, NOW)).toThrow(/exactly one/)
    expect(() => dueTime({ in_minutes: 0 }, NOW)).toThrow(/between/)
    expect(() => dueTime({ at: '25:00' }, NOW)).toThrow(/24-hour/)
    expect(() => dueTime({ at: '3pm' }, NOW)).toThrow(/24-hour/)
    expect(() => dueTime({ at: '10:00', date: '2026-10-29' }, NOW)).toThrow(/already passed/)
    expect(() => dueTime({ at: '10:00', date: '2026-02-30' }, NOW)).toThrow(/does not exist/)
  })
})

describe('Reminders', () => {
  it('sets, lists and cancels through the tools', async () => {
    const r = new Reminders({ now: () => NOW })
    const set = await r.callTool('reminders__set_reminder', { message: 'Call Sam', in_minutes: 20 }, signal)
    expect(set.isError).toBe(false)
    const id = /id (\w+)/.exec(set.content)![1]
    expect((await r.callTool('reminders__list_reminders', {}, signal)).content).toContain('Call Sam')
    expect((await r.callTool('reminders__cancel_reminder', { id }, signal)).content).toMatch(/Cancelled/)
    expect((await r.callTool('reminders__list_reminders', {}, signal)).content).toBe('No upcoming reminders.')
  })

  it('returns tool errors instead of throwing', async () => {
    const r = new Reminders({ now: () => NOW })
    expect(await r.callTool('reminders__set_reminder', { message: 'x' }, signal)).toMatchObject({ isError: true })
    expect(await r.callTool('reminders__set_reminder', { message: '  ', in_minutes: 5 }, signal)).toMatchObject({
      isError: true
    })
    expect(await r.callTool('reminders__cancel_reminder', { id: 'nope' }, signal)).toMatchObject({ isError: true })
  })

  it('hands out due reminders once, in order, and marks late ones', () => {
    let now = NOW
    const r = new Reminders({ now: () => now })
    r.add('later', NOW + 10 * 60_000)
    r.add('soon', NOW + 60_000)
    expect(r.takeDue()).toEqual([])
    now = NOW + 60_000
    expect(r.takeDue().map((d) => [d.reminder.message, d.late])).toEqual([['soon', false]])
    now = NOW + 60 * 60_000 // the app was closed for a while
    expect(r.takeDue().map((d) => [d.reminder.message, d.late])).toEqual([['later', true]])
    expect(r.takeDue()).toEqual([])
  })

  it('keeps reminders across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'osa-')), 'reminders.json')
    new Reminders({ file, now: () => NOW }).add('Water plants', NOW + 60_000)
    expect(new Reminders({ file, now: () => NOW }).upcoming().map((x) => x.message)).toEqual(['Water plants'])
  })

  it("doesn't need approval by default, through the combined tool host", () => {
    const host = combineToolHosts([new Reminders()])
    expect(host.defaultPermission?.('reminders__set_reminder')).toBe('allow')
    expect(host.defaultPermission?.('desktop__open_app')).toBeUndefined()
  })
})
