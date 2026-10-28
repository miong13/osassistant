import type { NewImageInput } from '../../../shared/api'

const MAX_SIDE = 1568
const MAX_BASE64 = 5 * 1024 * 1024
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export interface DraftImage extends NewImageInput {
  /** data: URL for the thumbnail */
  url: string
}

/** Turn a dropped, pasted or picked file into an image ready to send: scaled down, JPEG unless it's a GIF. */
export async function prepareImage(file: Blob): Promise<DraftImage> {
  if (!SUPPORTED.includes(file.type)) throw new Error('Only JPEG, PNG, GIF and WebP images can be attached.')
  // GIFs may be animated; send them as they are if they're small enough.
  if (file.type === 'image/gif') {
    const data = await toBase64(file)
    if (data.length > MAX_BASE64) throw new Error('That GIF is too large (max 5 MB).')
    return { mediaType: 'image/gif', data, url: `data:image/gif;base64,${data}` }
  }
  const bitmap = await createImageBitmap(file)
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  const data = await toBase64(blob)
  if (data.length > MAX_BASE64) throw new Error('That image is too large.')
  return { mediaType: 'image/jpeg', data, url: `data:image/jpeg;base64,${data}` }
}

export function fromBase64(img: NewImageInput): DraftImage {
  return { ...img, url: `data:${img.mediaType};base64,${img.data}` }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(new Error("Couldn't read that image."))
    reader.readAsDataURL(blob)
  })
}
