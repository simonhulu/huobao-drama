import { toAbsPath } from '../src/services/ffmpeg-compose.js'
console.log('STORAGE_PATH', process.env.STORAGE_PATH)
console.log('toAbsPath static/audio/x.m4a:', toAbsPath('static/audio/x.m4a'))
console.log('toAbsPath audio/x.m4a:', toAbsPath('audio/x.m4a'))
