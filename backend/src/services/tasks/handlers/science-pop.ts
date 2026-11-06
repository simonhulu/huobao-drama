import type { TaskHandler } from '../types.js';
interface SegmentPayload {
    episode_id?: number;
    episodeId?: number;
    scene_threshold?: number;
    target_shot_seconds?: number;
}
interface ComposePayload {
    episode_id?: number;
    episodeId?: number;
}
/**
 * Science-Pop（动物/植物科普视频）任务处理器
 *
 * - science_pop.segment: 把用户上传的源视频按场景检测切成多个镜头
 * - science_pop.compose: 把所有镜头拼接并循环，混合整集 TTS 旁白，输出成片
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuid } from 'uuid';
import { eq, asc } from 'drizzle-orm';
import { db, schema } from '../../../db/index.js';
import { now } from '../../../utils/response.js';
import { registerTaskHandler } from '../registry.js';
import { segmentEpisodeSourceVideo, getVideoDuration } from '../../science-pop-segmentation.js';
import { getAudioDuration } from '../../ffmpeg-compose.js';
import { getVideoEncoderOptions } from '../../composition/video-encoder.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(__dirname, '../../../../data');
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(DATA_ROOT, 'static');
function toAbsPath(relativePath: string): string {
    if (path.isAbsolute(relativePath))
        return relativePath;
    if (relativePath.startsWith('static/'))
        return path.join(DATA_ROOT, relativePath);
    return path.join(STORAGE_ROOT, relativePath);
}
function toVideoUrl(absPath: string): string {
    const rel = path.relative(DATA_ROOT, absPath);
    return rel.replace(/\\/g, '/');
}
async function concatVideos(videoPaths: string[], outputPath: string): Promise<number> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const listPath = path.join(path.dirname(outputPath), `${uuid()}_concat_list.txt`);
    const listContent = videoPaths.map(p => `file '${p.replace(/'/g, "'\\'")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');
    try {
        await new Promise<void>((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
                .output(outputPath)
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .run();
        });
    }
    catch (copyErr) {
        // copy 失败时回退到 filter_complex 重编码
        console.warn('[SciencePopCompose] concat copy failed, fallback to filter_complex:', copyErr);
        await concatVideosFilterComplex(videoPaths, outputPath);
    }
    finally {
        try {
            fs.unlinkSync(listPath);
        }
        catch { }
    }
    return getVideoDuration(outputPath);
}
async function concatVideosFilterComplex(videoPaths: string[], outputPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg();
        for (const p of videoPaths) {
            cmd = cmd.input(p);
        }
        const filters: ffmpeg.FilterSpecification[] = [];
        videoPaths.forEach((_, i) => {
            filters.push({ filter: 'format', options: 'yuv420p', inputs: `${i}:v`, outputs: `v${i}` }, { filter: 'aformat', options: 'sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', inputs: `${i}:a`, outputs: `a${i}` });
        });
        const concatInputs = videoPaths.flatMap((_, i) => [`v${i}`, `a${i}`]);
        filters.push({
            filter: 'concat',
            options: `n=${videoPaths.length}:v=1:a=1`,
            inputs: concatInputs,
            outputs: ['outv', 'outa'],
        });
        cmd
            .complexFilter(filters)
            .outputOptions([
            '-map', '[outv]',
            '-map', '[outa]',
            ...getVideoEncoderOptions({ width: 1280, height: 720 }),
            '-ar', '48000',
            '-ac', '2',
            '-movflags', '+faststart',
        ])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}
/**
 * 把视频循环/截断到目标时长，并与旁白音频混合。
 * 视频使用 stream_loop 循环，-shortest 以音频长度为准。
 */
