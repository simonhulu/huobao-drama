BEGIN IMMEDIATE;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '三项情报提前到手',
  '$.cells[0].description', '昏暗铁路调度室内，洛克菲勒接过三叠封口不同的无字货运清单，交件人缩回阴影；侧光只照亮文件与双方手势。',
  '$.cells[0].graphic', json('{"type":"card","title":"情报到手","lines":["货量与成本","交货急迫度"]}')
) WHERE id = 4405;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '他看见力量失衡',
  '$.cells[0].description', '晨雾中的河岸工业区，一座熄火的小炼油厂被满载列车、密集油罐和大型厂区三面包围，孤零零的烟囱不再冒烟。'
), '$.cells[0].graphic') WHERE id = 4409;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '小炼油厂无力还手',
  '$.cells[0].description', '小炼油厂停在画面中央：运油马车转向远处大厂，货运列车越站而过，老板守着紧闭钱箱与熄灭炉火，三路压力同时可见。',
  '$.cells[0].graphic', json('{"type":"card","title":"三面受压","lines":["铁路与油田","现金被抽干"]}')
) WHERE id = 4410;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '看懂才选择退出',
  '$.cells[0].description', '停火车间里，厂主站在堆满未售煤油桶的过道，工人提工具箱离场，炉膛已冷；他望着空荡装货台，明白再撑只会亏损。',
  '$.cells[0].graphic', json('{"type":"card","title":"危机已明","lines":["油价下跌","库存无人接手"]}')
) WHERE id = 4412;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '现金与设备同时告急',
  '$.cells[0].description', '办公室敞门直通锈蚀设备，厂主掀开空钱箱；窗外标准石油油罐列车不停靠地驶过，升级机器和继续降价都已无钱可做。',
  '$.cells[0].graphic', json('{"type":"card","title":"无力再战","lines":["铁路偏向对手","没钱升级设备"]}')
) WHERE id = 4413;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '退出或成为经理',
  '$.cells[0].description', '同一间收购办公室里，左侧旧厂主交出钥匙后提箱离开，右侧另一位旧厂主接过经理钥匙走向标准石油办公区，买方居中见证。',
  '$.cells[0].graphic', json('{"type":"card","title":"两种去向","lines":["退出炼油业","留任做经理"]}')
) WHERE id = 4415;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '统一调度取代各自为战',
  '$.cells[0].description', '俯瞰炼油厂调度室，多位原小厂老板分坐不同工位，却同时听从中央调度员手势；窗下铁路、油罐与装货队列按同一节奏运行。'
), '$.cells[0].graphic') WHERE id = 4416;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '控制延伸到整条链路',
  '$.cells[0].description', '高处俯拍连成一体的石油链路：井架出油，管道穿过油桶仓库抵达铁路装货台，同一批工人和车辆连续接力，远处炼厂运转。',
  '$.cells[0].graphic', json('{"type":"card","title":"整条链路","lines":["油井到仓库","铁路与管道"]}')
) WHERE id = 4417;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '臭油无人肯买',
  '$.cells[0].description', '油田交易棚内，买家闻到样瓶立刻掩鼻后退，推开卖家的手转身离场；成排深色原油桶无人装车，井架在阴天背景中起伏。'
), '$.cells[0].graphic') WHERE id = 4421;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '臭油终于变成商品',
  '$.cells[0].description', '买家在炼油厂检验台前点亮一盏清亮无烟的煤油灯，随即把钱袋推向化学家；后方工人正把处理后的油桶装上货车。'
), '$.cells[0].graphic') WHERE id = 4423;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '汽车把废料变成燃料',
  '$.cells[0].description', '1910年代炼油厂外，原本通向废料槽的管线改接储罐，工人给排队的早期汽车加注汽油；车流与蒸馏塔在同一纵深。',
  '$.cells[0].graphic', json('{"type":"card","title":"用途翻转","lines":["昔日炼油废料","如今汽车燃料"]}')
) WHERE id = 4426;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '汽油接上新生意',
  '$.cells[0].description', '炼油厂汽油出货台忙成一线：工人滚动密封油桶装上卡车，早期汽车在旁等待补给，远处空车继续驶入，废料已形成稳定订单。'
), '$.cells[0].graphic') WHERE id = 4427;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '联邦下令拆成34家',
  '$.cells[0].description', '1911年联邦法庭内，书记员举起带封印但无可辨文字的拆分命令，标准石油律师席一片僵静，法官在高席上注视文件交接。',
  '$.cells[0].graphic', json('{"type":"bignum","value":34,"suffix":"家公司","label":"标准石油被拆分"}')
) WHERE id = 4428;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '拆了公司却没拆掉持股',
  '$.cells[0].description', '证券事务所长桌上，会计将原信托凭证换成多叠不同公司的无字股票证书，老年洛克菲勒仍坐在所有证书后方，手未离桌。',
  '$.cells[0].graphic', json('{"type":"card","title":"所有权仍在","lines":["公司分别上市","股价随后上涨"]}')
) WHERE id = 4430;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '拆分后资产反而增加',
  '$.cells[0].description', '银行估值室内，原先一叠信托凭证放在左侧，拆分后的多家公司股票与金条占满右侧；会计把沉重托盘推向洛克菲勒。',
  '$.cells[0].graphic', json('{"type":"card","title":"结果反转","lines":["惩罚已经发生","资产反而增加"]}')
) WHERE id = 4431;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '财富没有停下来',
  '$.cells[0].description', '拥挤证券交易所内，行情纸带从机器中不断涌出，掮客高举成交单互相呼喊；前景属于洛克菲勒持股组合的证书继续被装入保险箱。',
  '$.cells[0].graphic', json('{"type":"card","title":"拆分之后","lines":["股票继续升值","财富继续增长"]}')
) WHERE id = 4432;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '慈善直接改变公共生活',
  '$.cells[0].description', '20世纪初公共卫生诊所里，医生为排队儿童接种，护士向家庭分发药品；明亮教室门口可见学生入座，受益者占据画面主体。',
  '$.cells[0].graphic', json('{"type":"card","title":"慈善去向","lines":["医学与教育","公共卫生"]}')
) WHERE id = 4433;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '慈善盖不住旧账',
  '$.cells[0].description', '调查档案桌上，慈善支票压着铁路运费凭证、收购合同和停工炼厂照片，纸面全部模糊不可辨；侧光仍照出被压住的旧证据边缘。',
  '$.cells[0].graphic', json('{"type":"card","title":"旧账仍在","lines":["秘密回扣与压价","吞并没有消失"]}')
) WHERE id = 4434;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '塔贝尔把调查印给公众',
  '$.cells[0].description', '杂志印刷厂内，伊达·塔贝尔站在高速滚动的印刷机旁检查新刊，成捆杂志被工人送往街头，门外读者已围拢翻阅。'
), '$.cells[0].graphic') WHERE id = 4435;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '公众怒火对准洛克菲勒',
  '$.cells[0].description', '洛克菲勒的马车驶出街角时，被举着报纸的愤怒市民围住，警员张臂维持通道；车窗后的苍老侧脸与人群怒容形成对峙。',
  '$.cells[0].graphic', json('{"type":"card","title":"名声崩塌","lines":["调查公开交易","公众敌意集中"]}')
) WHERE id = 4436;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '财富换不来轻松身体',
  '$.cells[0].description', '晚年卧室里，洛克菲勒弓身坐在床沿按住胃部，梳妆台上落发、药瓶与未动餐盘并排，手杖靠在椅边，整夜紧绷清晰可见。'
), '$.cells[0].graphic') WHERE id = 4341;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '贫穷先教会他不确定',
  '$.cells[0].description', '少年洛克菲勒家的昏暗厨房里，母亲把最后几枚硬币分给孩子，空面粉罐和未付账单压在桌角；少年紧盯钱币，记住明天未必撑得过。'
), '$.cells[0].graphic') WHERE id = 4437;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '生意围绕降低风险',
  '$.cells[0].description', '成年洛克菲勒站在炼油厂调度台前，同时控制铁路装货口、备用管线阀门和原油储罐；一处通路中断，另一处仍把油送入厂区。',
  '$.cells[0].graphic', json('{"type":"card","title":"经营原则","lines":["降低自己的风险","把风险转移出去"]}')
) WHERE id = 4438;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '强者运转，弱者退场',
  '$.cells[0].description', '河岸对照景：近处标准石油厂炉火通明、工人连续装车；对岸小炼油厂大门上锁，设备被搬上拍卖货车，原老板提箱离开。'
), '$.cells[0].graphic') WHERE id = 4441;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '价格下跌也不停产',
  '$.cells[0].description', '阴雨中的标准石油装货场仍满负荷运转，连续油桶被推上列车；远处竞争者厂区熄火，前景主管把下一批空车引入装货线。',
  '$.cells[0].graphic', json('{"type":"card","title":"稳定盈利","lines":["价格下跌","出货不停"]}')
) WHERE id = 4442;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '把算账练到极致',
  '$.cells[0].description', '年轻洛克菲勒在农产品行账房核对货运单、硬币和厚账簿，左手逐枚分配现金，右手压住待付账单；每一笔钱都有明确去处。'
), '$.cells[0].graphic') WHERE id = 4458;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '油价跌，工厂照常运转',
  '$.cells[0].description', '油桶滞销堆满河岸时，标准石油炼厂仍炉火通明，工人把下一批煤油装进列车；同一画面远处小厂已经熄炉停工。',
  '$.cells[0].graphic', json('{"type":"card","title":"抗住下跌","lines":["油价在跌","工厂不停"]}')
) WHERE id = 4445;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '铁路翻脸还有管道',
  '$.cells[0].description', '铁路货场的机车停在封闭道岔前，旁边粗大输油管仍跨过河岸持续把原油送进标准石油厂，工人守在阀门旁检查流动。'
), '$.cells[0].graphic') WHERE id = 4446;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '订单与买家集中一处',
  '$.cells[0].description', '标准石油装货窗口前，买家和货车排成长队，工人连续交付油桶；画面边缘另一家炼油厂售货窗紧闭，门前空无一人。'
), '$.cells[0].graphic') WHERE id = 4447;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '财富捐出，代价外移',
  '$.cells[0].description', '工业城街道一侧，新诊所接收成箱药品；另一侧被收购后关闭的炼油厂前，失业工人提着工具箱离开，慈善与被转移的代价同处一景。',
  '$.cells[0].graphic', json('{"type":"card","title":"两种结果","lines":["财富捐给社会","压力留给别人"]}')
) WHERE id = 4448;

