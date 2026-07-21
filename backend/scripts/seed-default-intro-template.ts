import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

const TEMPLATES = [
  {
    id: 'black-title-fade',
    name: '电影感标题淡入（Remotion）',
    config: {
      duration: 4,
      component: 'BlackTitleIntro',
      background: { type: 'color', value: '#000000' },
      layers: [],
      audio: null,
    },
    isDefault: true,
  },
  {
    id: 'classic-title-fade',
    name: '经典黑场标题淡入',
    config: {
      duration: 4,
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
      component: null,
    },
    isDefault: false,
  },
  {
    id: 'dynasty-year-flash',
    name: '朝代年号快闪（Remotion）',
    config: {
      duration: 4,
      component: 'DynastyYearFlash',
      background: { type: 'color', value: '#0a0a0a' },
      cards: [
        { text: '大明', sub: 'Ming Dynasty' },
        { text: '万历十年', sub: 'Year of Wanli 10' },
        { text: '1582', sub: 'June' },
        { text: '张居正卒', sub: 'Zhang Juzheng died' },
      ],
      layers: [],
      audio: { src: 'static/intros/bell_sfx.m4a' },
    },
    isDefault: false,
  },
  {
    id: 'vintage-ken-burns',
    name: '老照片 Ken Burns（Remotion）',
    config: {
      duration: 6,
      component: 'VintageKenBurns',
      background: { type: 'color', value: '#1a1510' },
      layers: [],
      audio: null,
    },
    isDefault: false,
  },
]

function now() {
  return new Date().toISOString()
}

async function main() {
  for (const t of TEMPLATES) {
    const existing = db
      .select()
      .from(schema.introTemplates)
      .where(eq(schema.introTemplates.id, t.id))
      .all()[0]

    const values = {
      name: t.name,
      config: JSON.stringify(t.config),
      isDefault: t.isDefault,
      updatedAt: now(),
    }

    if (existing) {
      db.update(schema.introTemplates)
        .set(values)
        .where(eq(schema.introTemplates.id, t.id))
        .run()
      console.log(`Updated intro template: ${t.id}`)
      continue
    }

    db.insert(schema.introTemplates).values({
      id: t.id,
      name: t.name,
      config: JSON.stringify(t.config),
      isDefault: t.isDefault,
      createdAt: now(),
      updatedAt: now(),
    }).run()
    console.log(`Seeded intro template: ${t.id}`)
  }

  // Ensure black-title-fade is the default unless user explicitly set another
  const currentDefault = db
    .select()
    .from(schema.introTemplates)
    .where(eq(schema.introTemplates.isDefault, true))
    .all()[0]
  if (!currentDefault || currentDefault.id === 'classic-title-fade') {
    db.update(schema.introTemplates)
      .set({ isDefault: false, updatedAt: now() })
      .where(eq(schema.introTemplates.id, 'classic-title-fade'))
      .run()
    db.update(schema.introTemplates)
      .set({ isDefault: true, updatedAt: now() })
      .where(eq(schema.introTemplates.id, 'black-title-fade'))
      .run()
  }
}

main().catch(console.error)
