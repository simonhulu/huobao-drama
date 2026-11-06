/**
 * Grid 管线集级音频升级：多幕 BGM cue + 场景 SFX cue + 侧链闪避 + 终混响度归一。
 *
 * 设计来源（见 docs/plans/2026-07-26-grid-bgm-sfx-upgrade.md）：
 * - 语义来自数据：storyboards.bgmPrompt / soundEffect / atmosphere + 情绪桶推断；
 * - 时序由代码计算：复用 v8 权威 Beat 窗口（与 GridStoryPreview 渲染完全同源），
 *   不靠 LLM 手写时间点（OpenMontage 教训：LLM 算时间会漂移）；
 * - 多幕 BGM = 每段 cue 独立 循环/裁剪 + 淡入淡出 + adelay，amix 叠加出 crossfade；
 * - SFX 克制：垫在人声之下（0.28 线性）、相邻去重、最小间隔、匹配不到就跳过；
 * - 任何素材缺失只跳过对应 cue，绝不阻塞渲染。
 */
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { resolveBeatTimingMap } from '../grid-story-props.js';
import { inferEpisodeAudioProfiles } from '../audio-profile.js';
import { resolveLocalBgmForProfile } from '../local-bgm-library.js';
import { planEpisodeBgmCues } from './bgm-cue-planner.js';
import { findSfxFiles } from '../sfx-library.js';
import { toAbsPath } from '../ffmpeg-compose.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const FFMPEG_BIN = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FPS = 30;
// ---- 电平/时序参数（sound-design 基线，详见方案文档第四节）----
/** BGM bed 先统一响度再降到混入音量（与 episode-mixer 对齐） */
const BGM_BED_TARGET_LUFS = -18;
const BGM_BED_MIX_VOLUME = 0.5;
/** 终混平台目标：短视频 -14 LUFS / TP -1.5 */
const FINAL_TARGET_LUFS = -14;
const FINAL_TRUE_PEAK = -1.5;
/** 侧链闪避：沿用线上已验证参数 */
const SIDECHAIN = 'threshold=0.02:ratio=9:attack=18:release=300';
const BGM_CUE_FADE_SECONDS = 2;
const BGM_CUE_CROSSFADE_SECONDS = 2;
/** SFX 克制原则：低音量、短时长、有间隔、不重复 */
const SFX_VOLUME = 0.28;
const SFX_MIN_GAP_SECONDS = 4;
const SFX_MAX_DURATION_SECONDS = 3;
const SFX_MAX_USES_PER_FILE = 3;
const SFX_START_OFFSET_SECONDS = 0.2;
/** 环境音床：场景边界交叉淡化时长 / 最短铺底窗口 / 同场景跨缺口合并上限 */
const AMBIENCE_CROSSFADE_SECONDS = 1.5;
const AMBIENCE_MIN_WINDOW_SECONDS = 3;
/** 同场景被少量无场景镜头隔断时，缺口 ≤ 该值则铺底延续（避免环境音频繁起落） */
const AMBIENCE_MAX_MERGE_GAP_SECONDS = 8;
// ---------------------------------------------------------------------------
// 纯函数：BGM cue 时序（交叠 crossfade 数学）
// ---------------------------------------------------------------------------
/**
 * 把 cue 计划的"逻辑窗口"换算成"实际播放段"：
 * 非首段起点提前一个交叠量、淡入=交叠量，与上一段的淡出叠加形成 crossfade。
 */
