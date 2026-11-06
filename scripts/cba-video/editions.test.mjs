import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedEditions} from './editions.mjs';
import {createJob, editorialDigest, validateJob} from './core.mjs';

test('legacy editions stay dual without changing jobs, approvals, or editorial digests', () => {
  const job = createJob({id:'legacy',league:'CBA',date:'2026-10-23',home:'天津',away:'广州'});
  job.approval = {digest:editorialDigest(job)}; job.outputs = {inputDigest:'existing'};
  const before = JSON.stringify(job), signature = editorialDigest(job);
  const result = selectedEditions(job); result.pop();
  assert.deepEqual(selectedEditions(job), ['news','highlights']);
  assert.equal(JSON.stringify(job), before);
  assert.equal(editorialDigest(job), signature);
  assert.deepEqual(selectedEditions({}), ['news','highlights']);
});

test('explicit news-only and canonical dual editions are accepted and bind approval identity', () => {
  const job = createJob({id:'editions',league:'CBA',date:'2026-10-23',home:'天津',away:'广州'});
  const legacy = editorialDigest(job);
  for (const editions of [['news'],['highlights'],['news','highlights']]) {
    job.profile.editions = Object.freeze(editions);
    assert.deepEqual(selectedEditions(job), editions);
    assert.notEqual(editorialDigest(job), legacy);
    assert.ok(!validateJob(job).errors.some(error => error.includes('editions')));
  }
});

test('invalid editions cannot silently disable a required deliverable', () => {
  for (const editions of [null,false,'news',[],['highlights','news'],['news','news'],['news','other'],['news','highlights','other']]) {
    const job = createJob({id:'invalid',league:'CBA',date:'2026-10-23',home:'天津',away:'广州'});
    job.profile.editions = editions;
    assert.throws(() => selectedEditions(job), /Profile editions/);
    assert.match(validateJob(job).errors.join('\n'), /Profile editions/);
  }
});
