import { describe, it } from 'node:test'
import assert from 'node:assert'
import { episodes, dramas, introTemplates, mediaAccounts, remotionProjects } from './schema.js'

describe('recap + intro schema', () => {
  it('has recap and hook columns on episodes', () => {
    assert.ok(episodes.recapScript)
    assert.ok(episodes.recapVideoUrl)
    assert.ok(episodes.introVideoUrl)
    assert.ok(episodes.openingHook)
    assert.ok(episodes.cliffhanger)
    assert.ok(episodes.seriesHook)
    assert.ok(episodes.metadata)
    assert.ok(episodes.coverPrompt)
    assert.ok(episodes.coverImage4x3Url)
    assert.ok(episodes.coverImage3x4Url)
    assert.ok(episodes.coverImage4x3GenId)
    assert.ok(episodes.coverImage3x4GenId)
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

  it('has account-aware positioning fields', () => {
    assert.ok(mediaAccounts.positioningJson)
    assert.ok(dramas.mediaAccountId)
    assert.ok(dramas.projectPositioningJson)
    assert.ok(episodes.creativeBriefJson)
    assert.ok(remotionProjects.mediaAccountId)
    assert.ok(remotionProjects.positioningSnapshotJson)
  })
})