export function planBgmCueTimings(cues, totalSec) {
    const out = [];
    for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const overlap = i === 0
            ? 0
            : Math.min(BGM_CUE_CROSSFADE_SECONDS, cue.start, cue.duration / 3);
        const startSec = Math.max(0, cue.start - overlap);
        let durationSec = cue.duration + overlap;
        // 段尾不得越过正片总长
        durationSec = Math.min(durationSec, Math.max(0, totalSec - startSec));
        if (durationSec < 0.5)
            continue;
        const fadeInSec = Math.min(i === 0 ? BGM_CUE_FADE_SECONDS : overlap, durationSec / 2);
        const fadeOutSec = Math.min(i === cues.length - 1 ? BGM_CUE_FADE_SECONDS : Math.min(BGM_CUE_CROSSFADE_SECONDS, cue.duration / 3), durationSec / 2);
        out.push({
            startSec,
            durationSec,
            path: cue.bgmPath,
            emotionBucket: cue.emotionBucket,
            fadeInSec,
            fadeOutSec,
        });
    }
    return out;
}
export function planSfxCueTimings(requests, resolve) {
    const cues = [];
    const useCounts = new Map();
    let prevPath = null;
    let lastPlacedStart = Number.NEGATIVE_INFINITY;
    for (const req of requests) {
        const description = req.description.trim();
        if (!description)
            continue;
        const startSec = req.shotStartSec + SFX_START_OFFSET_SECONDS;
        if (startSec - lastPlacedStart < SFX_MIN_GAP_SECONDS)
            continue;
        const durationSec = Math.min(SFX_MAX_DURATION_SECONDS, req.shotDurationSec - SFX_START_OFFSET_SECONDS);
        if (durationSec < 0.25)
            continue;
        const exclude = new Set();
        if (prevPath)
            exclude.add(prevPath);
        for (const [file, count] of useCounts) {
            if (count >= SFX_MAX_USES_PER_FILE)
                exclude.add(file);
        }
        const resolved = resolve(description, exclude, req.storyboardNumber);
        if (!resolved)
            continue;
        cues.push({
            startSec,
            durationSec,
            path: resolved,
            storyboardNumber: req.storyboardNumber,
            description,
        });
        useCounts.set(resolved, (useCounts.get(resolved) ?? 0) + 1);
        prevPath = resolved;
        lastPlacedStart = startSec;
    }
    return cues;
}
/**
 * 场景规则表（策展制，类似 OpenMontage 的 manifest）：
 * 新素材入库后在对应规则的 candidates 里登记即可被计划使用。
 */
export const AMBIENCE_RULES = [
    {
        scene: 'battle',
        keywords: ['战场', '厮杀', '冲锋', '交战', '肉搏', '破阵', '陷阵', '开战', '接战', '鏖战', '杀声', '血战', '喊杀'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_battlefield_loop.mp3',
            'data/sfx/library/historical-reusable/battlefield_ambience_cc0.mp3',
            'data/sfx/library/historical-reusable/battle_crowd_charge_cc0.mp3',
        ],
        volume: 0.18,
    },
    {
        scene: 'carriage',
        keywords: ['马车', '车轮', '辘辘', '木车', '牛车', '辎重', '车厢', '车辙', '轴'],
        candidates: ['data/sfx/library/ambience-loops/sa3_carriage_wheels_loop.mp3'],
        volume: 0.16,
    },
    {
        scene: 'march',
        keywords: ['行军', '马蹄', '疾驰', '奔袭', '纵马', '驰骋', '跋涉', '万马奔腾', '马队'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_horse_gallop_loop.mp3',
            'data/sfx/library/historical-reusable/horse_hoof_gallop_six_horses_outdoor_loop.mp3',
        ],
        volume: 0.18,
    },
    {
        scene: 'camp',
        keywords: ['篝火', '营帐', '扎营', '夜营', '寒夜', '柴火', '噼啪'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_campfire_loop.mp3',
            'data/sfx/library/ambience-loops/campfire_fireplace_loop.mp3',
        ],
        volume: 0.15,
    },
    {
        scene: 'steppe',
        keywords: ['草原', '塞外', '大漠', '戈壁', '寒风', '旷野', '荒原', '风沙', '风雪', '北风', '风声', '风'],
        negativeKeywords: ['烛', '案', '殿', '朝堂', '帐内', '室内'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_wind_steppe_loop.mp3',
            'data/sfx/library/ambience-loops/wind_cold_background_loop.mp3',
        ],
        volume: 0.15,
    },
    {
        scene: 'crowd',
        keywords: ['朝堂', '市井', '集市', '人群', '争论', '议论', '喧闹', '街市'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_crowd_hall_loop.mp3',
            'data/sfx/library/ambience-loops/crowd_murmur_ambience_loop.mp3',
        ],
        volume: 0.14,
    },
    {
        scene: 'water',
        keywords: ['湖水', '河水', '江畔', '河边', '浪', '水声'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_water_stream_loop.mp3',
            'data/sfx/library/100-cc0-sfx-v2/sfx100v2_loop_water_01.mp3',
        ],
        volume: 0.14,
    },
    {
        scene: 'rural',
        keywords: ['田园', '村落', '乡村', '田野', '鸟鸣'],
        candidates: [
            'data/sfx/library/ambience-loops/sa3_rural_village_loop.mp3',
            'data/sfx/library/historical-reusable/rural_gentle_breeze_birds_ambient_loop.mp3',
        ],
        volume: 0.14,
    },
];
/** 按规则表对一段场景文本分类；无命中返回 null（该镜头不铺环境音） */
export function classifyAmbienceScene(text) {
    if (!text.trim())
        return null;
    for (const rule of AMBIENCE_RULES) {
        if (rule.negativeKeywords?.some((kw) => text.includes(kw)))
            continue;
        if (rule.keywords.some((kw) => text.includes(kw)))
            return rule;
    }
    return null;
}
/**
 * 把逐镜场景分类合并成铺底窗口：相邻同场景合并，窗口过短丢弃，
 * 场景交界处用"下一段提前 1.5s 起播 + 各自淡变"做交叉淡化。
 */
