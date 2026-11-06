import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fallbackTopicQuery, matchesNbaTopic, topicQueries, topicSearchResults } from './nba-topic-news.js'

test('topic search accepts the existing mcporter structured envelope and refuses unstructured summaries', () => {
  const result = topicSearchResults({content:[{type:'text',text:JSON.stringify({organic:[{title:'An interview',link:'https://example.com/article',snippet:'not article body'}],base_resp:{status_code:0}})}]})
  assert.deepEqual(result,[{title:'An interview',url:'https://example.com/article'}])
  assert.throws(() => topicSearchResults({content:[{type:'text',text:'Search failed: API error'}]}),/响应|链接/)
})

test('topic matching handles common names across languages and accents without requiring a game', () => {
  const plan = {en:'Luka Doncic scoring',zh:'东契奇 得分',anchors:['Luka Doncic','东契奇'],keywords:['scoring','得分']}
  assert.equal(matchesNbaTopic({title:'Luka Dončić on scoring',body:'An interview about his progress.'},plan),true)
  assert.equal(matchesNbaTopic({title:'东契奇谈得分',body:'球员采访正文'},plan),true)
  assert.equal(matchesNbaTopic({title:'Some other subject',body:'A complete but unrelated report'},plan),false)
  assert.equal(matchesNbaTopic({title:'Luka Doncic launches a clothing line',body:'The new business will open tomorrow.'},plan),false)
  assert.equal(matchesNbaTopic({title:'字母哥谈东契奇',body:'他认可对手的历史级得分实力。'},
    {...plan,anchors:['卢卡·东契奇'],keywords:['连续五场精彩得分表现']}),true)
  assert.deepEqual(topicQueries(plan,['en','zh','en']).map(row => row.language),['en','zh'])
  assert.equal(fallbackTopicQuery({...plan,anchors:['卢卡·东契奇','Luka Doncic'],keywords:['连续五场得分纪录','scoring streak']},'zh'),'东契奇 得分')
  assert.equal(matchesNbaTopic({title:'Luka Doncic on his latest scoring run',body:'Luka Doncic discussed the historic performance.'},
    {...plan,anchors:['卢卡·东契奇'],keywords:['得分纪录']},{title:'Luka Dončić On His HISTORIC Scoring Run'}),true)
})

test('Jelly basketball video rejects a matching fashion phrase without sports context', () => {
  const plan = {en:'Jelly finishes 2025-26 NBA',zh:'果冻 上篮 赛季',anchors:['Jelly','果冻'],keywords:[]}
  const topic = {title:'Top "Jelly" Finishes of the 2025-26 Season'}
  assert.equal(matchesNbaTopic({title:'Jelly Firkin重塑果冻包的日常价值',
    body:'Jelly Firkin以果冻包为灵感，探索透明材质与日常穿搭的结合。新品通过多种色彩为时尚爱好者提供手袋选择，品牌强调轻盈、实用与设计美感。'},plan,topic),false)
  assert.equal(matchesNbaTopic({title:'Jelly Firkin handbags bring playful color to everyday fashion',
    body:'The design team introduces a new collection of translucent handbags inspired by jelly colors and everyday outfits.'},plan,topic),false)
  assert.equal(matchesNbaTopic({title:'NBA赛季精彩果冻上篮合集',body:'球员在突破后改变出手角度，用果冻上篮避开防守者，展现篮球技巧。'},plan,topic),true)
  assert.equal(matchesNbaTopic({title:'The best Jelly finishes of the NBA season',body:'Basketball players used creative layups to finish around defenders.'},plan,topic),true)
})

test('sports context preserves interviews, sponsors, coaches, compilations and other sports', () => {
  const cases = [
    {title:'Tyler Herro talks Milwaukee homecoming at media day',body:'The basketball guard discussed his role with the team.',anchor:'Tyler Herro'},
    {title:'JJ Redick explains his approach',body:'The coach discusses how his players communicate on defense.',anchor:'JJ Redick'},
    {title:'Nike and NBA launch a new partnership',body:'The collection features apparel celebrating basketball culture.',anchor:'Nike'},
    {title:'Nike与詹姆斯续约',body:'这位篮球球星将继续参与品牌球鞋设计与代言活动。',anchor:'詹姆斯'},
    {title:'CBA联赛精彩扣篮',body:'这份合集记录了球员在比赛中的精彩发挥。',anchor:'扣篮'},
    {title:'WNBA stars visit the community',body:'The players shared stories about training and teamwork.',anchor:'WNBA'},
    {title:'Alcaraz discusses his latest result',body:'The tennis champion answered questions after the tournament.',anchor:'Alcaraz'},
    {title:'梅西谈新赛季',body:'这位足球运动员表示球队会继续努力。',anchor:'梅西'},
  ]
  for (const article of cases) assert.equal(matchesNbaTopic(article,{en:article.title,zh:article.title,anchors:[article.anchor],keywords:[]}),true,article.title)
  assert.equal(matchesNbaTopic({title:'Jelly Firkin new bag',body:'The brand ABNBAZ creates fashion accessories.'},
    {en:'Jelly NBA',zh:'Jelly篮球',anchors:['Jelly'],keywords:[]}),false,'embedded NBA letters are not sports context')
})
