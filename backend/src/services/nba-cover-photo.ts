import sharp from 'sharp'
import type { NbaBodyCrop } from './nba-cover-body.js'

export const NBA_COVER_MAX_PHOTO_UPSCALE = 1.15
export interface NbaCoverPhoto {
  bytes: Buffer
  width: number
  height: number
  crop?: NbaBodyCrop
  cropOmittedForResolution: boolean
  upscaleToFill: number
}

export function nbaCoverPhotoDisplay(width: number, height: number, portrait = false) {
  const scale = Math.min((portrait ? 520 : 700) / width, (portrait ? 720 : 784) / height, NBA_COVER_MAX_PHOTO_UPSCALE)
  return { width: Math.floor(width * scale), height: Math.floor(height * scale), scale }
}

/** Evaluate the actual visible pixels, including the same crop and trim used in the poster. */
export async function prepareNbaCoverPhoto(source: Buffer, crop?: NbaBodyCrop): Promise<NbaCoverPhoto> {
  const metadata = await sharp(source, { limitInputPixels: 16_000_000 }).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Invalid body photograph dimensions')
  if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0
    || crop.width < .35 || crop.height < .48 || crop.x + crop.width > 1.001 || crop.y + crop.height > 1.001)) throw new Error('Invalid body crop')
  const full = await sharp(source).trim().png().toBuffer({ resolveWithObject: true })
  let selected = full, selectedCrop = crop, cropOmittedForResolution = false
  if (crop) {
    const left = Math.floor(crop.x * metadata.width)
    const extracted = await sharp(source).extract({ left, top: 0,
      width: Math.min(metadata.width - left, Math.round(crop.width * metadata.width)),
      height: Math.min(metadata.height, Math.round((crop.y + crop.height) * metadata.height)) }).png().toBuffer()
    const cropped = await sharp(extracted).trim().png().toBuffer({ resolveWithObject: true })
    const upscale = Math.min(700 / cropped.info.width, 784 / cropped.info.height)
    // Preserve the full real pose when a tighter crop would discard pixels needed at display size.
    if (upscale > NBA_COVER_MAX_PHOTO_UPSCALE && (full.info.width > cropped.info.width || full.info.height > cropped.info.height)) {
      selectedCrop = undefined; cropOmittedForResolution = true
    } else selected = cropped
  }
  return { bytes: selected.data, width: selected.info.width, height: selected.info.height, crop: selectedCrop,
    cropOmittedForResolution, upscaleToFill: Math.min(700 / selected.info.width, 784 / selected.info.height) }
}
