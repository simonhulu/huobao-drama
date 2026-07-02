import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

const DEFAULT_ID = 'classic-title-fade'

const defaultConfig = {
  duration: 3,
  background: { type: 'color', value: '#000000' },
  variables: {
    dramaTitle: { source: 'drama.title', fallback: '精彩短剧' },
    episodeNumber: { source: 'episode.episodeNumber' },
  },
  layers: [
    {
      type: 'text',
      content: '{{dramaTitle}}',
      fontSize: 72,
      color: '#ffffff',
      position: 'center',
      animation: { type: 'fadeIn', duration: 1.5, delay: 0.5 },
    },
  ],
  audio: null,
}

async function main() {
  const existing = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, DEFAULT_ID)).all()[0]
  if (existing) {
    console.log('Default intro template already exists')
    return
  }

  // Ensure no other default exists
  db.update(schema.introTemplates).set({ isDefault: false }).run()

  db.insert(schema.introTemplates).values({
    id: DEFAULT_ID,
    name: '经典黑场标题淡入',
    config: defaultConfig,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()

  console.log('Default intro template seeded')
}

main().catch(console.error)
