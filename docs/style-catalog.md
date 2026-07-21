# 视觉风格目录（gpt-image-2 版）

## 一、为什么 UI 上只看到“通用”和“写实”？

### 1.1 代码里的风格定义

- **前端创建页** `frontend/app/pages/index.vue:167` 目前只放了 7 个选项：
  ```js
  const styles = ['generic', 'realistic', 'anime', 'ghibli', 'cinematic', 'comic', 'watercolor']
  ```
- **后端** `backend/src/services/visual-style.ts` 已定义 13 个风格映射（含 historical / scifi / mythology 等）。
- **数据库** `dramas.style` 是 `text` 类型，没有任何 enum/check 约束，任意字符串都能存。

所以：
- 如果你在前端只看见 2 个，通常是下拉框被之前的搜索/筛选状态占住，或者缓存了旧状态。
- 不是后端限制，也不是 gpt-image-2 只支持两种风格。

### 1.2 gpt-image-2 的官方机制

根据 [OpenAI Image Generation 文档](https://platform.openai.com/docs/guides/image-generation)，**gpt-image-2 没有独立的 `style` 枚举参数**。风格完全通过 prompt 里的自然语言描述控制。

也就是说，不存在“官方风格列表”。只要 prompt 里写清楚 `"in the style of ..."`，模型就能识别。我们能做的是：
1. 在前端提供一个更丰富的“风格选择器”。
2. 每个风格对应一段稳定的英文 prompt 前缀（也就是 `visual-style.ts` 里正在做的事）。

---

## 二、2026 年 gpt-image-2 上最受欢迎的风格方向

根据 [PixVerse GPT Image 2 Review](https://pixverse.ai/en/blog/gpt-image-2-review-and-prompt-guide) 和 [Pixmind awesome-gpt-image-2-prompts](https://github.com/Pixmind-io/awesome-gpt-image-2-prompts) 的整理，gpt-image-2 表现最好、社区复用率最高的风格大致分为以下几类：

| 方向 | 代表关键词 | 为什么受欢迎 |
|------|-----------|-------------|
| **电影导演/摄影风格** | Wes Anderson, Denis Villeneuve, film noir, Rembrandt lighting, 35mm film | 命名具体导演或镜头语言后，模型对构图、色调、光比的控制非常稳定 |
| **写实/纪录片** | photorealistic, documentary, 35mm, candid, national geographic | 适合历史、传记、社会题材，画面有真实感和年代感 |
| **东方武侠/历史** | wuxia, Chinese ink wash, gongbi, Eastern fantasy | 在中文历史类内容里效果突出，尤其适合宫廷、江湖、战争 |
| **艺术绘画媒介** | oil painting, watercolor, impressionist, pop art, ukiyo-e | 能直接改变画面质感，避开“AI 塑料感” |
| **幻想/科幻氛围** | cyberpunk, steampunk, dark fantasy, bioluminescent | 适合神话、科幻、奇幻题材，视觉冲击强 |
| **设计/排版向** | poster, infographic, UI mockup, brand identity | gpt-image-2 的强项，文字和结构控制优于其他模型 |

> 核心技巧：对 gpt-image-2 来说，**直接点名导演、画家、工作室或具体媒介**，比堆砌形容词更有效。例如 `"Studio Ghibli style"`、`"Denis Villeneuve cinematic"`、`"Ufotable production quality"`。

---

## 三、建议扩展的风格列表

下面按“基础 / 电影摄影 / 艺术绘画 / 视觉氛围 / 媒介渲染 / 中式历史 / 西方历史”七组整理。特别加大了**历史类**的比重。

### 3.1 基础风格

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| generic | 通用（电影感） | `cinematic film still, highly detailed, refined visual, dramatic lighting, movie composition` |
| realistic | 写实 | `photorealistic, realistic lighting and textures, highly detailed` |
| cinematic | 电影 | `cinematic film still, dramatic lighting, movie composition, highly detailed` |
| anime | 二次元 | `anime style, crisp linework, vibrant colors` |
| ghibli | 吉卜力 | `Studio Ghibli style, soft painterly animation, warm colors` |
| comic | 漫画 | `comic book style, bold lines, dynamic composition` |
| watercolor | 水彩 | `watercolor painting, soft washes, painterly texture` |

### 3.2 电影摄影风格（导演/镜头语言）

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| wes_anderson | 韦斯·安德森 | `Wes Anderson style, symmetrical composition, pastel color palette, deadpan staging, 35mm film` |
| film_noir | 黑色电影 | `film noir style, high contrast black and white, dramatic shadows, moody cinematic, 1940s aesthetic` |
| rembrandt | 伦勃朗光 | `Rembrandt lighting portrait, dramatic chiaroscuro, warm tungsten key light, dark background` |
| villeneuve | 维伦纽瓦史诗 | `Denis Villeneuve style cinematic, vast scale, atmospheric haze, golden hour, ultra-wide composition` |
| wong_kar_wai | 王家卫 | `Wong Kar-wai style, neon reflections, slow shutter motion blur, moody romantic atmosphere, 35mm film grain` |
| documentary | 纪录片 | `documentary photography style, natural lighting, photojournalistic, authentic texture, candid moment` |
| vintage_film | 复古胶片 | `vintage 35mm film photography, subtle grain, warm faded colors, nostalgic mood, soft focus` |

### 3.3 艺术绘画

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| oil_painting | 油画 | `oil painting, rich brushstrokes, classical fine art, textured canvas` |
| pastel | 色粉画 | `soft pastel illustration, delicate powdery texture, gentle gradients` |
| ink_wash | 水墨 | `Chinese ink wash painting, expressive brushstrokes, monochrome ink tones, poetic atmosphere` |
| ukiyo_e | 浮世绘 | `Ukiyo-e woodblock print style, flat bold outlines, vivid colors, traditional Japanese art` |
| impressionist | 印象派 | `Impressionist painting, loose visible brushstrokes, dappled light, vivid color harmony` |
| pop_art | 波普艺术 | `Pop Art style, bold flat colors, Ben-Day dots, graphic poster aesthetic` |
| renaissance | 文艺复兴 | `Renaissance oil painting, sfumato, classical composition, religious grandeur, chiaroscuro` |
| baroque | 巴洛克 | `Baroque painting, dramatic tenebrism, ornate detail, emotional intensity, golden light` |
| neoclassical | 新古典主义 | `Neoclassical painting, clean lines, idealized forms, moral seriousness, Jacques-Louis David style` |

### 3.4 视觉氛围

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| cyberpunk | 赛博朋克 | `cyberpunk cinematic, neon-lit cityscape, high-tech low-life, rain-soaked atmosphere` |
| steampunk | 蒸汽朋克 | `steampunk aesthetic, brass gears, Victorian machinery, warm sepia tones` |
| fantasy | 奇幻 | `epic fantasy art, magical lighting, mythical atmosphere, highly detailed` |
| noir | 黑色电影 | `film noir style, high contrast black and white, dramatic shadows, moody cinematic` |
| vintage | 复古 | `vintage 1980s aesthetic, film grain, warm faded colors, nostalgic mood` |
| minimalist | 极简 | `minimalist illustration, clean lines, limited color palette, negative space` |
| dark_academia | 暗黑学院 | `dark academia aesthetic, old library, tungsten lamplight, deep navy and olive palette` |

### 3.5 媒介渲染

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| digital_art | 数字艺术 | `digital art, polished illustration, vibrant colors, clean rendering` |
| concept_art | 概念艺术 | `concept art, detailed environment design, cinematic composition, professional game art` |
| pixel_art | 像素风 | `pixel art, 16-bit retro game style, crisp pixels, limited palette` |
| line_art | 线稿 | `clean line art, black and white illustration, precise outlines, minimal shading` |
| 3d_render | 3D 渲染 | `3D render, octane render, soft studio lighting, photorealistic materials` |
| isometric | 等距插画 | `isometric illustration, clean vector-like rendering, balanced geometric composition` |

### 3.6 中式 / 东方历史（重点）

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| chinese_ink | 中式水墨 | `Chinese ink wash painting, misty mountains, flowing brushwork, elegant negative space` |
| chinese_gongbi | 工笔重彩 | `Chinese gongbi painting, fine detailed brushwork, rich mineral pigments, traditional court art` |
| wuxia | 武侠 | `wuxia cinematic, ancient Chinese martial arts, flowing robes, sword qi, moonlit bamboo forest` |
| chinese_palace | 宫廷国风 | `Chinese imperial palace style, ornate golden dragon details, red pillars, court drama atmosphere` |
| eastern_fantasy | 东方玄幻 | `Eastern fantasy, immortal cultivation aesthetic, celestial mountains, ethereal clouds, glowing runes` |
| ukiyo_samurai | 浮世绘武士 | `Ukiyo-e samurai print, dynamic combat pose, flat color areas, bold outlines, Edo period` |

### 3.7 西方 / 世界历史（重点）

| key | 中文名 | prompt 短语 |
|-----|--------|-------------|
| historical_epic | 历史史诗 | `historical epic, cinematic period drama, painterly realism, grand composition, museum quality` |
| roman_fresco | 古罗马壁画 | `ancient Roman fresco, archaeological mural, terracotta and ochre palette, classical figures` |
| byzantine | 拜占庭圣像 | `Byzantine icon painting, gold leaf background, stylized sacred figure, flat perspective` |
| medieval_manuscript | 中世纪手抄本 | `medieval illuminated manuscript, gold leaf borders, miniature painting, parchment texture` |
| dutch_golden_age | 荷兰黄金时代 | `Dutch Golden Age painting, chiaroscuro, detailed still life, Rembrandt school, 17th century` |
| victorian | 维多利亚 | `Victorian illustration, engraved line work, sepia tone, 19th century period detail` |
| prohibition_era | 禁酒令时代 | `Prohibition-era 1920s, speakeasy atmosphere, Art Deco details, black and white documentary` |
| wwii_photo | 二战纪实 | `World War II documentary photograph, period-accurate uniforms, grainy black and white, photojournalism` |

---

## 四、历史类内容最推荐的 8 个风格

如果你主要做历史/古代/传记类短视频，这 8 个风格最值得优先接入：

1. **写实 / realistic** — 通用，最接近纪录片质感
2. **电影 / cinematic** — 默认电影感，适合大部分历史叙事
3. **历史史诗 / historical_epic** — 大场面、战争、宫廷
4. **纪录片 / documentary** — 真实感最强，适合纪实类
5. **中式水墨 / chinese_ink** — 诗意、文化类、开篇/收尾
6. **工笔重彩 / chinese_gongbi** — 宫廷、贵族、细腻场景
7. **武侠 / wuxia** — 动作、江湖、冲突镜头
8. **油画 / oil_painting** — 西方历史、肖像、博物馆感

---

## 五、前端改造建议（不改代码，只列方案）

1. **把 `index.vue` 的 `styles` 数组扩展到 30+ 个**，并按七组分组展示。
2. **`visual-style.ts` 同步补充对应的 `STYLE_DESCRIPTIONS`**，未知 key 时仍可回退为 `"{style} style"`。
3. **为历史类题材增加默认推荐**：
   - history → `realistic` 或 `historical_epic`
   - ancient → `chinese_ink` 或 `oil_painting`
   - mythology → `eastern_fantasy` 或 `fantasy`
4. **每个风格加一张样例缩略图**：如果成本敏感，可以先做静态缩略图；后续再用 gpt-image-2 批量生成统一场景的样例图。

---

## 六、关于“生成一张风格图”

由于 gpt-image-2 没有固定风格枚举，**“风格图”更合适的形态是“同一场景在不同风格下的样例集合”**。 cheapest 的实现方式是：

- 先选定一个统一场景（例如“古代宫廷庭院，一位身穿汉服的官员站在梅树下”）。
- 用同一个 seed、同一个构图，只替换风格短语，批量生成 5~10 张样例。
- 拼成一张 2×N 的网格图，作为前端风格选择器的预览。

按 gpt-image-2 low quality 1024×1024 约 $0.006/张估算，生成 20 张样例约 $0.12，成本可控。
