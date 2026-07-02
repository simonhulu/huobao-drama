# 免费影视级 BGM / 音效资源清单

> 重要前提：真正的热门电影/电视剧原声（OST）受版权保护，**不能免费商用**。这里收集的是由专业声音设计师/作曲家发布、可合法商用的「影视级」素材，以及进入公有领域的古典音乐录音。

## 已接入自动导入脚本（直接下载）

运行 `npx tsx scripts/import-free-audio-packs.ts` 即可下载并索引这些包。

### 音乐 / BGM

| 包名 | 来源 | 授权 | 大小 | 适合情绪 | 说明 |
|---|---|---|---|---|---|
| `holst-planets` | OpenGameArt | Public Domain | ~37 MB | epic / tense / mysterious | 霍尔斯特《行星组曲》完整录音，常被电影配乐引用 |
| `fantasy-choir` | OpenGameArt | CC0 | ~70 MB | epic / mysterious / sad | 奇幻合唱与管弦乐片段 |
| `vampires-piano` | OpenGameArt | CC0 | ~2.7 MB | sad / mysterious | 悲伤/黑暗奇幻钢琴循环 |
| `qazijamjam-battle` | OpenGameArt | CC0 | ~39 MB | epic / action | 管弦战斗主题 |
| `game-loops` | OpenGameArt | CC0 | ~73 MB | neutral / happy / calm / tense | 多风格循环配乐 |

### 音效 / SFX

| 包名 | 来源 | 授权 | 大小 | 说明 |
|---|---|---|---|---|
| `100-cc0-sfx-v2` | OpenGameArt | CC0 | ~2.4 MB | 脚步、玻璃、金属、环境等通用音效 |

## 需要手动下载的高质量素材

这些包因为 Gumroad / Cloudflare 拦截或体积过大，无法直接自动下载，建议手动获取后放到项目目录。

### 音效（大片级）

- **Sonniss GDC 2026 Game Audio Bundle**
  - 地址：https://gdc.sonniss.com/
  - 授权：Royalty-free，免署名，可商用
  - 大小：~7.47 GB，347 个 WAV
  - 说明：专业影视/游戏级音效，每年 GDC 期间发布

- **99Sounds Cinematic Sounds**
  - 地址：https://99sounds.org/cinematic-sounds/
  - 授权：Royalty-free
  - 大小：~357 MB
  - 说明：Braams、Booms、Impacts、Whooshes、Tension Builders

### 音乐 / Loop

- **99Sounds Cinematic Loops**
  - 地址：https://99sounds.org/cinematic-loops/
  - 授权：Royalty-free
  - 大小：~60 MB
  - 说明：99 条电影感循环

- **Signature Sounds - Orchestral CC0 Sample Pack**
  - 地址：https://signaturesounds.org/orchestral-cc0-sample-pack-cc0-free-to-download
  - 授权：CC0
  - 大小：~87 MB
  - 说明：管弦乐 score loops

- **Signature Sounds - Choirs of Life**
  - 地址：https://signaturesounds.org/store/p/choirs-of-life
  - 授权：CC0
  - 大小：~215 MB
  - 说明：合唱 loops

- **Signature Sounds - Wartime Drum Loops**
  - 地址：https://signaturesounds.org/
  - 授权：CC0
  - 大小：~49 MB
  - 说明：行军鼓/战争鼓

## 手动素材接入方式

1. 下载并解压到对应目录：
   - 音乐：`data/static/music/freepacks/<pack-name>/`
   - 音效：`data/sfx/library/<pack-name>/`
2. 运行索引刷新：
   - 音乐：`npx tsx scripts/import-free-audio-packs.ts --music`
   - 音效：`npx tsx scripts/setup-sfx-library.ts`
3. 打开前端 `/library` 页面浏览、试听。

## 命令参考

```bash
# 模拟运行，不下载
npx tsx scripts/import-free-audio-packs.ts --dry-run

# 只导入音乐包
npx tsx scripts/import-free-audio-packs.ts --music

# 只导入音效包
npx tsx scripts/import-free-audio-packs.ts --sfx

# 只导入指定包
npx tsx scripts/import-free-audio-packs.ts --packs=holst-planets,fantasy-choir

# 查看需要手动下载的精选资源
npx tsx scripts/import-free-audio-packs.ts --manual
```

## 授权提示

- **CC0**：可自由用于个人/商业项目，无需署名。
- **Public Domain**：无版权限制。
- **Royalty-free**：通常无需后续费用，但请阅读各站点的具体许可；Sonniss 明确禁止用于 AI/ML 训练。
- **CC-BY**（如 Incompetech）：需要署名，短剧分发时通常不适合。
