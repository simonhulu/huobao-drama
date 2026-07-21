/**
 * Executable visual profiles for historical narration.
 *
 * Profiles describe observable photographic mechanisms. They deliberately
 * avoid creator-name shortcuts so prompts remain portable across providers.
 */

export interface HistoryVisualStyleProfile {
  id: string
  label: string
  suitedFor: string
  capture: string
  composition: string
  palette: string
  lighting: string
  texture: string
  avoid: string[]
}

export const DEFAULT_HISTORY_VISUAL_STYLE = 'historical_systems'

export const HISTORY_VISUAL_STYLE_PROFILES: Record<string, HistoryVisualStyleProfile> = {
  historical_systems: {
    id: 'historical_systems',
    label: '现实系统史诗',
    suitedFor: '历史人物、商业制度、工业扩张、迁徙、战争后勤与普通人的命运',
    capture: '实拍历史剧情片机制，普通世界先于戏剧装置；物体有重量、磨损与用途，奇观必须由人物、道路、建筑或机器提供连续尺度参照',
    composition: '先交代地理、制度或行动路线，再落到人物；以人眼高度的35-65mm中远景、大片安静表面、自然遮挡和轻微破坏的秩序为主，每镜只有一个视觉锚点',
    palette: '按场景只选一套2-3主色加1个小点缀：工业场可用煤黑、氧化钢蓝、旧象牙与锈红；机构场可用墨绿、深胡桃、泛黄纸张与封蜡红；户外可用灰蓝天空、土褐、旧奶油白与低亮度暖点。禁止整集固定双色',
    lighting: '只使用一个有场景来源的主光，写清方向、覆盖区与禁光区；人物关键动作处于可读中间调，背景通常低1-2档，高光柔和滚降',
    texture: '中等解析、有限景深、细而不规则的35mm颗粒、轻微镜头柔度、自然空气透视与克制微反差',
    avoid: ['概念图式全景深', 'HDR锐化', '每个表面同样脏旧', '英雄海报站姿', '无来源薄雾与轮廓光', '解释性文字或道具堆叠', '默认青橙调色'],
  },
  period_crime_35mm: {
    id: 'period_crime_35mm',
    label: '复古犯罪凝视',
    suitedFor: '骗局、交易、媒体操控、权力对话、冲突前后与黑色幽默',
    capture: '摄影机嵌入柜台、桌沿、车内、门口或货架空隙，以一个物件凝视或动作后的镜头滞留组织观看顺序',
    composition: '24-50mm近距离叙事焦段，明确第一眼视觉锚点与第二眼人物关系；用距离、出口、遮挡和未完成动作表达权力，不用标准旁观双人中景',
    palette: '一个连续中高密度主色占约20%-50%，第二色清楚承托，小强调色不超过10%；肤色和白色保持饱满中间调，浓黑接受邻近主色的轻微染料偏色',
    lighting: '从黑位建立一束方向光，只照亮脸、手和关键物件；明确不受光的远墙、天花板与无关陈设，背景低1-2档但地点仍可辨',
    texture: '35mm负片到印片响应，颜色浓而不荧光，高光柔和光化，颗粒随明度变化，轮廓清楚但微反差有限',
    avoid: ['默认枪械与黑西装', '雨夜霓虹湿地套餐', '低饱和灰褐滤镜', '多个道具同时抢眼', '把剧情一次解释完', '塑料肤色', '商业洁净布光'],
  },
  institutional_tableau: {
    id: 'institutional_tableau',
    label: '制度剧场',
    suitedFor: '银行、邮局、报社、车站、档案室、办公室、排队与制度性荒诞',
    capture: '正面水平的静止电影镜头，手工搭建般的时期布景，人物表演克制，动作停在半途',
    composition: '严格正面对称或清楚左右平衡，门窗、柜台、货架、灯具与文件成对或成排；中轴由布景暗示，任何实体竖线不得切过脸或身体',
    palette: '从粉、薄荷绿、湖蓝、芥末黄、奶油白、砖红、暖棕中选2-4色，明亮干净、轻微年代褪色但不发灰',
    lighting: '稳定柔和的时期实景光与暖补光，水平垂直线保持端正；亮度服务色块秩序，不做阴森欠曝',
    texture: '保存良好的1960s-1970s彩色胶片与旧印刷明信片质感，轻颗粒、触感清楚但不塑料',
    avoid: ['荷兰角和歪地平线', '证件照式人物站姿', '可见中轴切脸', '商业广告与海报排版', '整体灰雾', '现代霓虹', '杂乱无序背景'],
  },
  republican_shanghai: {
    id: 'republican_shanghai',
    label: '民国上海复古',
    suitedFor: '民国都市、报业、金融、舞厅、旅馆与夜间街景',
    capture: '精致时期都市电影摄影，玻璃、金属、木材与织物各自保留细长高光和柔和反射',
    composition: '50mm自然压缩与端正典雅构图，以Art Deco比例、门框、橱窗和街灯建立空间秩序',
    palette: '深墨绿、暗金、酒红、胡桃棕与灰蓝交织，暖肤色从带绿色的冷灰环境中分离',
    lighting: '钨丝灯把人物染成柔和暖金，环境阴影沉入带绿色的冷灰；实景灯只形成局部亮点',
    texture: '细腻胶片颗粒、轻微柔焦、暖色光晕与优雅暗部层次',
    avoid: ['现代建筑与服饰', '全局琥珀棕滤镜', '青橙商业调色', '高锐度数码皮肤', '过亮霓虹', '豪华广告片摆拍'],
  },
  showa_nostalgia: {
    id: 'showa_nostalgia',
    label: '昭和生活怀旧',
    suitedFor: '日常生活、家庭、餐馆、等待、回忆与安静人物段落',
    capture: '昭和后期生活电影的平静观察，50mm自然透视，镜头高度接近日常视线',
    composition: '安静平衡但不过度对称，让人物处于等待、发呆或小动作中，保留桌面、窗框与生活陈设的真实秩序',
    palette: '米白、茶褐、褪色绿、深蓝和暖灰形成柔和低饱和画面，不能退成灰褐单色',
    lighting: '自然光从窗边或侧后方缓慢铺开，阴影带轻微青色，亮部为乳白与淡黄，肤色温润',
    texture: '细密胶片颗粒、轻微褪色、柔软高光、淡淡光晕与温和反差',
    avoid: ['商业生活方式广告', '奶油高调写真', '过度做旧', '高反差黑位', '霓虹夜景', '临床锐利细节'],
  },
  northwest_epic: {
    id: 'northwest_epic',
    label: '西北乡土史诗',
    suitedFor: '土地、迁徙、劳作、贫困、家族与地域命运',
    capture: '中国西北乡土史诗电影机制，人物与粗糙地貌都保持真实重量',
    composition: '24-35mm稳定远景或全景，人物相对环境更小，地平线明确，天空与地面形成宏大明暗关系',
    palette: '土地色、赭石、暗红、枯草黄、深棕与灰蓝构成厚重色谱',
    lighting: '低角度自然光横向扫过人物和环境，让土墙、布料与皮肤获得清楚纹理，曝光微微压暗',
    texture: '颗粒明显但不遮细节的35mm胶片，沉稳肤色与粗粝材料响应',
    avoid: ['旅游风光片', '金色励志广告', '人物英雄化仰拍', '天空HDR', '统一橙棕滤镜', '精致无尘服装'],
  },
  korean_crime: {
    id: 'korean_crime',
    label: '冷峻现实犯罪',
    suitedFor: '调查、追踪、底层生活、压迫空间与无英雄化犯罪叙事',
    capture: '现实主义犯罪电影的冷静纪实观察，细微手持而非炫技运动',
    composition: '35mm或50mm，人物偏离中心，使用前景遮挡与大面积空白制造压迫，背景地点信息保持可读',
    palette: '灰绿、铅灰、暗棕和浑浊土黄形成低饱和色彩，但黑位与肤色仍保留层次',
    lighting: '冷而平的环境光，以单一方向自然光或现场灯塑形面部；整体略低曝光，高光克制',
    texture: '低反差胶片颗粒、真实偏冷肤色与不完美现场质感',
    avoid: ['蓝橙流媒体滤镜', '黑到看不清人物', '英雄轮廓光', '霓虹湿街', '精致商业构图', '过强手持模糊'],
  },
  studio_wuxia: {
    id: 'studio_wuxia',
    label: '邵氏棚拍武侠',
    suitedFor: '1970年代华语棚拍武侠、门派对峙、室内动作与仪式性人物',
    capture: '1970年代香港棚拍彩色武侠电影，人工布景具有清楚前中后景',
    composition: '稳定中景或全身构图，略低机位，人物轮廓、武器方向与舞台调度清楚',
    palette: '朱红、墨绿、金黄与靛蓝构成浓郁东方配色',
    lighting: '正面硬光照亮主体，顶部轮廓光勾边，阴影清晰，肤色温暖',
    texture: 'Eastmancolor高饱和胶片、轻微柔焦与细密颗粒',
    avoid: ['现代冷灰武侠', '真实旅游外景', '游戏盔甲', '仙侠粒子', '数字HDR', '复杂战术皮具'],
  },
  location_kungfu: {
    id: 'location_kungfu',
    label: '七十年代实景功夫',
    suitedFor: '街巷、院落、追逐、训练与完整身体动作',
    capture: '1970年代香港实景功夫片，动作由身体重心、手脚与移动方向承担',
    composition: '28-35mm老式球面镜头，平视全身构图，完整保留动作作用线，轻微手持与变焦呼吸',
    palette: '砖红、土黄、棕褐与褪色墨绿形成温暖朴素色彩',
    lighting: '日光直接照射人物，亮部偏黄，阴影厚重自然',
    texture: '粗颗粒35mm胶片与真实年代褪色',
    avoid: ['特效武打', '现代动作广告', '过浅景深', '裁断手脚', '高饱和霓虹', '无重量飞行动作'],
  },
  ink_wuxia: {
    id: 'ink_wuxia',
    label: '东方水墨武侠',
    suitedFor: '雾雨、远行、孤身侠客、山水空镜与沉静东方叙事',
    capture: '东方写意武侠电影，以真实摄影的柔和层次模拟水墨浓淡，不转成插画',
    composition: '长焦压缩空间，大面积留白包围主体，景深层次含蓄，人物常位于侧面或成为小比例轮廓',
    palette: '黑、灰、青灰、雾白与极低饱和墨绿逐级展开',
    lighting: '柔和天光形成薄雾般明暗过渡，人物边缘只以微弱逆光分离',
    texture: '衣料与环境保留真实电影摄影质感，细腻胶片颗粒与轻柔高光',
    avoid: ['水墨插画笔触', '仙侠CG', '完整英雄海报', '浓艳多色', '强体积光', '高锐度山水细节'],
  },
  old_color_wuxia: {
    id: 'old_color_wuxia',
    label: '旧彩浪漫武侠',
    suitedFor: '竹林、瀑布、芦苇、月夜、古典人物与舞台化武打',
    capture: '七十至八十年代华语彩色武侠幻想电影，实景前台连接绘景或光学合成般远景，人物使用旧式银幕柔光',
    composition: '固定平视舞台面，大形先于陈设；古树、草海、雾带、月轮或瀑布至少占三分之一，人物通过错位和不同朝向形成平衡而非镜像',
    palette: '每镜只选青绿瀑布、麦金芦苇、钴蓝月夜、雾蓝山水或桃金花野中的一个单色世界，再加小面积互补点',
    lighting: '演员与背景可分别布光，人物暖象牙面光配背景侧逆色光；高光轻微泛白，暗部形成完整色块',
    texture: '旧球面镜头、有限解析、低微反差、轻微串色与薄高光辉光，颗粒极轻',
    avoid: ['现代冷灰数字武侠', '写实旅游外景', '粗颗粒划痕', '镜像双人', '网红脸', '战术皮具', '清晰太阳圆盘'],
  },
  guofeng_editorial: {
    id: 'guofeng_editorial',
    label: '古风暗场时尚',
    suitedFor: '人物肖像、礼服、闺阁、仪式、镜面、纱帐与亲密关系镜头',
    capture: '只选一种摄影引擎：近轴闪光暗环境、低照度柔光高光扩散、硬质侧逆光、低调仪式肖像或纱帐包裹逆光',
    composition: '竖幅密集人物占比，允许肩袖裁切、镜框、纱、前景身体或道具形成真实遮挡；多人采用不等高、触碰与错开视线',
    palette: '深黑环境托住赤金、桃琥珀、粉玫瑰、淡青或墨绿中的一个主色洗，保留一个饱和锚点',
    lighting: '环境比受光人物低1.5-2.5档，高光扩散只发生在金饰、珍珠、丝绸、镜面与纱边，主要五官仍可读',
    texture: '编辑式不完美、局部光学晕染、降低数字边缘锐度，皮肤保留自然差异而非塑料磨皮',
    avoid: ['明亮均匀汉服广告', '全局高斯模糊', '所有人物同样清晰', '完整英雄轮廓', '青橙商业调色', '干净空背景', '解释剧情的道具'],
  },
  night_flash_snapshot: {
    id: 'night_flash_snapshot',
    label: '夜街直闪快照',
    suitedFor: '现代青年、夜游、便利店、街头文化与主观回忆段落',
    capture: '小型数码相机、CCD或傻瓜胶片机的近轴机顶直闪快照',
    composition: '优先竖幅，近距离轻广角，主体可偏边、局部裁切、轻微倾斜和非完美对焦，保持真实突然抓拍感',
    palette: '低饱和彩色夜景，暗部偏冷青、冷蓝与冷绿，局部红橙招牌只作小点缀',
    lighting: '闪光直接打亮脸、手、浅色衣物与道具，产生硬影和局部过曝；背景只保留便利店、路灯或招牌环境点光',
    texture: '肉眼可见的粗颗粒、重胶片颗粒、高ISO数码噪点、暗部脏感与轻微模糊',
    avoid: ['单色照片', '商业时装大片', '柔光棚拍', '奶油清新写真', '高清塑料皮肤', '过度电影调色', '颗粒被降噪'],
  },
  commercial_teal_orange: {
    id: 'commercial_teal_orange',
    label: '现代青橙商业',
    suitedFor: '明确需要现代商业动作片气质的少量镜头，不建议作为历史纪录片默认',
    capture: '现代高动态范围数字电影摄影，主体清楚、浅景深与柔和椭圆散景',
    composition: '以清楚主体边缘和现代电影镜头景深组织画面，避免把调色当作构图替代品',
    palette: '背景、阴影与环境光进入青蓝和冷灰，肤色与主要高光保持琥珀橙和暖金',
    lighting: '方向明确的暖主光配冷环境光，黑位深沉有纹理，高光集中',
    texture: '高动态范围数字摄影、细微水平光晕与锐利主体细节',
    avoid: ['全画面橙青平均分配', '无来源轮廓光', '塑料皮肤', '所有历史题材通用化', 'HDR白边', '霓虹堆叠'],
  },
}

