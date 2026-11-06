interface TimelineUnit { normStart: number; normEnd: number; startMs: number; endMs: number; rawText: string }
export interface PreTtsTitle {
    text?: unknown;
    text_begin?: unknown;
    time_begin?: unknown;
    time_end?: unknown;
}
export interface BreakFragment {
    text: string;
    startMs: number;
    endMs: number;
    durationSec: number;
}
export interface DeterministicBreakPlan {
    fragments: BreakFragment[];
    /** 所有切片归一化后的总字符数（必须与 scriptChars 相等） */
    totalChars: number;
    /** script 归一化后的总字符数 */
    scriptChars: number;
    durationMs: number;
    maxDurationSec: number;
}
export interface DeterministicBreakResult {
    episodeId: number;
    storyboardCount: number;
    storyboardIds: number[];
    totalChars: number;
    scriptChars: number;
    coverageVerified: boolean;
    maxDurationSec: number;
    durationMs: number;
    cancelledBreakerTaskIds: number[];
}
/**
 * 确定性分镜拆分器（direct_script / verbatim 专用）
 *
 * 替代 storyboard_breaker LLM：从 tts.pre_generate 产出的句级 titles 时间轴
 * 机械切分 script 原文为 storyboards。
 *
 * 不变量（写入前全部自检，任一不过则抛错且不写库）：
 * 1. script 原文是唯一真源：每条 narration 是 script 的精确连续切片；
 * 2. 切片按顺序无重叠、无缺口地平铺整个 script（归一化后总字符恒等、逐字比对）；
 *    复用 Remotion 项目创建时的同一校验 mapOrderedNarrationFragments；
 * 3. 每块时长（titles time_end - time_begin）<= maxDurationSec（默认 8s），
 *    超出按标点边界再切，标点不够按字符比例硬切；
 * 4. 不写 storyboard_characters / scenes 关联（schema 均可空，不依赖 extractor）。
 *
 * ep790 的教训：restoreOriginalTextNarrations 对非连续片段静默丢字。
 * 本实现不做任何"尽力匹配"：titles 归一化拼接 != script 归一化即整体报错。
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { now } from '../utils/response.js';
import { getVerbatimSource, mapOrderedNarrationFragments } from './narration-generation.js';
import { listActiveTasksForEpisodes, requestCancel } from './tasks/store.js';
export const DETERMINISTIC_BREAK_MAX_DURATION_SEC = 8;
export class DeterministicBreakError extends Error {
    code: string;
    httpStatus: number;
    direction: string;
    details: Record<string, unknown>;
    constructor(code: string, httpStatus: number, message: string, direction: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'DeterministicBreakError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.direction = direction;
        this.details = details;
    }
}
/** 与 narration-generation 的 normalizeForFragmentMatch 语义保持一致：忽略空白/标点/符号 */
function normalizeForMatch(text: string) {
    return text.replace(/[\s\p{P}\p{S}]/gu, '');
}
function normalizeWithOriginalIndex(text: string) {
    let normalized = '';
    const indexes = [];
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (!normalizeForMatch(char))
            continue;
        normalized += char;
        indexes.push(i);
    }
    return { normalized, indexes };
}
function buildTimelineUnits(titles: PreTtsTitle[]) {
    const sorted = titles.slice();
    if (sorted.length > 0 && sorted.every((t) => Number.isFinite(Number(t?.text_begin)))) {
        sorted.sort((a, b) => Number(a.text_begin) - Number(b.text_begin));
    }
    const units = [];
    let stream = '';
    for (const title of sorted) {
        const rawText = String(title?.text ?? '');
        const normText = normalizeForMatch(rawText);
        if (!normText)
            continue;
        const startMs = Number(title?.time_begin);
        const endMs = Number(title?.time_end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            throw new DeterministicBreakError('invalid_title_timing', 400, `pre-TTS title has invalid timing: ${JSON.stringify(title).slice(0, 120)}`, '重新运行 tts.pre_generate 生成完整 titles 时间轴');
        }
        units.push({ normStart: stream.length, normEnd: stream.length + normText.length, startMs, endMs, rawText });
        stream += normText;
    }
    if (!units.length) {
        throw new DeterministicBreakError('missing_pre_tts', 400, 'pre-TTS titles contain no speakable text', '确认 episode 有 script 内容后重新运行 tts.pre_generate');
    }
    return { units, normStream: stream };
}
/**
 * 硬对齐：titles 归一化拼接必须逐字等于 script 归一化。
 * 相等后，titles 流中的归一化偏移就是 script 归一化流中的偏移，
 * 再经 indexes 映射回 script 原文下标。任何分叉都拒绝继续（不静默丢字）。
 */
