export interface SciencePopShot {
    storyboardId: number;
    localPath: string;
    videoUrl: string;
    duration: number;
    startSeconds: number;
    endSeconds: number;
}
export interface SegmentEpisodeOptions {
    sceneThreshold?: number;
    targetShotSeconds?: number;
    minShotSeconds?: number;
    maxShotSeconds?: number;
}
/**
 * 科普视频（动物/植物）源视频分镜服务
 *
 * 基于 FFmpeg 场景检测（scene detection）把用户上传的源视频切成多个镜头，
 * 每个镜头生成一个 storyboard 行，video_url 指向切分后的本地片段。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuid } from 'uuid';
import { eq, asc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { now } from '../utils/response.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(__dirname, '../../../data');
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(DATA_ROOT, 'static');
const DEFAULT_SCENE_THRESHOLD = 0.3;
const DEFAULT_TARGET_SHOT_SECONDS = 5;
const MIN_SHOT_SECONDS = 2;
const MAX_SHOT_SECONDS = 10;
function toAbsPath(relativePath: string) {
    if (path.isAbsolute(relativePath))
        return relativePath;
    if (relativePath.startsWith('static/'))
        return path.join(DATA_ROOT, relativePath);
    return path.join(STORAGE_ROOT, relativePath);
}
function toVideoUrl(absPath: string) {
    const rel = path.relative(DATA_ROOT, absPath);
    return rel.replace(/\\/g, '/');
}
export function getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }
            const stream = metadata.streams.find(s => s.codec_type === 'video');
            const duration = stream?.duration ? Number(stream.duration) : (metadata.format.duration || 0);
            resolve(duration);
        });
    });
}
/**
 * 使用 FFmpeg scene filter 检测场景切换时间点（秒）。
 * 输出形如 pts_time:1.234 的帧信息，解析后得到切换时间戳。
 */
export function detectSceneChanges(videoPath: string, threshold: number = DEFAULT_SCENE_THRESHOLD): Promise<number[]> {
    return new Promise((resolve, reject) => {
        const timestamps: number[] = [];
        const cmd = ffmpeg(videoPath)
            .videoFilter(`select=gt(scene\\,${threshold}),showinfo`)
            .format('null')
            .output('-');
        cmd.on('stderr', (line) => {
            // showinfo 输出到 stderr
            const match = line.match(/pts_time:\s*([0-9.]+)/);
            if (match) {
                const t = Number(match[1]);
                if (Number.isFinite(t) && t > 0) {
                    timestamps.push(t);
                }
            }
        });
        cmd.on('error', (err) => reject(err));
        cmd.on('end', () => {
            // 去重并排序
            const sorted = Array.from(new Set(timestamps)).sort((a, b) => a - b);
            resolve(sorted);
        });
        cmd.run();
    });
}
/**
 * 将视频按给定时间点切分成多个片段，使用 segment muxer + copy 编码。
 */
export async function splitVideoBySegments(inputPath: string, segmentTimes: number[], outputDir: string): Promise<{
    path: string;
    start: number;
    end: number;
    duration: number;
}[]> {
    fs.mkdirSync(outputDir, { recursive: true });
    const totalDuration = await getVideoDuration(inputPath);
    const cuts = [0, ...segmentTimes.filter(t => t > 0 && t < totalDuration), totalDuration];
    if (cuts.length < 3) {
        throw new Error('Need at least one cut point to split video');
    }
    const timesStr = segmentTimes.filter(t => t > 0 && t < totalDuration).join(',');
    const pattern = path.join(outputDir, 'shot_%03d.mp4');
    await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
            '-c', 'copy',
            '-map', '0',
            '-segment_times', timesStr,
            '-f', 'segment',
            '-reset_timestamps', '1',
        ])
            .output(pattern)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
    const clips = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const clipPath = path.join(outputDir, `shot_${String(i).padStart(3, '0')}.mp4`);
        if (!fs.existsSync(clipPath))
            continue;
        const duration = await getVideoDuration(clipPath);
        if (duration <= 0)
            continue;
        clips.push({
            path: clipPath,
            start: cuts[i],
            end: cuts[i + 1],
            duration,
        });
    }
    return clips;
}
/**
 * 当场景检测失败或镜头过少时的兜底：按固定时长等分视频。
 */
export async function splitVideoByEqualDuration(inputPath: string, outputDir: string, targetShotSeconds: number = DEFAULT_TARGET_SHOT_SECONDS): Promise<{
    path: string;
    start: number;
    end: number;
    duration: number;
}[]> {
    fs.mkdirSync(outputDir, { recursive: true });
    const totalDuration = await getVideoDuration(inputPath);
    if (totalDuration <= 0)
        throw new Error('Source video duration is zero or unavailable');
    const shotCount = Math.max(1, Math.round(totalDuration / targetShotSeconds));
    const shotDuration = totalDuration / shotCount;
    const clips = [];
    for (let i = 0; i < shotCount; i++) {
        const start = i * shotDuration;
        const end = i === shotCount - 1 ? totalDuration : (i + 1) * shotDuration;
        const outputPath = path.join(outputDir, `shot_${String(i).padStart(3, '0')}.mp4`);
        await new Promise<void>((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                '-ss', String(start),
                '-to', String(end),
                '-c', 'copy',
                '-map', '0',
                '-avoid_negative_ts', 'make_zero',
            ])
                .output(outputPath)
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .run();
        });
        const duration = await getVideoDuration(outputPath);
        clips.push({ path: outputPath, start, end, duration });
    }
    return clips;
}
/**
 * 为一集科普视频执行源视频分镜。
 * 返回生成的 storyboard 列表。
 */
