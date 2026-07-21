import { getTextConfig, getTextProviderBaseUrl } from '../src/services/ai.js'

const config = getTextConfig()
const baseUrl = getTextProviderBaseUrl(config)
const model = config.model

// 使用 backend/src/agents/index.ts 中 narrator 的真实系统提示词
const systemPrompt = `你是长视频/短剧解说撰稿人。你的任务是把一集内容写成一段连贯的解说旁白：开头用一句话悬念总结勾住观众，中间按情节推进，结尾留悬念。

工作流程：
1. 调用 read_narration_context 读取 original_story、角色信息、镜头列表、本集 opening_hook 和 cliffhanger
2. 第一镜的旁白 = opening_hook（一句话总结本集并留下悬念）
3. 第二镜用一句简短的过渡句，例如“到底发生了什么？我们接着看。”或“事情要从这里说起。”
4. 从第三镜开始，按时间顺序讲述本集内容
5. 最后一镜的旁白 = cliffhanger，把悬念推到最高点
6. 调用 save_narrations 一次性保存所有镜头的 narration

撰写原则：
- 使用第三人称解说视角，口语化，像人对人讲故事
- 不贴标签，不喊“绿茶假少爷”“白月光”这类身份标签，用角色原名或“她/他/婆婆/丈夫”等自然称谓
- 每句旁白同时服务“情节”和“情绪”：说清楚“谁在做什么、为什么重要”，并用语气让观众感受到情绪
- 严禁“我心里想”“我只觉得”等纯内心独白；主角的反应必须通过动作、表情或旁白评论呈现
- 无对白模式（dialogue_mode='narration_only'）下：所有对话都转述为旁白，镜头里没有原声对白，旁白承担全部叙事
- 有原声对白时，旁白只做铺垫或解释对白分量，严禁复述台词
- 不编造原文没有的情节、名字或细节
- 长集允许信息量更大的旁白，但避免一个镜头堆砌复杂长句

输出规范：
- 每个镜头一条 narration，纯讲述文本，不带“旁白：”前缀
- 不写镜头语言、提示词、画面描述
- 每镜头 1-3 句；信息量大或交代背景时可略长
- 如果已有部分 narration，默认重写整集旁白，确保风格统一`

const openingHook = '宋峥延再次默许别人叫弟媳苏轻轻“宋太太”，我却笑着举杯应和。他以为我终于懂事了，却不知道，我送给他的那份金色礼盒里，装的不是礼物，而是一纸离婚协议。'
const cliffhanger = '我转身离开了酒店，留下宋峥延一个人站在原地。等他终于打开那个金色礼盒，一切都会不一样。'

const originalStory = `宋峥延再次以工作之名，默许别人叫弟媳做“宋太太”之后。

我没再发疯，没再胡闹。

甚至乖顺举杯，应和旁人对他俩的恭维。

“是呀，真般配。”

宋峥延猛地抬头，眸底压不住的错愕。

“你叫她什么？”

我看着他失色的脸，扬唇浅笑。

“宋太太呀。”

01

宋峥延的愕然不过一瞬，转眼，又淡漠如常。

“林砚，非要这样说话？”

他眉头微蹙，语气带着不耐，“后天跨年，我和轻轻去纽约见客户。”

“你在家好好待着，别想搞破坏，我们只是……”

他停顿，像在等我发作。

我却只是点头。

“嗯。我知道，你们出双入对，只为了工作。”

他眼眸微眯，打量我平静的脸，试图找出破绽。

“她还要代言公司的新品牌，”他试探地补充着，“你知道的……”

我又弯了弯唇角表示理解，“知道的，帮轻轻拼事业，是峥嵘的遗愿。”

“你做兄长的，是该替他完成。”

他又怔住了。

欲言又止，“林砚，你……”

我沉静地笑笑。

“放心。”

“我不会再打扰你们。”

02

宋峥延似乎还想再说什么，被苏轻轻温软娇俏的嗓音截断。

“峥延，快来，该切蛋糕了——”

台上的苏轻轻俨然女主人的姿态。

大大方方朝他招了招手。

聚光灯下，她肤白如雪，宛然一朵被娇养得极盛的玫瑰。

而大荧幕上，下一秒出现两人的亲昵合照。

现场欢呼声四起。

“好配！”

“老板娘美疯啦！！”

一场公司年会，被办得仿佛两人的婚礼。

公司扩张得快，很少人知道，我是真正的老板娘。

几个老员工投向我的目光里含着同情。

宋峥延没动，只是轻掀眼皮睨我。

他在等。

等我和从前一样失控、尖叫、把蛋糕砸在苏轻轻得意的脸上。

可我只是淡定地，从包里拿出那个准备了很久的金色礼盒。

递给他。

“迟到的上市礼物。恭喜了，宋总。”

他明显一怔，随即嘴角勾起惯有懒散弧度。

“都上市多久了，现在才想起来？”

他接过盒子，指尖无意擦过我的皮肤，“总算懂点事了。”

金灿灿的包装之下，一纸离婚协议书安静地躺在里面。

现在想来。

我们以一份礼物开始，以一份礼物结束。

也算有始有终。`

const userMessage = `请为以下这集内容生成解说旁白。

本集信息：
- 标题：年会上的离婚礼物
- opening_hook：${openingHook}
- cliffhanger：${cliffhanger}

镜头列表：
1. 年会现场，苏轻轻站在台上招呼宋峥延切蛋糕，大荧幕播放两人亲密合照。
2. 宋峥延看着我，等我失控。
3. 我微笑着举杯，应和别人叫苏轻轻宋太太。
4. 我从包里拿出金色礼盒递给宋峥延。
5. 宋峥延接过礼盒，嘴角带着懒散的笑。
6. 镜头特写：礼盒包装下，一纸离婚协议书安静地躺在里面。
7. 我摇头拒绝上台，转身离开酒店。

原文：
${originalStory}

要求：
- 第一镜旁白必须等于 opening_hook
- 第二镜用一句简短过渡句，例如“到底发生了什么？我们接着看。”
- 最后一镜旁白必须等于 cliffhanger
- 中间按镜头顺序讲述
- 不要角色原声对白，全部转述
- 不要贴标签，用自然称谓
- 口语化解说风格`

async function main() {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM request failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  console.log('===== 真实 narrator prompt 生成的解说文案 =====\n')
  console.log(content)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
