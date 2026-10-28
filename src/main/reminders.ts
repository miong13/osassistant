import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { exposedToolName } from '../shared/mcpConfig'
import type { McpToolInfo, ToolPermission } from '../shared/types'
import { singleLine, stripHiddenChars } from './guards'
import type { ToolCallResult, ToolHost } from './mcp/manager'
import type { ToolDef } from './providers/types'

export const REMINDERS_SERVER = 'reminders'
const CHECK_EVERY = 15_000
const MAX_MESSAGE = 300
const MAX_REMINDERS = 200
const MAX_MINUTES = 366 * 24 * 60

export interface Reminder {
  id: string
  message: string
  /** When it fires, in ms since 1970. */
  dueAt: number
  createdAt: number
}

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'set_reminder',
    description:
      'Remind the user about something later: the character pops up with the message at that time. ' +
      'Give either in_minutes (e.g. "in 20 minutes" = 20, "in 2 hours" = 120) or at (local 24-hour time, ' +
      'e.g. "3pm" = "15:00"), optionally with date. Without a date, "at" means the next time that clock time comes round. ' +
      'The result says the exact time it was set for; tell the user.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind them about, short, e.g. "Call Sam"' },
        in_minutes: { type: 'number', description: 'Minutes from now' },
        at: { type: 'string', description: 'Local time, 24-hour HH:MM' },
        date: { type: 'string', description: 'Local date YYYY-MM-DD, only with "at"' }
      },
      required: ['message']
    }
  },
  {
    name: 'list_reminders',
    description: "List the user's upcoming reminders with their ids and times.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel an upcoming reminder by its id (from list_reminders).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
]

const exposed = (tool: string) => exposedToolName(REMINDERS_SERVER, tool)

class ReminderError extends Error {}

/** Work out when a reminder is due. Throws a ReminderError with a message for the model. */
export function dueTime(args: { in_minutes?: unknown; at?: unknown; date?: unknown }, now: number): number {
  const hasIn = args.in_minutes !== undefined && args.in_minutes !== null
  const hasAt = typeof args.at === 'string' && args.at.trim() !== ''
  if (hasIn === hasAt) throw new ReminderError('Give exactly one of in_minutes or at.')
  if (hasIn) {
    const minutes = Number(args.in_minutes)
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES)
      throw new ReminderError('in_minutes must be between 1 and 527040 (a year).')
    return now + Math.round(minutes * 60_000)
  }
  const time = /^(\d{1,2}):(\d{2})$/.exec(String(args.at).trim())
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new ReminderError('at must be a 24-hour time like "15:00".')
  const due = new Date(now)
  if (args.date !== undefined && args.date !== null && args.date !== '') {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.date).trim())
    if (!day) throw new ReminderError('date must look like "2026-11-03".')
    due.setFullYear(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    if (due.getMonth() !== Number(day[2]) - 1) throw new ReminderError('That date does not exist.')
  }
  due.setHours(Number(time[1]), Number(time[2]), 0, 0)
  if (args.date === undefined || args.date === null || args.date === '') {
    if (due.getTime() <= now) due.setDate(due.getDate() + 1)
  } else if (due.getTime() <= now) {
    throw new ReminderError('That time has already passed.')
  }
  if (due.getTime() - now > MAX_MINUTES * 60_000) throw new ReminderError('Reminders can be at most a year ahead.')
  return due.getTime()
}

/** "Wed 29 Oct, 15:00" in the user's locale and time zone. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export interface RemindersDeps {
  /** Where reminders are saved; omit to keep them in memory (tests). */
  file?: string
  now?: () => number
}

/**
 * Reminders the user asks for in chat. Saved to disk so they survive restarts; ones that came due
 * while the app was closed fire on the next start, marked as late.
 */
export class Reminders implements ToolHost {
  private items: Reminder[]
  private byName = new Map(TOOLS.map((t) => [exposed(t.name), t]))
  private timer: NodeJS.Timeout | undefined

