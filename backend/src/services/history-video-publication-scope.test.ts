import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {historyAutomationSourceIds,historyExecutionScope} from './history-video-publication-scope.js'

test('automation scope distinguishes an omitted scope from an explicit empty source list and rejects invalid configuration',()=>{
  assert.equal(historyAutomationSourceIds({}),undefined)
  assert.deepEqual(historyAutomationSourceIds({HISTORY_AUTOMATION_SOURCE_IDS:'[]'}),[])
  assert.deepEqual(historyAutomationSourceIds({HISTORY_AUTOMATION_SOURCE_IDS:'[433,132,433]'}),[132,433])
  for(const value of ['', 'null', '{}', '["433"]', '[0]', '433', '[433,]']) {
    assert.throws(()=>historyAutomationSourceIds({HISTORY_AUTOMATION_SOURCE_IDS:value}))
  }
})

test('source, video and original job allowlists intersect, while an explicit empty ID list selects nothing',()=>{
  const database=new Database(':memory:')
  try {
    database.exec('CREATE TABLE jobs(id INTEGER,source_id INTEGER,video_id INTEGER); INSERT INTO jobs VALUES(10,373,70),(11,373,71),(12,132,70),(13,373,70)')
    const selected=(input?:Parameters<typeof historyExecutionScope>[0])=>{
      const scope=historyExecutionScope(input)
      return database.prepare(`SELECT id FROM jobs WHERE 1 ${scope.clause} ORDER BY id`).all(...scope.values)
    }
    assert.deepEqual(selected({sourceIds:[373],videoIds:[70],jobIds:['10']}),[{id:10}])
    assert.deepEqual(selected({sourceIds:[373],videoIds:[70],jobIds:[12]}),[])
    assert.deepEqual(selected({sourceIds:[]}),[])
    assert.deepEqual(selected(),[{id:10},{id:11},{id:12},{id:13}])
    for(const invalid of [{},{jobIds:['10 OR 1=1']},{sourceIds:[0]},{sourceIds:[NaN]},{sourceIds:null},{sourceIds:[373],typo:[132]}]) {
      assert.throws(()=>historyExecutionScope(invalid as any),/allowlist/i)
    }
  } finally {database.close()}
})
