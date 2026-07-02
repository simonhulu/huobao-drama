/**
 * Composition / Timeline 类型定义
 *
 * 借鉴 HyperFrames / Remotion 的 track-clip 模型，但专为 FFmpeg 合成服务。
 * 目前先支持单镜（storyboard）合成，后续扩展到集级别 mixer。
 */

export interface MotionPlan {
  kind: 'kenburns' | 'pan' | 'static' | 'keyframes'
  /** 镜头运动持续时长占镜头总时长的比例，默认 1.0 */
  durationScale: number
  /** 关键帧列表；单段运动时只有 start/end 两帧 */
  keyframes: MotionKeyframe[]
}

export interface MotionKeyframe {
  /** 归一化焦点 X（0-1），0.5 为画面中心 */
  focusX: number
  /** 归一化焦点 Y（0-1），0.5 为画面中心 */
  focusY: number
  /** 缩放倍率，1.0 为原始尺寸 */
  zoom: number
  /** 在时间轴上的位置（0-1），用于多段关键帧 */
  t: number
}

export interface AudioLayer {
  /** 音频文件绝对路径 */
  filePath: string
  /** 在镜头内的开始时间（秒） */
  start: number
  /** 有效时长（秒），超过部分会被截断 */
  duration: number
  /** 基础音量倍率 */
  volume: number
  /** 是否循环播放（用于 BGM/Ambience） */
  loop?: boolean
  /** FFmpeg volume 表达式，优先于 volume */
  volumeExpr?: string
  /** 可读名称，用于日志 */
  name: string
}

export interface VideoLayer {
  /** 底层素材绝对路径 */
  filePath: string
  /** 素材类型：image 会 -loop 1，video 直接读取 */
  type: 'image' | 'video'
  /** 输出宽度 */
  width: number
  /** 输出高度 */
  height: number
  /** 镜头总时长（秒） */
  duration: number
  /** 运动计划 */
  motion?: MotionPlan
  /** 叠加层（字幕、标题卡、颗粒暗角等） */
  overlays?: Overlay[]
}

export interface Overlay {
  kind: 'subtitle' | 'title' | 'title-reveal' | 'title-flash' | 'grain-vignette' | 'fade-from-black' | 'sepia' | 'vintage-look'
  /** 开始时间（秒） */
  start: number
  /** 持续时长（秒） */
  duration: number
  /** 叠加层参数 */
  params: Record<string, unknown>
}

export interface SubtitleOverlay extends Overlay {
  kind: 'subtitle'
  params: {
    subtitlePath: string
  }
}

export interface TitleOverlay extends Overlay {
  kind: 'title'
  params: {
    text: string
    fontPath?: string
  }
}

/** 电影感标题揭示：从下方升起并淡入 */
export interface TitleRevealOverlay extends Overlay {
  kind: 'title-reveal'
  params: {
    text: string
    fontPath?: string
    fontSize?: number
    fontColor?: string
    /** 描边颜色，默认不描边 */
    borderColor?: string
    /** 描边宽度，默认 0 */
    borderWidth?: number
    /** 淡入时长（秒），默认 1.0 */
    fadeIn?: number
    /** 保持时长（秒），默认 duration - fadeIn - fadeOut */
    hold?: number
    /** 淡出时长（秒），默认 0.5 */
    fadeOut?: number
    /** 垂直起始偏移（像素），默认 80 */
    riseOffset?: number
  }
}

/** 快闪文字：快速切入切出，适合年号/年代快闪 */
export interface TitleFlashOverlay extends Overlay {
  kind: 'title-flash'
  params: {
    text: string
    fontPath?: string
    fontSize?: number
    fontColor?: string
    /** 描边颜色，默认不描边 */
    borderColor?: string
    /** 描边宽度，默认 0 */
    borderWidth?: number
    /** 淡入时长（秒），默认 0.15 */
    fadeIn?: number
    /** 淡出时长（秒），默认 0.15 */
    fadeOut?: number
  }
}

export interface GrainVignetteOverlay extends Overlay {
  kind: 'grain-vignette'
  params: {
    grainIntensity: number
    vignetteIntensity: number
  }
}

/** 从黑场淡入：在视频开头覆盖黑色并逐渐透明 */
export interface FadeFromBlackOverlay extends Overlay {
  kind: 'fade-from-black'
  params: {
    /** 淡入时长（秒），默认 1.5 */
    fadeDuration?: number
  }
}

/** 老照片色调：Sepia 黄褐色调 */
export interface SepiaOverlay extends Overlay {
  kind: 'sepia'
  params: {
    /** 复古强度 0-1，默认 0.8 */
    intensity?: number
  }
}

/** 复古综合效果：降饱和 + 噪点 + 暗角 + 轻微模糊 */
export interface VintageLookOverlay extends Overlay {
  kind: 'vintage-look'
  params: {
    /** 复古强度 0-1，默认 0.7 */
    intensity?: number
  }
}

export interface StoryboardComposition {
  /** 输出文件绝对路径 */
  outputPath: string
  video: VideoLayer
  audio: AudioLayer[]
  /** 总时长（秒） */
  duration: number
}

export interface RenderResult {
  outputPath: string
  duration: number
  hasVideo: boolean
  hasAudio: boolean
}