async function mixVideoToAudioDuration(videoPath: string, audioPath: string, outputPath: string, dimensions: { width: number; height: number }): Promise<number> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
            .inputOptions(['-stream_loop', '-1'])
            .input(audioPath)
            .outputOptions([
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '128k',
            '-shortest',
            '-movflags', '+faststart',
            '-r', '30',
        ])
            .videoFilter(`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`)
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
    return getVideoDuration(outputPath);
}
export function createSciencePopSegmentHandler(): TaskHandler<SegmentPayload> {
    return {
        resumable: true,
        maxAttempts: 2,
        async run(ctx) {
            const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId);
            if (!episodeId)
                throw new Error('episode_id is required');
            ctx.progress('Reading episode source video', 0, 1);
            const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
            if (!ep)
                throw new Error(`Episode ${episodeId} not found`);
            if (!ep.sourceVideoUrl)
                throw new Error(`Episode ${episodeId} has no source video. Please upload first.`);
            ctx.progress('Segmenting source video into shots', 0.2, 1);
            const shots = await segmentEpisodeSourceVideo(episodeId, {
                sceneThreshold: ctx.payload.scene_threshold,
                targetShotSeconds: ctx.payload.target_shot_seconds,
            });
            ctx.event('science_pop.segment.completed', {
                episode_id: episodeId,
                shot_count: shots.length,
                shots: shots.map(s => ({
                    storyboard_id: s.storyboardId,
                    duration: s.duration,
                    start_seconds: s.startSeconds,
                    end_seconds: s.endSeconds,
                })),
            });
            ctx.progress('Segmentation complete', 1, 1);
            return {
                episode_id: episodeId,
                shot_count: shots.length,
                shots,
            };
        },
    };
}
export function createSciencePopComposeHandler(): TaskHandler<ComposePayload> {
    return {
        resumable: true,
        maxAttempts: 1,
        async run(ctx) {
            const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId);
            if (!episodeId)
                throw new Error('episode_id is required');
            ctx.progress('Loading episode and shots', 0, 1);
            const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
            if (!ep)
                throw new Error(`Episode ${episodeId} not found`);
            if (!ep.preTtsAudioUrl) {
                throw new Error(`Episode ${episodeId} has no narration TTS audio. Please generate TTS first.`);
            }
            const storyboards = db.select().from(schema.storyboards)
                .where(eq(schema.storyboards.episodeId, episodeId))
                .orderBy(asc(schema.storyboards.storyboardNumber))
                .all();
            const clips = storyboards.filter(sb => sb.videoUrl).map(sb => ({
                storyboardId: sb.id,
                videoUrl: sb.videoUrl,
                videoPath: toAbsPath(sb.videoUrl!),
            }));
            if (clips.length === 0) {
                throw new Error(`Episode ${episodeId} has no segmented video clips. Please run segmentation first.`);
            }
            for (const clip of clips) {
                if (!fs.existsSync(clip.videoPath)) {
                    throw new Error(`Clip file missing: ${clip.videoPath}`);
                }
            }
            const workDir = path.join(STORAGE_ROOT, 'science-pop', String(episodeId), uuid());
            fs.mkdirSync(workDir, { recursive: true });
            try {
                ctx.progress('Concatenating video clips', 0.2, 1);
                const concatPath = path.join(workDir, 'concat.mp4');
                await concatVideos(clips.map(c => c.videoPath), concatPath);
                ctx.progress('Mixing narration audio', 0.5, 1);
                const audioPath = toAbsPath(ep.preTtsAudioUrl);
                const audioDuration = await getAudioDuration(audioPath);
                const concatDuration = await getVideoDuration(concatPath);
                ctx.event('science_pop.compose.durations', {
                    episode_id: episodeId,
                    audio_duration: audioDuration,
                    concat_duration: concatDuration,
                });
                const outputDir = path.join(STORAGE_ROOT, 'science-pop', String(episodeId));
                fs.mkdirSync(outputDir, { recursive: true });
                const outputFilename = `${uuid()}_final.mp4`;
                const outputPath = path.join(outputDir, outputFilename);
                const finalDuration = await mixVideoToAudioDuration(concatPath, audioPath, outputPath, { width: 1280, height: 720 });
                const videoUrl = toVideoUrl(outputPath);
                db.update(schema.episodes)
                    .set({ videoUrl, updatedAt: now() })
                    .where(eq(schema.episodes.id, episodeId))
                    .run();
                ctx.event('science_pop.compose.completed', {
                    episode_id: episodeId,
                    video_url: videoUrl,
                    duration: finalDuration,
                });
                ctx.progress('Composition complete', 1, 1);
                return {
                    episode_id: episodeId,
                    video_url: videoUrl,
                    duration: finalDuration,
                };
            }
            finally {
                // 清理中间 concat 文件，保留最终成片和源片段
                try {
                    fs.rmSync(workDir, { recursive: true, force: true });
                }
                catch { }
            }
        },
    };
}
export function registerSciencePopHandlers() {
    registerTaskHandler('science_pop.segment', createSciencePopSegmentHandler());
    registerTaskHandler('science_pop.compose', createSciencePopComposeHandler());
}

