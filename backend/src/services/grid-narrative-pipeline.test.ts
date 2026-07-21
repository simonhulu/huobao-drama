import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGridDecompositionUserPrompt,
  buildGridDecompositionSystemPrompt,
  buildShotImagePrompt,
  findNarrationEvidenceContractIssues,
  findSingleImageSemanticContractIssues,
  findSingleImageShotContractIssues,
  mergeGridCellsImageUpdate,
  type GridBeat,
} from './grid-narrative-pipeline.js'

const beat: GridBeat = {
  description: '少年在油桶旁记录货物重量，铁路与炼油设施向远处延伸',
  move: 'push',
  enter: 'cut',
}

test('shot prompt requests one full 16:9 image and forbids panel layouts', () => {
  const prompt = buildShotImagePrompt('石油生意扩张', beat)
  assert.match(prompt, /一张完整的16:9横屏画面/)
  assert.match(prompt, /单一连续镜头/)
  assert.match(prompt, /不要拼贴、分屏、宫格、画中画或分隔线/)
  assert.match(prompt, /不要出现任何文字、字幕、数字、水印或标识/)
  assert.match(prompt, /静音观看/)
  assert.match(prompt, /泛化调查动作/)
  assert.match(prompt, /直接事件.*后果痕迹.*后期信息层/)
  assert.match(prompt, /注意力锚点/)
  assert.doesNotMatch(prompt, /左格：|右格：|2个等大的竖幅格子/)
  assert.doesNotMatch(prompt, /Roger Deakins/i)
  assert.doesNotMatch(prompt, /只允许这两种色系/)
})

test('shot prompt switches profile instead of appending a competing style', () => {
  const prompt = buildShotImagePrompt('报社的秩序', beat, undefined, 'institutional_tableau')
  assert.match(prompt, /制度剧场/)
  assert.match(prompt, /正面对称|左右平衡/)
  assert.doesNotMatch(prompt, /现实系统史诗/)
})

test('decomposition prompt gives the model a concrete profile without a fixed duotone', () => {
  const prompt = buildGridDecompositionSystemPrompt('period_crime_35mm')
  assert.match(prompt, /复古犯罪凝视/)
  assert.match(prompt, /look 必须写本镜头实际可见/)
  assert.match(prompt, /时代自洽/)
  assert.match(prompt, /绝对不要出现任何文字/)
  assert.match(prompt, /beats 恰好 1 个/)
  assert.match(prompt, /displayTitle/)
  assert.match(prompt, /不得从旁白机械截断/)
  assert.match(prompt, /禁止拼贴、分屏、宫格/)
  assert.match(prompt, /铺垫.*发展.*转折.*落点/)
  assert.match(prompt, /视线衔接|镜头轴线/)
  assert.match(prompt, /现实生活中可能发生/)
  assert.match(prompt, /摄影机.*真实可达/)
  assert.match(prompt, /抽象信息.*不能靠编造人物表演/)
  assert.match(prompt, /不得虚构追逐、冲突或当事人反应/)
  assert.match(prompt, /墓地.*棺盖关闭/)
  assert.match(prompt, /identity_reveal/)
  assert.match(prompt, /证据插入镜头/)
  assert.match(prompt, /当前旁白尚未说出真名.*truth 留给下一镜/)
  assert.match(prompt, /生前\/死后.*上游尚未拆镜/)
  assert.match(prompt, /记者询问.*泛化调查 B-roll/)
  assert.match(prompt, /直接事件.*后果痕迹.*后期信息层/)
  assert.match(prompt, /注意力锚点/)
  assert.doesNotMatch(prompt, /铅灰\+烛金双色调/)
})

test('decomposition user prompt treats narration as the current-shot source of truth', () => {
  const prompt = buildGridDecompositionUserPrompt({
    id: 12,
    title: '葬礼与遗孀',
    narration: '他的真名叫威廉·洛克菲勒。',
    description: '妻子主持了葬礼。他的真名叫威廉·洛克菲勒。',
    action: '戴黑面纱的妻子站在墓穴边。',
    duration: 5,
  }, [], {
    stage: 'turn',
    index: 3,
    total: 5,
    previous: {
      narration: '妻子主持了葬礼。',
      description: '老妇人在墓穴边主持葬礼。',
      shotSize: 'medium',
    },
    nextNarration: '一个活着东躲西藏的人并不好找。',
    sameSceneAsPrevious: true,
  })

  assert.match(prompt, /本镜准确旁白（唯一语义依据）：他的真名叫威廉·洛克菲勒。/)
  assert.match(prompt, /旧标题与旧画面构想仅供核对/)
  assert.match(prompt, /不得继续画妻子主持葬礼/)
  assert.match(prompt, /上一镜已完成画面/)
  assert.match(prompt, /下一镜旁白.*不得提前表现/)
})

test('decomposition user prompt strips scene actions from character identity', () => {
  const prompt = buildGridDecompositionUserPrompt({
    id: 4279,
    narration: '这位利文斯顿医生，根本不叫这个名字。',
    location: '伊利诺伊州小镇墓地',
    time: '1906年5月，阴天午后',
    duration: 5,
  }, [{
    name: '威廉·洛克菲勒',
    appearance: '九十五岁的干瘦老头，躺在棺材中，面容消瘦但骨骼粗大，嘴角常挂似笑非笑的表情。',
  }])

  assert.match(prompt, /九十五岁的干瘦老头/)
  assert.match(prompt, /面容消瘦但骨骼粗大/)
  assert.doesNotMatch(prompt, /躺在棺材中/)
  assert.doesNotMatch(prompt, /嘴角常挂似笑非笑/)
  assert.match(prompt, /角色资料只用于锁定恒定身份/)
})