export function planAmbienceCueWindows(shots, resolvePath) {
    const groups = [];
    for (const shot of shots) {
        if (!shot.rule)
            continue;
        const endSec = shot.startSec + shot.durationSec;
        const last = groups[groups.length - 1];
        // 同场景且缺口不大 → 铺底延续；场景不同或缺口过大 → 开新窗口
        if (last && last.rule.scene === shot.rule.scene
            && shot.startSec - last.endSec <= AMBIENCE_MAX_MERGE_GAP_SECONDS) {
            last.endSec = endSec;
        }
        else {
            groups.push({ rule: shot.rule, startSec: shot.startSec, endSec });
        }
    }
    const cues = [];
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const path = resolvePath(g.rule);
        if (!path)
            continue;
        const overlap = i === 0 ? 0 : AMBIENCE_CROSSFADE_SECONDS;
        const startSec = Math.max(0, g.startSec - overlap);
        const durationSec = g.endSec - startSec;
        if (durationSec < AMBIENCE_MIN_WINDOW_SECONDS)
            continue;
        cues.push({
            startSec,
            durationSec,
            path,
            scene: g.rule.scene,
            volume: g.rule.volume,
            fadeInSec: Math.min(i === 0 ? AMBIENCE_CROSSFADE_SECONDS : overlap, durationSec / 2),
            fadeOutSec: Math.min(AMBIENCE_CROSSFADE_SECONDS, durationSec / 2),
        });
    }
    return cues;
}
// ---------------------------------------------------------------------------
// 纯函数：ffmpeg 参数构建
// ---------------------------------------------------------------------------
function sec(value) {
    return value.toFixed(3).replace(/\.?0+$/, '') || '0';
}
function ms(value) {
    return Math.max(0, Math.round(value * 1000));
}
/**
 * 构建单次 ffmpeg filtergraph：
 * 旁白(输入0) + BGM cue 轨(循环/裁剪/淡变/延迟 → amix → loudnorm → 音量) 被旁白侧链闪避
 * + SFX cue 轨(音量/延迟 → amix)，终混 loudnorm 到平台目标 + 限幅。
 */