function alignToScript(normStream: string, script: string) {
    const indexed = normalizeWithOriginalIndex(script);
    if (!indexed.normalized) {
        throw new DeterministicBreakError('no_script', 400, 'episode script is empty after normalization', '先通过 import-script 写入 script_content');
    }
    if (normStream !== indexed.normalized) {
        let diverge = 0;
        const limit = Math.min(normStream.length, indexed.normalized.length);
        while (diverge < limit && normStream[diverge] === indexed.normalized[diverge])
            diverge++;
        throw new DeterministicBreakError('tiling_mismatch', 400, `pre-TTS titles do not exactly tile the script: diverge at normalized char ${diverge} ` +
            `(titles ${normStream.length} chars, script ${indexed.normalized.length} chars); ` +
            `titles="${normStream.slice(diverge, diverge + 20)}" script="${indexed.normalized.slice(diverge, diverge + 20)}"`, 'script 与 TTS 输入不一致（常见原因：导入后改过了稿件，或稿件含 markdown 装饰被 sanitize 剥除）；' +
            '恢复一致后重新运行 tts.pre_generate，再做确定性拆分');
    }
    return indexed;
}
const CLAUSE_BREAK = /(?<=[。！？!?，,、；;：:—…～~])/u;
/**
 * 单条 title 超过 maxMs 时切成若干片：每片插值时长必须 ≤ maxMs。
 * 算法：从 pieceStart 出发，取时长预算内最晚的标点切点；预算内没有标点就在
 * 预算边界按字符硬切。预算留 50ms 余量吸收毫秒取整，保证 ceil 后仍 ≤ maxDurationSec。
 */
function splitOversizedUnit(unit: TimelineUnit, maxMs: number): TimelineUnit[] {
    const spanMs = unit.endMs - unit.startMs;
    if (spanMs <= maxMs)
        return [unit];
    const normLen = unit.normEnd - unit.normStart;
    if (normLen < 2)
        return [unit];
    const cutPoints = [];
    let acc = 0;
    for (const clause of unit.rawText.split(CLAUSE_BREAK)) {
        if (!clause)
            continue;
        acc += normalizeForMatch(clause).length;
        if (acc > 0 && acc < normLen)
            cutPoints.push(acc);
    }
    const budgetMs = maxMs - 50;
    const pieces = [];
    let pieceStart = 0;
    while (pieceStart < normLen) {
        const remainingMs = (spanMs * (normLen - pieceStart)) / normLen;
        if (remainingMs <= budgetMs) {
            pieces.push([pieceStart, normLen]);
            break;
        }
        const maxChars = Math.max(1, Math.floor((budgetMs * normLen) / spanMs));
        const budget = pieceStart + maxChars;
        const candidates = cutPoints.filter((p) => p > pieceStart && p <= budget);
        const cut = candidates.length ? candidates[candidates.length - 1] : budget;
        pieces.push([pieceStart, cut]);
        pieceStart = cut;
    }
    return pieces.map(([s, e]) => ({
        normStart: unit.normStart + s,
        normEnd: unit.normStart + e,
        startMs: Math.round(unit.startMs + spanMs * (s / normLen)),
        endMs: Math.round(unit.startMs + spanMs * (e / normLen)),
        rawText: unit.rawText,
    }));
}
/** 贪心分组：在不超过 maxMs 的前提下合并连续 unit（组间空隙时长计入上一组） */
function groupUnits(units: TimelineUnit[], maxMs: number): TimelineUnit[][] {
    const groups = [];
    let current: TimelineUnit[] = [];
    for (const unit of units) {
        if (current.length && unit.endMs - current[0].startMs > maxMs) {
            groups.push(current);
            current = [unit];
        }
        else {
            current.push(unit);
        }
    }
    if (current.length)
        groups.push(current);
    return groups;
}
function fragmentFromGroup(group: TimelineUnit[], indexed: ReturnType<typeof normalizeWithOriginalIndex>, script: string): BreakFragment {
    const first = group[0];
    const last = group[group.length - 1];
    const start = indexed.indexes[first.normStart];
    const lastKept = indexed.indexes[last.normEnd - 1];
    if (start == null || lastKept == null) {
        throw new DeterministicBreakError('self_check_failed', 500, 'internal error: fragment range is invalid', '确定性拆分器自检失败，未写入任何分镜；请保留现场并检查 titles/script 数据');
    }
    let end = lastKept + 1;
    while (end < script.length && !normalizeForMatch(script[end]))
        end++;
    const spanMs = last.endMs - first.startMs;
    return {
        text: script.slice(start, end).trim(),
        startMs: Math.round(first.startMs),
        endMs: Math.round(last.endMs),
        durationSec: Math.max(1, Math.ceil(spanMs / 1000)),
    };
}
/**
 * 纯函数：从 script + pre-TTS titles 构建确定性拆分计划。
 * 不写库；任何不变量被破坏都抛 DeterministicBreakError。
 */
