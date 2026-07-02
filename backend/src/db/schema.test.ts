import { describe, it } from 'node:test'
import assert from 'node:assert'
import { episodes, dramas, introTemplates } from './schema.js'

describe('recap + intro schema', () => {
  it('has recap and hook columns on episodes', () => {
    assert.ok(episodes.recapScript)
    assert.ok(episodes.recapVideoUrl)
    assert.ok(episodes.introVideoUrl)
    assert.ok(episodes.openingHook)
    assert.ok(episodes.cliffhanger)
    assert.ok(episodes.seriesHook)
    assert.ok(episodes.metadata)
  })

  it('has intro_template_id on dramas', () => {
    assert.ok(dramas.introTemplateId)
  })

  it('has intro_templates table', () => {
    assert.ok(introTemplates.id)
    assert.ok(introTemplates.name)
    assert.ok(introTemplates.config)
    assert.ok(introTemplates.isDefault)
  })
})
