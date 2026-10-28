import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGE_MEDIA_TYPES, type ChatMessage, type ImageMediaType } from '../shared/types'

/** Claude's per-image limit is 5 MB of base64; the UI scales images well below this. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 4

const EXT: Record<ImageMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

export interface NewImage {
  mediaType: string
  /** base64, no data: prefix */
  data: string
}

/** Images attached to chats, as files under <dir>/<conversation id>/<image id>.<ext>. */
export class AttachmentStore {
  constructor(private dir: string) {}

  /** Check images from the renderer before anything is saved. Throws a message for the user. */
  static validate(images: unknown): NewImage[] {
    if (images === undefined || images === null) return []
    if (!Array.isArray(images)) throw new Error('Invalid attachments.')
    if (images.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images.`)
    return images.map((img) => {
      const { mediaType, data } = (img ?? {}) as Record<string, unknown>
      if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType))
        throw new Error('Only JPEG, PNG, GIF and WebP images can be attached.')
      if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Invalid image data.')
      if (data.length > MAX_IMAGE_BASE64) throw new Error('That image is too large (max 5 MB).')
      return { mediaType, data }
    })
  }

  save(conversationId: string, image: NewImage): { id: string; mediaType: ImageMediaType } {
    const mediaType = image.mediaType as ImageMediaType
    const id = crypto.randomUUID()
    const folder = this.folder(conversationId)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${id}.${EXT[mediaType]}`), Buffer.from(image.data, 'base64'))
    return { id, mediaType }
  }

  /** base64 data, or null if the file is gone. */
  read(conversationId: string, id: string, mediaType: ImageMediaType): string | null {
    if (!SAFE_ID.test(id) || !EXT[mediaType]) return null
    const file = join(this.folder(conversationId), `${id}.${EXT[mediaType]}`)
    return existsSync(file) ? readFileSync(file).toString('base64') : null
  }

  deleteConversation(conversationId: string): void {
    if (!SAFE_ID.test(conversationId)) return
    rmSync(this.folder(conversationId), { recursive: true, force: true })
  }

  /** Copies of the messages with image data filled in, ready to send to a model. */
  hydrate(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) =>
      m.parts.some((p) => p.type === 'image')
        ? {
            ...m,
            parts: m.parts.map((p) =>
              p.type === 'image' ? { ...p, data: this.read(m.conversationId, p.id, p.mediaType) ?? undefined } : p
            )
          }
        : m
    )
  }

  private folder(conversationId: string): string {
    if (!SAFE_ID.test(conversationId)) throw new Error('Invalid conversation id.')
    return join(this.dir, conversationId)
  }
}