export function buildDeterministicBreakPlan(script: string, titles: PreTtsTitle[], maxDurationSec: number = DETERMINISTIC_BREAK_MAX_DURATION_SEC): DeterministicBreakPlan {
    if (!script.trim()) {
        throw new DeterministicBreakError('no_script', 400, 'script is empty', '先通过 import-script 写入 script_content');
    }
    const maxMs = maxDurationSec * 1000;
    const { units: titleUnits, normStream } = buildTimelineUnits(titles);
    const indexed = alignToScript(normStream, script);
    const units = [];
    for (const unit of titleUnits)
        units.push(...splitOversizedUnit(unit, maxMs));
    const groups = groupUnits(units, maxMs);
    const fragments = groups.map((group) => fragmentFromGroup(group, indexed, script));
    // 自检 1：时长上限
    const maxSec = Math.max(...fragments.map((f) => f.durationSec));
    if (maxSec > maxDurationSec) {
        throw new DeterministicBreakError('self_check_failed', 500, `fragment duration ${maxSec}s exceeds ${maxDurationSec}s`, '确定性拆分器自检失败，未写入任何分镜');
    }
    // 自检 2：精确覆盖——复用 Remotion 项目创建时的同一校验
    const texts = fragments.map((f) => f.text);
    let ranges;
    try {
        ranges = mapOrderedNarrationFragments(script, texts);
    }
    catch (error) {
        throw new DeterministicBreakError('self_check_failed', 500, `coverage self-check failed: ${error instanceof Error ? error.message : String(error)}`, '确定性拆分器自检失败，未写入任何分镜');
    }
    // 自检 3：逐字比对——每条切片必须与 script 原文切片完全一致
    for (let i = 0; i < ranges.length; i++) {
        if (script.slice(ranges[i].start, ranges[i].end).trim() !== texts[i]) {
            throw new DeterministicBreakError('self_check_failed', 500, `fragment ${i + 1} does not match the exact script slice`, '确定性拆分器自检失败，未写入任何分镜');
        }
    }
    // 自检 4：归一化总字符恒等（不允许静默丢字）
    const totalChars = texts.reduce((sum, t) => sum + normalizeForMatch(t).length, 0);
    const scriptChars = normalizeForMatch(script).length;
    if (totalChars !== scriptChars) {
        throw new DeterministicBreakError('self_check_failed', 500, `total fragment chars ${totalChars} != script chars ${scriptChars}`, '确定性拆分器自检失败，未写入任何分镜');
    }
    const lastUnit = units[units.length - 1];
    return { fragments, totalChars, scriptChars, durationMs: Math.round(lastUnit.endMs), maxDurationSec: maxSec };
}
/** 取消本集仍在排队的 storyboard_breaker LLM 任务，避免其随后覆盖确定性分镜 */
export function cancelActiveLlmBreakers(episodeId: number): number[] {
    const cancelled = [];
    for (const task of listActiveTasksForEpisodes([episodeId])) {
        if (task.type !== 'agent.run')
            continue;
        if (!(task.idempotencyKey || '').startsWith('agent.run:storyboard_breaker:'))
            continue;
        const result = requestCancel(task.id, {
            reason: 'Replaced by deterministic storyboard break',
            actor: 'deterministic-breaker',
        });
        if (result.outcome === 'requested' || result.outcome === 'already_requested')
            cancelled.push(task.id);
    }
    return cancelled;
}
function compactFragmentTitle(text: string, fallback: string) {
    const compact = text
        .replace(/^[0-9]{4}年[0-9]{0,2}月?[，,]?/u, '')
        .replace(/^[\s，,、；;。！？.!?：:—]+|[\s，,、；;。！？.!?：:—]+$/gu, '')
        .trim();
    return compact ? compact.slice(0, 14) : fallback;
}
/**
 * 事务写入 storyboards。已有分镜时拒绝（除非 force=true，force 时先清理旧行）。
 * storyboards.sceneId 可空、storyboard_characters 关联可空，本路径不依赖 extractor。
 */