export async function segmentEpisodeSourceVideo(episodeId: number, options: SegmentEpisodeOptions = {}): Promise<SciencePopShot[]> {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        throw new Error(`Episode ${episodeId} not found`);
    if (!ep.sourceVideoUrl)
        throw new Error(`Episode ${episodeId} has no source video`);
    const sourcePath = toAbsPath(ep.sourceVideoUrl);
    if (!fs.existsSync(sourcePath))
        throw new Error(`Source video not found: ${sourcePath}`);
    const threshold = options.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
    const targetShotSeconds = options.targetShotSeconds ?? DEFAULT_TARGET_SHOT_SECONDS;
    const minShotSeconds = options.minShotSeconds ?? MIN_SHOT_SECONDS;
    const maxShotSeconds = options.maxShotSeconds ?? MAX_SHOT_SECONDS;
    // 1. 场景检测
    let sceneChanges: number[] = [];
    try {
        sceneChanges = await detectSceneChanges(sourcePath, threshold);
    }
    catch (err) {
        console.warn('[SciencePopSegmentation] scene detection failed, falling back:', err);
    }
    // 2. 合并过近切点，避免镜头过短
    const totalDuration = await getVideoDuration(sourcePath);
    const mergedCuts = [];
    for (const t of sceneChanges) {
        if (mergedCuts.length === 0 || t - mergedCuts[mergedCuts.length - 1] >= minShotSeconds) {
            mergedCuts.push(t);
        }
    }
    // 如果场景切换太少，使用等时长兜底
    const outputDir = path.join(STORAGE_ROOT, 'science-pop', String(episodeId), uuid());
    let clips = [];
    if (mergedCuts.length >= 1) {
        clips = await splitVideoBySegments(sourcePath, mergedCuts, outputDir);
    }
    else {
        clips = await splitVideoByEqualDuration(sourcePath, outputDir, targetShotSeconds);
    }
    // 3. 若某镜头超过 maxShotSeconds，再按 maxShotSeconds 切短（简单兜底）
    const finalClips = [];
    for (const clip of clips) {
        if (clip.duration <= maxShotSeconds) {
            finalClips.push(clip);
            continue;
        }
        const subCount = Math.ceil(clip.duration / maxShotSeconds);
        const subDuration = clip.duration / subCount;
        for (let i = 0; i < subCount; i++) {
            const start = clip.start + i * subDuration;
            const end = i === subCount - 1 ? clip.end : clip.start + (i + 1) * subDuration;
            const outputPath = path.join(outputDir, `shot_sub_${String(finalClips.length).padStart(3, '0')}.mp4`);
            await new Promise<void>((resolve, reject) => {
                ffmpeg(clip.path)
                    .outputOptions(['-ss', String(0), '-t', String(end - start), '-c', 'copy', '-map', '0'])
                    .output(outputPath)
                    .on('end', () => resolve())
                    .on('error', (err) => reject(err))
                    .run();
            });
            const duration = await getVideoDuration(outputPath);
            finalClips.push({ path: outputPath, start, end, duration });
        }
    }
    if (finalClips.length === 0) {
        throw new Error('No video clips were produced from source video');
    }
    // 4. 删除旧的本集 storyboards（如果有），创建新的 clip storyboards
    const existing = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(asc(schema.storyboards.storyboardNumber))
        .all();
    if (existing.length > 0) {
        db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run();
    }
    const shots = [];
    const createdAt = now();
    for (let i = 0; i < finalClips.length; i++) {
        const clip = finalClips[i];
        const videoUrl = toVideoUrl(clip.path);
        const result = db.insert(schema.storyboards).values({
            episodeId,
            storyboardNumber: i + 1,
            title: `镜头 ${i + 1}`,
            narration: '',
            description: `源视频片段 ${i + 1}: ${clip.start.toFixed(2)}s - ${clip.end.toFixed(2)}s`,
            duration: Math.max(1, Math.round(clip.duration)),
            videoUrl,
            status: 'pending',
            createdAt,
            updatedAt: createdAt,
        }).run();
        shots.push({
            storyboardId: Number(result.lastInsertRowid),
            localPath: clip.path,
            videoUrl,
            duration: clip.duration,
            startSeconds: clip.start,
            endSeconds: clip.end,
        });
    }
    // 5. 更新 episode 总时长
    const totalShotDuration = shots.reduce((sum, s) => sum + s.duration, 0);
    db.update(schema.episodes)
        .set({ duration: Math.round(totalShotDuration), updatedAt: now() })
        .where(eq(schema.episodes.id, episodeId))
        .run();
    return shots;
}

