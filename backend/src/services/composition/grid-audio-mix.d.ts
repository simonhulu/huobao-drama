import { type EmotionBucket } from '../audio-profile.js';
import { type EpisodeBgmTrack, type EpisodeBgmCue } from './bgm-cue-planner.js';
export interface GridAudioBgmCue {
    /** 实际起播点（含幕间交叠提前量），秒 */
    startSec: number;
    /** 段长（含交叠），秒 */
    durationSec: number;
    /** 绝对路径 */
    path: string;
    emotionBucket: EmotionBucket;
    fadeInSec: number;
    fadeOutSec: number;
}
export interface GridAudioSfxCue {
    startSec: number;
    durationSec: number;
    /** 绝对路径 */
    path: string;
    storyboardNumber: number;
    description: string;
}
export interface GridAudioAmbienceCue {
    startSec: number;
    durationSec: number;
    /** 绝对路径 */
    path: string;
    scene: AmbienceScene;
    volume: number;
    fadeInSec: number;
    fadeOutSec: number;
}
export interface GridAudioPlan {
    durationSec: number;
    bgmCues: GridAudioBgmCue[];
    sfxCues: GridAudioSfxCue[];
    ambienceCues: GridAudioAmbienceCue[];
    tracks: EpisodeBgmTrack[];
}
export interface GridAudioPlanOptions {
    maxDurationSec?: number;
}
/**
 * 把 cue 计划的"逻辑窗口"换算成"实际播放段"：
 * 非首段起点提前一个交叠量、淡入=交叠量，与上一段的淡出叠加形成 crossfade。
 */
export declare function planBgmCueTimings(cues: EpisodeBgmCue[], totalSec: number): GridAudioBgmCue[];
export interface SfxCueRequest {
    storyboardNumber: number;
    shotStartSec: number;
    shotDurationSec: number;
    description: string;
}
export declare function planSfxCueTimings(requests: SfxCueRequest[], resolve: (description: string, exclude: Set<string>, storyboardNumber?: number) => string | null): GridAudioSfxCue[];
export type AmbienceScene = 'battle' | 'carriage' | 'march' | 'camp' | 'steppe' | 'water' | 'rural' | 'crowd';
export interface AmbienceSceneRule {
    scene: AmbienceScene;
    /** 命中任一关键词即归类（按数组顺序优先） */
    keywords: string[];
    /** 出现任一排除词时本规则不生效（如"风"在室内场景不铺寒风） */
    negativeKeywords?: string[];
    /** 素材候选（相对 repo 根路径，取第一个存在的），空 = 暂无素材 */
    candidates: string[];
    volume: number;
}
/**
 * 场景规则表（策展制，类似 OpenMontage 的 manifest）：
 * 新素材入库后在对应规则的 candidates 里登记即可被计划使用。
 */
export declare const AMBIENCE_RULES: AmbienceSceneRule[];
/** 按规则表对一段场景文本分类；无命中返回 null（该镜头不铺环境音） */
export declare function classifyAmbienceScene(text: string): AmbienceSceneRule | null;
export interface AmbienceShotSlice {
    storyboardNumber: number;
    startSec: number;
    durationSec: number;
    rule: AmbienceSceneRule | null;
}
/**
 * 把逐镜场景分类合并成铺底窗口：相邻同场景合并，窗口过短丢弃，
 * 场景交界处用"下一段提前 1.5s 起播 + 各自淡变"做交叉淡化。
 */
export declare function planAmbienceCueWindows(shots: AmbienceShotSlice[], resolvePath: (rule: AmbienceSceneRule) => string | null): GridAudioAmbienceCue[];
/**
 * 构建单次 ffmpeg filtergraph：
 * 旁白(输入0) + BGM cue 轨(循环/裁剪/淡变/延迟 → amix → loudnorm → 音量) 被旁白侧链闪避
 * + SFX cue 轨(音量/延迟 → amix)，终混 loudnorm 到平台目标 + 限幅。
 */
export declare function buildAudioMixArgs(inputVideo: string, output: string, plan: GridAudioPlan): string[];
/**
 * 构建整集（或 pilot 预算内）的音频计划。
 * 返回 null 表示"没有任何可混的音频"（调用方退回旧行为）。
 * 本函数只读素材与元数据；任何单点素材缺失只跳过对应 cue。
 */
export declare function buildGridAudioPlan(episodeId: number, opts?: GridAudioPlanOptions): GridAudioPlan | null;
export declare function mixGridEpisodeAudio(inputVideo: string, outputVideo: string, plan: GridAudioPlan): Promise<void>;