export function breakEpisodeDeterministically(episodeId: number, options: {
    force?: boolean;
} = {}): DeterministicBreakResult {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep) {
        throw new DeterministicBreakError('not_found', 404, `Episode ${episodeId} not found`, '确认 episode id');
    }
    if (ep.workflowType !== 'direct_script') {
        throw new DeterministicBreakError('not_direct_script', 400, `Episode ${episodeId} workflow_type is ${ep.workflowType}, not direct_script`, '确定性拆分只服务 direct_script 精稿直出剧集；请通过 import-script 导入');
    }
    const script = getVerbatimSource(ep);
    if (!script) {
        throw new DeterministicBreakError('no_script', 400, `Episode ${episodeId} has no script content`, '先通过 import-script 写入 script_content');
    }
    let titles = [];
    try {
        titles = JSON.parse(ep.preTtsTitlesJson || '[]');
    }
    catch {
        titles = [];
    }
    if (!Array.isArray(titles) || !titles.length) {
        throw new DeterministicBreakError('missing_pre_tts', 400, `Episode ${episodeId} has no pre-TTS titles`, '等待 tts.pre_generate 产出 pre_tts_titles_json 后再调用本端点');
    }
    // 先构建计划：titles/script 不平铺时直接报错，不做任何写操作
    const plan = buildDeterministicBreakPlan(script, titles);
    const existing = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(asc(schema.storyboards.storyboardNumber))
        .all();
    if (existing.length && !options.force) {
        const matchesDeterministic = existing.length === plan.fragments.length
            && existing.every((sb, i) => (sb.narration || '').trim() === plan.fragments[i].text);
        throw new DeterministicBreakError('storyboards_exist', 409, `Episode ${episodeId} already has ${existing.length} storyboards`, matchesDeterministic
            ? '现有分镜与确定性拆分结果一致，无需处理（幂等跳过）'
            : '现有分镜与确定性拆分结果不一致；确认要替换时加 ?force=true 重试', { existingStoryboards: existing.length, existingMatchesDeterministic: matchesDeterministic });
    }
    // 防御：取消仍在排队的 LLM breaker，防止其随后删掉确定性分镜
    const cancelledBreakerTaskIds = cancelActiveLlmBreakers(episodeId);
    const ts = now();
    const storyboardIds = db.transaction((tx) => {
        if (existing.length) {
            const oldIds = existing.map((row) => row.id);
            tx.delete(schema.storyboardCharacters)
                .where(inArray(schema.storyboardCharacters.storyboardId, oldIds))
                .run();
            tx.delete(schema.storyboards)
                .where(eq(schema.storyboards.episodeId, episodeId))
                .run();
        }
        const ids = [];
        for (let i = 0; i < plan.fragments.length; i++) {
            const fragment = plan.fragments[i];
            const res = tx.insert(schema.storyboards).values({
                episodeId,
                storyboardNumber: i + 1,
                title: compactFragmentTitle(fragment.text, `镜头${i + 1}`),
                narration: fragment.text,
                description: fragment.text,
                action: fragment.text,
                duration: fragment.durationSec,
                status: 'pending',
                createdAt: ts,
                updatedAt: ts,
            }).run();
            ids.push(Number(res.lastInsertRowid));
        }
        return ids;
    });
    // 写后回读终检：以库内实际文本再过一遍精确覆盖校验
    const written = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(asc(schema.storyboards.storyboardNumber))
        .all();
    try {
        mapOrderedNarrationFragments(script, written.map((sb) => String(sb.narration || sb.description || '')));
    }
    catch (error) {
        throw new DeterministicBreakError('self_check_failed', 500, `post-write coverage check failed: ${error instanceof Error ? error.message : String(error)}`, '写入后校验失败；请用 ?force=true 重跑或检查数据');
    }
    return {
        episodeId,
        storyboardCount: storyboardIds.length,
        storyboardIds,
        totalChars: plan.totalChars,
        scriptChars: plan.scriptChars,
        coverageVerified: true,
        maxDurationSec: plan.maxDurationSec,
        durationMs: plan.durationMs,
        cancelledBreakerTaskIds,
    };
}