test('reality gate rejects unsupported open-casket and body depictions', async () => {
  const mod: any = await import('./grid-narrative-pipeline.js')
  assert.equal(typeof mod.findRealityContractIssues, 'function')
  assert.deepEqual(mod.findRealityContractIssues({
    narration: '这位利文斯顿医生，根本不叫这个名字。',
    location: '伊利诺伊州小镇墓地',
    description: '墓穴旁一口敞开的棺材，棺内老人遗体清晰可见，摄影机俯拍面部。',
  }), [
    '当前旁白没有建立遗体展示或开棺行为',
    '墓地下葬场景未建立瞻仰遗容环节，棺盖应保持关闭',
  ])
})

test('reality gate allows an explicitly established viewing scene', async () => {
  const mod: any = await import('./grid-narrative-pipeline.js')
  assert.equal(typeof mod.findRealityContractIssues, 'function')
  assert.deepEqual(mod.findRealityContractIssues({
    narration: '家人在教堂内依次瞻仰遗容。',
    location: '教堂内的遗体告别仪式',
    description: '家属从侧面走近打开的棺木，摄影机留在过道外侧。',
  }), [])
})

test('single-image contract rejects long storyboards before image generation', () => {
  assert.deepEqual(findSingleImageShotContractIssues([
    { id: 1, storyboardNumber: 1, duration: 8, narration: '短镜头' },
    { id: 2, storyboardNumber: 2, duration: 9, narration: '过长镜头' },
  ]), [{ storyboardId: 2, storyboardNumber: 2, duration: 9 }])
})

test('single-image semantic contract rejects living and post-death states in one frame', () => {
  assert.deepEqual(findSingleImageSemanticContractIssues([
    { id: 4282, storyboardNumber: 7, narration: '一个活着东躲西藏、死了还要用假名下葬的人。' },
    { id: 5001, storyboardNumber: 8, narration: '一个活着东躲西藏的人，生前自然不太好找。' },
    { id: 5002, storyboardNumber: 9, narration: '死了，他还要用假名下葬。' },
  ]), [{
    storyboardId: 4282,
    storyboardNumber: 7,
    reason: '旁白同时包含生前与死后两个不可共存的视觉时态',
  }])
})

test('narration evidence gate rejects generic proxy B-roll before paid generation', () => {
  const issues = findNarrationEvidenceContractIssues({
    narration: '一个活着东躲西藏、死了还要用假名下葬的人，生前自然是不太好找的。',
    description: '一个男人拿着本子询问女店主，女店主摇头并把钥匙挂回墙上。',
  })

  assert.match(issues.join('；'), /逃藏旁白缺少/)
  assert.match(issues.join('；'), /下葬旁白缺少/)
  assert.match(issues.join('；'), /追查落空旁白缺少/)
  assert.match(issues.join('；'), /身份矛盾旁白缺少/)
  assert.match(issues.join('；'), /identity_reveal/)
  assert.match(issues.join('；'), /泛化 B-roll/)
})

test('narration evidence gate accepts direct events, aftermath traces, and identity evidence', () => {
  assert.deepEqual(findNarrationEvidenceContractIssues({
    narration: '一个活着东躲西藏的人。',
    description: '老人提着皮箱穿过旅馆后门离开，回头看向仍亮着灯的走廊。',
  }), [])
  assert.deepEqual(findNarrationEvidenceContractIssues({
    narration: '死了还要用假名下葬的人。',
    description: '闭合棺木由绳索降入墓穴，墓碑刻字隐在阴影中。',
    graphic: { type: 'identity_reveal', alias: 'William Livingston', verdict: '仍是假名' },
  }), [])
  assert.deepEqual(findNarrationEvidenceContractIssues({
    narration: '生前自然是不太好找的。',
    description: '客房空无一人，热杯仍冒气，湿脚印通向仍在晃动的后门。',
  }), [])
  assert.deepEqual(findNarrationEvidenceContractIssues({
    narration: '这位医生根本不叫这个名字。',
    description: '两份旧档案被手推齐并置，笔尖停在材料交界处。',
    graphic: { type: 'identity_reveal', alias: 'William Livingston', verdict: '身份不符' },
  }), [])
})

test('image updates preserve an existing Grok video binding', () => {
  const merged = mergeGridCellsImageUpdate(JSON.stringify({
    theme: 'old theme',
    cells: [{ src: 'static/images/old.png' }],
    video: { src: 'static/videos/asset-4.mp4', assetId: 4, reused: false },
  }), 'new theme', [{
    description: 'updated frame',
    move: 'hold',
    enter: 'cut',
    src: 'static/images/egaki.png',
  }], undefined, 'commercial_teal_orange')

  assert.deepEqual(merged, {
    theme: 'new theme',
    styleProfile: 'commercial_teal_orange',
    cells: [{
      description: 'updated frame',
      move: 'hold',
      enter: 'cut',
      src: 'static/images/egaki.png',
    }],
    video: { src: 'static/videos/asset-4.mp4', assetId: 4, reused: false },
  })
})