export function buildAudioMixArgs(inputVideo, output, plan) {
    const args = ['-y', '-i', inputVideo];
    for (const cue of plan.bgmCues) {
        args.push('-stream_loop', '-1', '-i', cue.path);
    }
    for (const cue of plan.sfxCues) {
        args.push('-i', cue.path);
    }
    for (const cue of plan.ambienceCues) {
        args.push('-stream_loop', '-1', '-i', cue.path);
    }
    const total = sec(plan.durationSec);
    const filters = [];
    const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
    // BGM cue 轨
    plan.bgmCues.forEach((cue, i) => {
        const inputIndex = i + 1;
        const delay = ms(cue.startSec);
        const fadeOutStart = Math.max(0, cue.durationSec - cue.fadeOutSec);
        filters.push(`[${inputIndex}:a]atrim=0:${sec(cue.durationSec)},asetpts=PTS-STARTPTS,${AUDIO_FORMAT},` +
            `afade=t=in:st=0:d=${sec(cue.fadeInSec)},afade=t=out:st=${sec(fadeOutStart)}:d=${sec(cue.fadeOutSec)},` +
            `adelay=${delay}|${delay}:all=1[bgm${i}]`);
    });
    // SFX cue 轨（瞬态事件不做 loudnorm）
    plan.sfxCues.forEach((cue, j) => {
        const inputIndex = plan.bgmCues.length + j + 1;
        const delay = ms(cue.startSec);
        filters.push(`[${inputIndex}:a]atrim=0:${sec(cue.durationSec)},asetpts=PTS-STARTPTS,${AUDIO_FORMAT},` +
            `volume=${SFX_VOLUME},adelay=${delay}|${delay}:all=1[sfx${j}]`);
    });
    // 环境音床轨（场景级持续铺底；按规则音量，不做 loudnorm）
    plan.ambienceCues.forEach((cue, k) => {
        const inputIndex = plan.bgmCues.length + plan.sfxCues.length + k + 1;
        const delay = ms(cue.startSec);
        const fadeOutStart = Math.max(0, cue.durationSec - cue.fadeOutSec);
        filters.push(`[${inputIndex}:a]atrim=0:${sec(cue.durationSec)},asetpts=PTS-STARTPTS,${AUDIO_FORMAT},` +
            `volume=${cue.volume},` +
            `afade=t=in:st=0:d=${sec(cue.fadeInSec)},afade=t=out:st=${sec(fadeOutStart)}:d=${sec(cue.fadeOutSec)},` +
            `adelay=${delay}|${delay}:all=1[amb${k}]`);
    });
    const mixIns = ['[nar]'];
    // BGM bed（loudnorm 统一响度后降到混入音量）
    if (plan.bgmCues.length > 0) {
        const bgmLabels = plan.bgmCues.map((_, i) => `[bgm${i}]`).join('');
        filters.push(`${bgmLabels}amix=inputs=${plan.bgmCues.length}:duration=longest:dropout_transition=0:normalize=0[bgmmix]`, `[bgmmix]apad=whole_dur=${total}[bgmpad]`, `[bgmpad]atrim=duration=${total}[bgmtrim]`, `[bgmtrim]loudnorm=I=${BGM_BED_TARGET_LUFS}:TP=-2:LRA=11[bgmnorm]`, `[bgmnorm]volume=${BGM_BED_MIX_VOLUME}[bgmbed]`);
    }
    // 环境音 bed
    if (plan.ambienceCues.length > 0) {
        const ambLabels = plan.ambienceCues.map((_, k) => `[amb${k}]`).join('');
        filters.push(`${ambLabels}amix=inputs=${plan.ambienceCues.length}:duration=longest:dropout_transition=0:normalize=0[ambmix]`, `[ambmix]apad=whole_dur=${total}[ambpad]`, `[ambpad]atrim=duration=${total}[ambbed]`);
    }
    // bed（BGM + 环境音）合并后统一被人声侧链闪避
    const beds = [];
    if (plan.bgmCues.length > 0)
        beds.push('[bgmbed]');
    if (plan.ambienceCues.length > 0)
        beds.push('[ambbed]');
    if (beds.length > 0) {
        let duckSource;
        if (beds.length === 2) {
            filters.push(`${beds.join('')}amix=inputs=2:duration=first:normalize=0[bedall]`);
            duckSource = '[bedall]';
        }
        else {
            duckSource = beds[0];
        }
        filters.push('[0:a]asplit=2[nar][narsc]', `${duckSource}[narsc]sidechaincompress=${SIDECHAIN}[bedduck]`);
        mixIns.push('[bedduck]');
    }
    else {
        filters.push('[0:a]acopy[nar]');
    }
    if (plan.sfxCues.length > 0) {
        const sfxLabels = plan.sfxCues.map((_, j) => `[sfx${j}]`).join('');
        filters.push(`${sfxLabels}amix=inputs=${plan.sfxCues.length}:duration=longest:dropout_transition=0:normalize=0[sfxmix]`, `[sfxmix]apad=whole_dur=${total}[sfxpad]`, `[sfxpad]atrim=duration=${total}[sfxbed]`);
        mixIns.push('[sfxbed]');
    }
    filters.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:normalize=0[premix]`, `[premix]loudnorm=I=${FINAL_TARGET_LUFS}:TP=${FINAL_TRUE_PEAK}:LRA=11[prenorm]`, '[prenorm]alimiter=limit=0.95[aout]');
    args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k', 
    // moov 前置，浏览器/播放器无需拉全文件即可开播（大文件关键）
    '-movflags', '+faststart', output);
    return args;
}
// ---------------------------------------------------------------------------
// DB 装配：从 v8 权威时序 + 情绪画像 + 本地素材库构建整集音频计划
// ---------------------------------------------------------------------------
function resolveEpisodeBgmFallback(episodeId) {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    const rel = ep?.bgmAudioUrl ? String(ep.bgmAudioUrl) : '';
    if (!rel)
        return null;
    return fs.existsSync(toAbsPath(rel))
        ? { path: rel, emotionBucket: 'neutral', role: 'primary' }
        : null;
}
/**
 * 构建整集（或 pilot 预算内）的音频计划。
 * 返回 null 表示"没有任何可混的音频"（调用方退回旧行为）。
 * 本函数只读素材与元数据；任何单点素材缺失只跳过对应 cue。
 */
export function buildGridAudioPlan(episodeId, opts = {}) {
    const storyboards = db
        .select()
        .from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(schema.storyboards.storyboardNumber)
        .all();
    if (storyboards.length === 0)
        return null;
    // v8 权威时序（与 GridStoryPreview 渲染同源，禁止估算）
    const beatTiming = resolveBeatTimingMap(episodeId);
    const windows = storyboards.map((sb) => beatTiming.get(sb.id));
    if (windows.some((w) => !w))
        return null;
    const absStartFrames = windows.map((w) => Math.round((w.startMs / 1000) * FPS));
    const absEndFrames = windows.map((w, i) => Math.max(absStartFrames[i] + 1, Math.round((w.endMs / 1000) * FPS)));
    const budgetFrames = Number.isFinite(opts.maxDurationSec) && Number(opts.maxDurationSec) > 0
        ? Math.max(1, Math.round(Number(opts.maxDurationSec) * FPS))
        : null;
    const audioStartFrame = absStartFrames[0];
    const shots = [];
    for (let i = 0; i < storyboards.length; i++) {
        if (budgetFrames !== null && absEndFrames[i] - audioStartFrame > budgetFrames)
            break;
        shots.push({
            sb: storyboards[i],
            startSec: (absStartFrames[i] - audioStartFrame) / FPS,
            durationSec: (absEndFrames[i] - absStartFrames[i]) / FPS,
        });
    }
    if (shots.length === 0)
        return null;
    const durationSec = Math.max(...shots.map((s) => s.startSec + s.durationSec));
    // ---- BGM：情绪桶 → ≤3 条本地曲目 → 幕布 cue 计划 ----
    const profiles = inferEpisodeAudioProfiles(episodeId);
    const bucketDurations = new Map();
    for (const shot of shots) {
        const bucket = profiles.get(shot.sb.id)?.emotionBucket ?? 'neutral';
        bucketDurations.set(bucket, (bucketDurations.get(bucket) ?? 0) + shot.durationSec);
    }
    const rankedBuckets = Array.from(bucketDurations.entries())
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([bucket]) => bucket)
        .slice(0, 3);
    const tracks = [];
    const usedPaths = new Set();
    for (const bucket of rankedBuckets) {
        const rel = resolveLocalBgmForProfile(bucket, { seed: `grid-ep${episodeId}:${bucket}` });
        if (!rel || usedPaths.has(rel))
            continue;
        usedPaths.add(rel);
        tracks.push({ path: rel, emotionBucket: bucket, role: tracks.length === 0 ? 'primary' : 'secondary' });
    }
    if (tracks.length === 0) {
        // 本地库无可靠匹配时退回既有单轨（保持旧行为），不触发任何生成/外网调用
        const fallback = resolveEpisodeBgmFallback(episodeId);
        if (fallback)
            tracks.push(fallback);
    }
    const plannerShots = shots.map((s) => ({ id: s.sb.id, videoDuration: s.durationSec }));
    const rawCues = tracks.length > 0 ? planEpisodeBgmCues(plannerShots, profiles, tracks) : [];
    const bgmCues = planBgmCueTimings(rawCues, durationSec)
        .map((cue) => ({ ...cue, path: toAbsPath(cue.path) }))
        .filter((cue) => fs.existsSync(cue.path));
    // ---- 环境音床：逐镜场景分类 → 相邻同场景合并铺底 ----
    const ambienceSlices = shots.map((s) => ({
        storyboardNumber: s.sb.storyboardNumber,
        startSec: s.startSec,
        durationSec: s.durationSec,
        rule: classifyAmbienceScene([s.sb.soundEffect, s.sb.atmosphere, s.sb.title, s.sb.location].filter(Boolean).join(' ')),
    }));
    const sceneByStoryboard = new Map();
    for (const slice of ambienceSlices)
        sceneByStoryboard.set(slice.storyboardNumber, slice.rule);
    const ambienceCues = process.env.DISABLE_SFX === '1'
        ? []
        : planAmbienceCueWindows(ambienceSlices, (rule) => {
            for (const candidate of rule.candidates) {
                const abs = path.join(repoRoot, candidate);
                if (fs.existsSync(abs))
                    return abs;
            }
            return null;
        });
    // ---- SFX：逐镜 soundEffect → 库匹配（克制规则在 planSfxCueTimings）----
    // 已有场景铺底的镜头，通用 ambient loop 事件音不再重复叠加（音床已覆盖该语义）
    let sfxCues = [];
    if (process.env.DISABLE_SFX !== '1') {
        const requests = shots.map((s) => ({
            storyboardNumber: s.sb.storyboardNumber,
            shotStartSec: s.startSec,
            shotDurationSec: s.durationSec,
            description: String(s.sb.soundEffect ?? ''),
        }));
        sfxCues = planSfxCueTimings(requests, (description, exclude, storyboardNumber) => {
            const candidates = findSfxFiles(description, 3, exclude);
            for (const candidate of candidates) {
                if (storyboardNumber != null
                    && sceneByStoryboard.get(storyboardNumber)
                    && /loop_ambient/i.test(candidate))
                    continue;
                return candidate;
            }
            return null;
        }).filter((cue) => fs.existsSync(cue.path));
    }
    if (bgmCues.length === 0 && sfxCues.length === 0 && ambienceCues.length === 0)
        return null;
    // 完整渲染时把计划写回集记录，供前端展示与调试（pilot 不写，避免覆盖全集计划）
    if (budgetFrames === null) {
        try {
            const sfxSummary = sfxCues.map((c) => ({
                startSec: c.startSec,
                durationSec: c.durationSec,
                storyboardNumber: c.storyboardNumber,
                description: c.description,
                path: path.basename(c.path),
            }));
            const ambienceSummary = ambienceCues.map((c) => ({
                startSec: c.startSec,
                durationSec: c.durationSec,
                scene: c.scene,
                volume: c.volume,
                path: path.basename(c.path),
            }));
            db.update(schema.episodes)
                .set({
                bgmPlanJson: JSON.stringify({
                    source: 'grid-audio-v2',
                    tracks,
                    cues: rawCues,
                    sfx: sfxSummary,
                    ambience: ambienceSummary,
                }),
            })
                .where(eq(schema.episodes.id, episodeId))
                .run();
        }
        catch {
            /* 计划持久化失败不影响混音 */
        }
    }
    return { durationSec, bgmCues, sfxCues, ambienceCues, tracks };
}
// ---------------------------------------------------------------------------
// 执行：单次 ffmpeg 混音
// ---------------------------------------------------------------------------
export async function mixGridEpisodeAudio(inputVideo, outputVideo, plan) {
    const args = buildAudioMixArgs(inputVideo, outputVideo, plan);
    await new Promise((resolve, reject) => {
        const child = spawn(FFMPEG_BIN, args, { env: process.env });
        let tail = '';
        child.stderr.on('data', (d) => {
            tail = (tail + String(d)).slice(-2000);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`grid audio mix exit ${code}: ${tail.slice(-500)}`));
        });
    });
}
