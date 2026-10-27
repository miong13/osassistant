import { appNameMatches, findApp, type InstalledApp } from './apps'

/** One option in a fallback list: an app (any of these names), or a website. */
export type Choice = { app: string[] } | { web: string; label: string }

export interface AppCategory {
  id: string
  /** Reads naturally in "No <label> is installed." */
  label: string
  /** Words people use for this kind of app ("spreadsheet", "video call"). */
  words: string[]
  mac: Choice[]
  win: Choice[]
}

export type CategoryPick = { app: InstalledApp } | { web: string; label: string }

const app = (...names: string[]): Choice => ({ app: names })
const web = (label: string, url: string): Choice => ({ web: url, label })

const LIBRE = (module: string) => app(`LibreOffice ${module}`, 'LibreOffice')
const OUTLOOK_WIN = [app('Outlook', 'Outlook (classic)', 'Microsoft Outlook'), app('Outlook (new)', 'New Outlook')]
const TEAMS = app('Microsoft Teams', 'Microsoft Teams (work or school)', 'Teams')

/**
 * Fallback order per kind of app: the first installed one wins. Every list ends with something that
 * is always there (a built-in app or a website), so asking for a type of app always opens something.
 * Order matters when an app name sits in two lists ("Outlook"): the earlier category is used.
 */
export const CATEGORIES: AppCategory[] = [
  {
    id: 'text-editor',
    label: 'text editor',
    words: ['text editor', 'plain text editor', 'editor', 'notes editor'],
    mac: [app('TextEdit')],
    win: [app('Notepad')]
  },
  {
    id: 'documents',
    label: 'word processor',
    words: ['document', 'documents', 'doc', 'docs', 'word processor', 'writer', 'writing app'],
    mac: [app('Microsoft Word', 'Word'), app('Pages', 'Pages Creator Studio'), LIBRE('Writer'), app('TextEdit')],
    win: [app('Microsoft Word', 'Word'), LIBRE('Writer'), app('WordPad'), app('Notepad')]
  },
  {
    id: 'spreadsheets',
    label: 'spreadsheet app',
    words: ['spreadsheet', 'spreadsheets', 'sheet', 'sheets', 'workbook'],
    mac: [app('Microsoft Excel', 'Excel'), app('Numbers', 'Numbers Creator Studio'), LIBRE('Calc'), web('Google Sheets', 'https://docs.google.com/spreadsheets')],
    win: [app('Microsoft Excel', 'Excel'), LIBRE('Calc'), web('Google Sheets', 'https://docs.google.com/spreadsheets')]
  },
  {
    id: 'presentations',
    label: 'presentation app',
    words: ['presentation', 'presentations', 'slides', 'slide deck', 'deck', 'slideshow'],
    mac: [app('Microsoft PowerPoint', 'PowerPoint'), app('Keynote', 'Keynote Creator Studio'), LIBRE('Impress'), web('Google Slides', 'https://docs.google.com/presentation')],
    win: [app('Microsoft PowerPoint', 'PowerPoint'), LIBRE('Impress'), web('Google Slides', 'https://docs.google.com/presentation')]
  },
  {
    id: 'code-editor',
    label: 'code editor',
    words: ['code editor', 'ide', 'programming editor'],
    mac: [app('Visual Studio Code', 'Code'), app('Cursor'), app('Sublime Text'), app('Zed'), app('TextEdit')],
    win: [app('Visual Studio Code', 'Code'), app('Cursor'), app('Sublime Text'), app('Notepad++'), app('Notepad')]
  },
  {
    id: 'browser',
    label: 'web browser',
    words: ['browser', 'web browser', 'internet', 'web'],
    mac: [app('Google Chrome'), app('Safari'), app('Firefox'), app('Microsoft Edge'), app('Arc'), app('Brave Browser')],
    win: [app('Google Chrome'), app('Microsoft Edge', 'Edge'), app('Firefox', 'Mozilla Firefox'), app('Brave')]
  },
  {
    id: 'email',
    label: 'email app',
    words: ['email', 'e-mail', 'mail', 'inbox', 'email app', 'mail app'],
    mac: [app('Microsoft Outlook', 'Outlook'), app('Mail'), web('Gmail', 'https://mail.google.com')],
    win: [...OUTLOOK_WIN, web('Outlook on the web', 'https://outlook.office.com/mail')]
  },
  {
    id: 'calendar',
    label: 'calendar app',
    words: ['calendar', 'calendars', 'schedule', 'agenda', 'calendar app'],
    mac: [app('Microsoft Outlook', 'Outlook'), app('Calendar'), web('Google Calendar', 'https://calendar.google.com')],
    win: [...OUTLOOK_WIN, web('Outlook Calendar on the web', 'https://outlook.office.com/calendar')]
  },
  {
    id: 'team-chat',
    label: 'team chat app',
    words: ['chat', 'team chat', 'work chat', 'chat app'],
    mac: [TEAMS, app('Slack'), web('Google Chat', 'https://chat.google.com')],
    win: [TEAMS, app('Slack'), web('Google Chat', 'https://chat.google.com')]
  },
  {
    id: 'video-calls',
    label: 'video call app',
    words: ['video call', 'video calls', 'video meeting', 'meeting', 'meetings', 'call app', 'conference call'],
    mac: [app('zoom.us', 'Zoom', 'Zoom Workplace'), TEAMS, web('Google Meet', 'https://meet.google.com'), app('FaceTime')],
    win: [app('Zoom', 'Zoom Workplace'), TEAMS, web('Google Meet', 'https://meet.google.com')]
  },
  {
    id: 'messaging',
    label: 'messaging app',
    words: ['messaging', 'messages', 'messenger', 'text message', 'texting'],
    mac: [app('WhatsApp'), app('Telegram'), app('Messages')],
    win: [app('WhatsApp'), app('Telegram'), app('Phone Link')]
  }
]

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the|my|some) /, '')
    .replace(/ (app|application|program)$/, '')

/** "a spreadsheet", "calendar app", "video call" → that category. */
export function categoryFor(query: string): AppCategory | undefined {
  const q = clean(query)
  return CATEGORIES.find((c) => c.id === q || c.words.some((w) => clean(w) === q))
}

/** The category an app belongs to ("Excel" → spreadsheets), so a missing app can be swapped for a similar one. */
export function categoryContaining(appName: string): AppCategory | undefined {
  return CATEGORIES.find((c) =>
    [...c.mac, ...c.win].some((choice) => 'app' in choice && choice.app.some((n) => appNameMatches(n, appName)))
  )
}

export function choicesFor(category: AppCategory, platform: string): Choice[] {
  return platform === 'win32' ? category.win : category.mac
}

/** The first choice that's installed (or a website, if allowed). */
export function pickFromCategory(
  category: AppCategory,
  apps: InstalledApp[],
  platform: string,
  allowWeb: boolean
): CategoryPick | undefined {
  for (const choice of choicesFor(category, platform)) {
    if ('web' in choice) {
      if (allowWeb) return { web: choice.web, label: choice.label }
      continue
    }
    for (const name of choice.app) {
      const m = findApp(apps, name, { strict: true })
      if ('app' in m) return { app: m.app }
    }
  }
  return undefined
}