const STYLE_ALIASES: Record<string, string> = {
  '': DEFAULT_HISTORY_VISUAL_STYLE,
  generic: DEFAULT_HISTORY_VISUAL_STYLE,
  realistic: DEFAULT_HISTORY_VISUAL_STYLE,
  cinematic: DEFAULT_HISTORY_VISUAL_STYLE,
  documentary: DEFAULT_HISTORY_VISUAL_STYLE,
  historical: DEFAULT_HISTORY_VISUAL_STYLE,
  historical_epic: DEFAULT_HISTORY_VISUAL_STYLE,
  film_noir: 'period_crime_35mm',
  noir: 'period_crime_35mm',
  wes_anderson: 'institutional_tableau',
  wuxia: 'old_color_wuxia',
  chinese_ink: 'ink_wuxia',
  ink_wash: 'ink_wuxia',
  vintage_film: 'showa_nostalgia',
}

export function resolveHistoryVisualStyle(style: string | null | undefined): HistoryVisualStyleProfile {
  const normalized = (style || '').trim().toLowerCase()
  if (HISTORY_VISUAL_STYLE_PROFILES[normalized]) return HISTORY_VISUAL_STYLE_PROFILES[normalized]
  if (STYLE_ALIASES[normalized]) return HISTORY_VISUAL_STYLE_PROFILES[STYLE_ALIASES[normalized]]

  const requestedId = normalized.replace(/^custom:/, '')
  const requestedLabel = requestedId.replace(/[_-]+/g, ' ')
  return {
    id: `custom:${requestedId}`,
    label: `项目自定义：${requestedLabel}`,
    suitedFor: '项目已经明确选择的非历史档案视觉体系',
    capture: `保留项目显式风格“${requestedLabel}”的媒介与造型语言，同时把摄影机位置、主体动作、空间层次和时代细节写成可见指令`,
    composition: '服从项目显式风格，但仍保持每镜一个视觉锚点、一个决定性叙事状态、清楚前中后景和可读关键动作',
    palette: '服从项目显式风格的色彩体系；每镜写清最大色块、承托色块和小强调色的具体落点，不使用未说明的全局滤镜',
    lighting: '服从项目显式风格，同时写清主光来源、方向、覆盖区、禁光区和背景相对曝光',
    texture: '把项目显式媒介拆成边缘、微反差、高光、黑位与纹理响应，不用“高质量”或“电影感”替代',
    avoid: ['改变项目显式风格', '两个捕获机制混用', '时代错置', '关键动作不可读', '文字与水印', '塑料AI质感'],
  }
}

export function buildHistoryVisualStyleDirective(style: string | null | undefined): string {
  const profile = resolveHistoryVisualStyle(style)
  return [
    `风格档案：${profile.label}（${profile.id}）`,
    `适用叙事：${profile.suitedFor}`,
    `摄影机制：${profile.capture}`,
    `构图机制：${profile.composition}`,
    `色彩策略：${profile.palette}`,
    `光线机制：${profile.lighting}`,
    `媒介响应：${profile.texture}`,
    `硬性排除：${profile.avoid.join('、')}`,
  ].join('；')
}

export function buildHistoryLookInstruction(style: string | null | undefined): string {
  const profile = resolveHistoryVisualStyle(style)
  return `当前系列采用「${profile.label}」：${profile.palette}；${profile.lighting}；${profile.composition}。look 必须写本镜头实际可见的配色、光位和氛围，不得只复述风格名称。`
}
