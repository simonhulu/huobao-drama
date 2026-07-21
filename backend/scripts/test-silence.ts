import ffmpeg from 'fluent-ffmpeg'

ffmpeg()
  .input('anullsrc=r=48000:cl=stereo')
  .inputFormat('lavfi')
  .outputOptions(['-t', '1', '-c:a', 'aac'])
  .output('/tmp/ff-silence.m4a')
  .on('start', (cmd) => console.log('CMD:', cmd))
  .on('end', () => console.log('OK'))
  .on('error', (err) => console.error('ERR:', err.message))
  .run()