  constructor(private deps: RemindersDeps = {}) {
    this.items = this.load()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  info(): McpToolInfo[] {
    return TOOLS.map((t) => ({
      name: exposed(t.name),
      server: REMINDERS_SERVER,
      originalName: t.name,
      description: t.description,
      defaultPermission: 'allow'
    }))
  }

  /** Reminders only affect this app, so they don't need approval unless the user says so. */
  defaultPermission(name: string): ToolPermission | undefined {
    return this.byName.has(name) ? 'allow' : undefined
  }

  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[] {
    return TOOLS.filter((t) => permissions[exposed(t.name)] !== 'disabled').map((t) => ({
      name: exposed(t.name),
      description: `[${REMINDERS_SERVER}] ${t.description}`,
      inputSchema: t.inputSchema
    }))
  }

  inputSchema(name: string): Record<string, unknown> | undefined {
    return this.byName.get(name)?.inputSchema
  }

  async callTool(name: string, input: unknown, _signal?: AbortSignal): Promise<ToolCallResult> {
    const tool = this.byName.get(name)
    if (!tool) return { content: `Tool "${name}" is not available.`, isError: true }
    const args = (input ?? {}) as Record<string, unknown>
    try {
      return { content: this.run(tool.name, args), isError: false }
    } catch (err) {
      if (err instanceof ReminderError) return { content: err.message, isError: true }
      throw err
    }
  }

  private run(tool: string, args: Record<string, unknown>): string {
    if (tool === 'set_reminder') {
      const message = singleLine(stripHiddenChars(String(args.message ?? '')), MAX_MESSAGE)
      if (!message) throw new ReminderError('message is required.')
      const r = this.add(message, dueTime(args, this.now()))
      return `Reminder set for ${formatWhen(r.dueAt)} (id ${r.id}): ${r.message}`
    }
    if (tool === 'list_reminders') {
      const list = this.upcoming()
      if (!list.length) return 'No upcoming reminders.'
      return list.map((r) => `- ${formatWhen(r.dueAt)} (id ${r.id}): ${r.message}`).join('\n')
    }
    const id = String(args.id ?? '')
    const r = this.items.find((x) => x.id === id)
    if (!r) throw new ReminderError(`No upcoming reminder with id ${id}.`)
    this.items = this.items.filter((x) => x.id !== id)
    this.save()
    return `Cancelled the reminder for ${formatWhen(r.dueAt)}: ${r.message}`
  }

  add(message: string, dueAt: number): Reminder {
    if (this.items.length >= MAX_REMINDERS) throw new ReminderError('Too many reminders. Cancel some first.')
    const r: Reminder = { id: crypto.randomUUID().slice(0, 8), message, dueAt, createdAt: this.now() }
    this.items.push(r)
    this.save()
    return r
  }

  upcoming(): Reminder[] {
    return [...this.items].sort((a, b) => a.dueAt - b.dueAt)
  }

  /** Remove and return reminders that are due. `late` is true when one is more than a minute overdue. */
  takeDue(): { reminder: Reminder; late: boolean }[] {
    const now = this.now()
    const due = this.items.filter((r) => r.dueAt <= now)
    if (!due.length) return []
    this.items = this.items.filter((r) => r.dueAt > now)
    this.save()
    return due.sort((a, b) => a.dueAt - b.dueAt).map((reminder) => ({ reminder, late: now - reminder.dueAt > 60_000 }))
  }

  /** Check every few seconds. Polling (not one long timer) keeps working across sleep and clock changes. */
  start(onDue: (reminder: Reminder, late: boolean) => void): void {
    const tick = () => {
      for (const d of this.takeDue()) onDue(d.reminder, d.late)
    }
    tick()
    this.timer = setInterval(tick, CHECK_EVERY)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private load(): Reminder[] {
    const file = this.deps.file
    if (!file || !existsSync(file)) return []
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(data)
        ? data.filter(
            (r): r is Reminder =>
              r && typeof r.id === 'string' && typeof r.message === 'string' && Number.isFinite(r.dueAt)
          )
        : []
    } catch {
      return []
    }
  }

  private save(): void {
    const file = this.deps.file
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.items, null, 2))
    renameSync(tmp, file)
  }
}