UPDATE storyboards SET grid_cells = json_set(
  grid_cells,
  '$.displayTitle', '三笔代价仍未结清',
  '$.cells[0].description', '老年洛克菲勒坐在病榻旁，桌上药瓶和敌意肖像报纸散落；窗外停工炼厂正拍卖设备，原工人抱着工具离开厂门。',
  '$.cells[0].graphic', json('{"type":"card","title":"无法抹去","lines":["健康与名声","他人的失败"]}')
) WHERE id = 4449;

UPDATE storyboards SET grid_cells = json_remove(json_set(
  grid_cells,
  '$.displayTitle', '失败代价留在厂门外',
  '$.cells[0].description', '结尾定格在紧锁的炼油厂门外：几只磨损工具箱和空饭盒被遗落在泥地，拆下的机器留下深色空位，远处烟囱再无烟火。'
), '$.cells[0].graphic') WHERE id = 4450;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '深夜铁路道口，油田工人举火把堵住铁轨，货运列车被迫停在面前，蒸汽裹住车头；前景木油桶散落，火光照亮对峙人群。'
) WHERE id = 4406;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '月光下的炼油厂一片死寂，高大烟囱和蒸馏塔无声矗立，门窗敞开却无人工作；废弃油桶散落，冷光投下漫长空影。'
) WHERE id = 4408;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '克利夫兰河岸工业区阴云低垂，近处炼油厂铁门紧闭，沿岸绝大多数烟囱已经无烟，只有远处少数厂房仍在运转。'
) WHERE id = 4411;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '被收购的厂主握着钱袋跨出办公室，身后旧厂房炉火已熄，门外工业区阴云低垂；他没有回头，门正缓缓合上。'
) WHERE id = 4414;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '输油管道工地上，工人把粗大铸铁管逐节接向远处炼厂，旁边铁路侧线闲置；洛克菲勒站在土坡上看着管线越过铁轨。'
) WHERE id = 4418;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '化学家俯身操作铜架蒸馏瓶，黑色原油在玻璃器皿中沸腾分层；洛克菲勒站在桌旁紧盯变化，实验柜隐在冷暗背景。'
) WHERE id = 4419;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '仓库里，工人把沉重油桶从空板车上搬回地面，更多油桶堆到高处；大门外铁轨和栈桥空无车马，货物找不到便宜出口。'
) WHERE id = 4420;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '实验室内，化学家调节铜质蒸馏器阀门，液体沸腾、蒸汽升起；洛克菲勒站在一旁观察，器皿反射暖光，背景沉入冷灰。'
) WHERE id = 4440;

UPDATE storyboards SET grid_cells = json_set(grid_cells,
  '$.cells[0].description', '低角度工业路口，油罐列车车轮掠过前景，一辆1910年代汽车穿行其间，后方炼油厂烟囱密布；石油、铁路和汽车同处一景。'
) WHERE id = 4457;

COMMIT;
