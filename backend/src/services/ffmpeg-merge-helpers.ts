import ffmpeg from 'fluent-ffmpeg'

export function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(false); return }
      const audioStreams = metadata.streams?.filter(s => s.codec_type === 'audio') || []
      resolve(audioStreams.length > 0)
    })
  })
}

export function addSilentAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .input('anullsrc=r=48000:cl=mono')
      .inputOptions(['-f', 'lavfi'])
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}
