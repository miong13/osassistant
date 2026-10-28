/** Longest side of a screenshot sent to a model. Claude scales anything larger down to about this anyway. */
export const MAX_SCREENSHOT_SIDE = 1568

export interface ScreenshotDeps {
  platform: string
  /** macOS: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'. Elsewhere 'granted'. */
  screenAccess(): string
  openPrivacySettings(): void
  display(): { id: number; size: { width: number; height: number }; scaleFactor: number }
  getSources(opts: {
    types: ['screen']
    thumbnailSize: { width: number; height: number }
  }): Promise<{ display_id: string; thumbnail: { isEmpty(): boolean; toJPEG(quality: number): Buffer } }[]>
  /** Hide the character and bubble so they aren't in the picture. */
  setInvisible(invisible: boolean): void
  wait?(ms: number): Promise<void>
}

export type ScreenshotResult = { mediaType: 'image/jpeg'; data: string } | { error: string }

/** Pixel size that fits the display inside MAX_SCREENSHOT_SIDE, keeping its shape. */
export function screenshotSize(display: { size: { width: number; height: number }; scaleFactor: number }) {
  const w = display.size.width * display.scaleFactor
  const h = display.size.height * display.scaleFactor
  const k = Math.min(1, MAX_SCREENSHOT_SIDE / Math.max(w, h))
  return { width: Math.round(w * k), height: Math.round(h * k) }
}

/** Screenshot of the display under the mouse, without the character on it. */
export async function captureScreen(deps: ScreenshotDeps): Promise<ScreenshotResult> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const access = deps.screenAccess()
  if (deps.platform === 'darwin' && access !== 'granted') {
    // Asking once adds the app to the list in System Settings.
    if (access === 'not-determined') await deps.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
    deps.openPrivacySettings()
    return {
      error:
        'To share your screen, turn on OS Assistant in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.'
    }
  }

  const display = deps.display()
  deps.setInvisible(true)
  try {
    await wait(150) // let the window disappear before capturing
    const sources = await deps.getSources({ types: ['screen'], thumbnailSize: screenshotSize(display) })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) return { error: "Couldn't capture the screen." }
    return { mediaType: 'image/jpeg', data: source.thumbnail.toJPEG(85).toString('base64') }
  } catch {
    return { error: "Couldn't capture the screen." }
  } finally {
    deps.setInvisible(false)
  }
}
