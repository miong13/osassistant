import { execFile } from 'node:child_process'

/**
 * Apps launched from Finder/Dock on macOS get a minimal PATH, so `npx`, `uvx`, `node`
 * etc. aren't found. Ask the user's login shell for its PATH once at startup.
 */
export async function loadShellPath(): Promise<string> {
  const current = process.env.PATH ?? ''
  if (process.platform === 'win32') return current
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__OSA_PATH__'
  const fromShell = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf "${marker}%s${marker}" "$PATH"`],
      { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (err, stdout) => {
        if (err) return resolve('')
        const match = stdout.match(new RegExp(`${marker}(.*)${marker}`))
        resolve(match?.[1] ?? '')
      }
    )
  })
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`]
  const parts = [...fromShell.split(':'), ...current.split(':'), ...extras].filter(Boolean)
  return [...new Set(parts)].join(':')
}
