import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  Video,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * DharmaEpisode —— 佛学/哲学口播合成。
 *
 * 与 GridStoryPreview（历史叙事）的设计差异：
 *  - 画面是氛围层：AI 关键情绪图与动态视频段落共同承载心境（视频 muted，声音永远只来自
 *    narration master）；没有逐镜制作图、没有信息图形、没有镜头序号标题。
 *  - 氛围段落用慢叠化；人物叙事插画用短促 dip-to-ink，避免两组人脸重叠——
 *    禅意内容保持流动，但不能用“柔和”掩盖视觉错误。
 *  - BGM 单轨循环、Remotion 内混音（音量包络淡入淡出），不做 ffmpeg 后混。
 *  - 金句卡是唯一的文字强调层：居中、衬线、金色细线，锚定在旁白窗口上。
 *
 * 时序契约与 v8 相同：segments/quotes 全部按绝对帧位挂载（相对渲染 0 帧），
 * 字幕是全局绝对秒时间轴；任何一层都不参与累计堆叠。
 */

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Dharma Noto Serif", "Songti SC", "STSong", "SimSun", serif';
const GOLD = "#b9924b";
const IVORY = "#f2ead8";
const INK = "#080d12";

/** 段落间叠化时长（帧）：慢，但不能吃掉段落时长的三分之一以上 */
const CROSSFADE_FRAMES = 24;
const NARRATIVE_DIP_HALF_FRAMES = 8;
/** A title needs this much uninterrupted time to read as an invocation, not a flash. */
const MIN_OPENING_INVOCATION_FRAMES = 45;

export type DharmaSegment = {
  kind: "video" | "image";
  src: string;
  startFrame: number;
  durationInFrames: number;
  /** Actual incoming lead used for the crossfade; emitted by the props builder. */
  crossfadeLeadFrames?: number;
  /** video：源素材起播点（秒）；image：忽略 */
  sourceStartSec?: number;
  /** video：素材偏短时的慢放比（0.6–1），绝不循环 */
  playbackRate?: number;
  focusX?: number;
  focusY?: number;
  /** 调色：禅意克制方向，默认 neutral */
  grade?: "neutral" | "zen_muted" | "ink_dark" | "warm_dawn";
  /** image：Ken Burns 运镜（只用 transform，避免高成本逐帧效果） */
  move?: "push" | "pull" | "hold" | "drift_left" | "drift_right";
  emotion?: "curiosity" | "stillness" | "tension" | "acceptance" | "insight" | "release";
  styleId?: string;
  treatment?: "ink_wash" | "surreal_dream" | "minimal_light" | "legacy_temple";
  shotFunction?: "narrative_illustration" | "atmosphere_bridge";
  theme?: string;
};

export type DharmaQuote = {
  text: string;
  source?: string;
  startFrame: number;
  durationInFrames: number;
};

export type DharmaSubtitleClause = {
  text: string;
  startSec: number;
  endSec: number;
};

export type DharmaNarrationWindow = {
  startFrame: number;
  endFrame: number;
};

export type DharmaOpening = {
  text: string;
  startFrame: number;
  durationInFrames: number;
};

export type DharmaEpisodeProps = {
  /** 整集唯一 narration 主音轨（必需） */
  audio: string;
  /** 子集渲染时主音轨的裁剪起点（帧），全片为 0 */
  audioStartFrame?: number;
  /** Review pilots may end after a complete spoken sentence; keep the visual/BGM tail silent. */
  narrationEndFrame?: number;
  /** 单轨 BGM：实测响度定标、旁白闪避、跨循环淡变 */
  bgm?: {
    src: string;
    volume?: number;
    narrationVolume?: number;
    fadeInSec?: number;
    fadeOutSec?: number;
    loopCrossfadeSec?: number;
    sourceDurationSec?: number;
  };
  segments: DharmaSegment[];
  quotes?: DharmaQuote[];
  opening?: DharmaOpening;
  narrationWindows?: DharmaNarrationWindow[];
  /** 全局分句字幕（绝对秒，相对渲染 0 帧） */
  subtitles?: DharmaSubtitleClause[];
  durationInFrames?: number;
};

export function resolveDharmaNarrationDurationInFrames(
  compositionDurationInFrames: number,
  narrationEndFrame?: number,
): number {
  const compositionDuration = Math.max(1, Math.floor(compositionDurationInFrames));
  if (!Number.isFinite(narrationEndFrame) || narrationEndFrame === undefined || narrationEndFrame <= 0) {
    return compositionDuration;
  }
  return Math.min(compositionDuration, Math.max(1, Math.floor(narrationEndFrame)));
}

function clampInterp(frame: number, input: [number, number], output: [number, number]): number {
  return interpolate(frame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** A bundled OFL font keeps the title/quote hierarchy stable across render hosts. */
function DharmaFontFace() {
  return (
    <style>{`
      @font-face {
        font-family: "Dharma Noto Serif";
        src: url("${staticFile("fonts/NotoSerifSC-Bold.ttf")}") format("truetype");
        font-style: normal;
        font-weight: 700;
        font-display: block;
      }
    `}</style>
  );
}

function gradeFilter(grade: DharmaSegment["grade"]): string | undefined {
  if (grade === "zen_muted") return "saturate(0.72) contrast(1.05) brightness(0.94)";
  if (grade === "ink_dark") return "saturate(0.5) contrast(1.15) brightness(0.85)";
  if (grade === "warm_dawn") return "saturate(0.85) sepia(0.15) brightness(1.02)";
  return undefined;
}

function treatmentFilter(treatment: DharmaSegment["treatment"]): string | undefined {
  if (treatment === "ink_wash") return "grayscale(0.28) sepia(0.06) saturate(0.72) contrast(1.08) brightness(0.93)";
  if (treatment === "surreal_dream") return "saturate(0.82) contrast(1.12) brightness(0.9)";
  if (treatment === "minimal_light") return "saturate(0.38) contrast(1.22) brightness(0.78)";
  if (treatment === "legacy_temple") return "saturate(0.82) contrast(1.04) brightness(0.94)";
  return undefined;
}

function combineFilters(...filters: Array<string | undefined>): string | undefined {
  const combined = filters.filter(Boolean).join(" ");
  return combined || undefined;
}

/** Ken Burns remains transform-only so Chromium can keep it on the compositor. */
export function resolveDharmaImageTransform(move: DharmaSegment["move"], p: number): string {
  const stable = (value: number) => Number(value.toFixed(4));
  switch (move) {
    case "pull":
      return `scale(${stable(1.18 - p * 0.1)})`;
    case "hold":
      return "scale(1.06)";
    case "drift_left":
      return `scale(1.14) translate3d(${stable(-1.8 + p * 3.6)}%, 0, 0)`;
    case "drift_right":
      return `scale(1.14) translate3d(${stable(1.8 - p * 3.6)}%, 0, 0)`;
    case "push":
    default:
      return `scale(${stable(1.06 + p * 0.12)})`;
  }
}

export function dharmaTreatmentOverlayStyle(
  treatment: DharmaSegment["treatment"],
): React.CSSProperties {
  if (treatment === "ink_wash") {
    return {
      background: "linear-gradient(112deg, rgba(222,216,198,0.1), transparent 34%, rgba(5,12,13,0.2) 76%), radial-gradient(ellipse 85% 120% at 14% 55%, rgba(2,8,9,0.04), rgba(2,8,9,0.38))",
      mixBlendMode: "multiply",
      opacity: 0.72,
    };
  }
  if (treatment === "surreal_dream") {
    return {
      background: "linear-gradient(135deg, rgba(8,22,24,0.42), transparent 43%, rgba(112,82,32,0.18) 72%, rgba(3,8,10,0.46))",
      mixBlendMode: "screen",
      opacity: 0.38,
    };
  }
  if (treatment === "minimal_light") {
    return {
      background: "linear-gradient(108deg, rgba(1,4,5,0.72) 0%, rgba(1,4,5,0.52) 34%, rgba(222,210,178,0.08) 48%, rgba(1,4,5,0.7) 68%, rgba(1,4,5,0.88) 100%)",
      opacity: 0.9,
    };
  }
  return { background: "rgba(3,8,10,0.08)" };
}

/** 视频段落画面：muted（声音只来自 narration master）+ 慢放适配 + 调色 */
function VideoVisual({ seg }: { seg: DharmaSegment }) {
  const { fps } = useVideoConfig();
  return (
    <Video
      src={staticFile(seg.src)}
      muted
      trimBefore={Math.max(0, Math.round((seg.sourceStartSec ?? 0) * fps))}
      playbackRate={seg.playbackRate ?? 1}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: `${seg.focusX ?? 50}% ${seg.focusY ?? 50}%`,
        filter: combineFilters(gradeFilter(seg.grade), treatmentFilter(seg.treatment)),
      }}
    />
  );
}

function ImageVisual({ seg }: { seg: DharmaSegment }) {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, Math.max(1, seg.durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <Img
      src={staticFile(seg.src)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        // AI keyframes and approved stills share the same quiet visual envelope
        // as the graded video behind a teaching phrase.
        filter: treatmentFilter(seg.treatment) ?? treatmentFilter("legacy_temple"),
        transform: resolveDharmaImageTransform(seg.move, p),
        willChange: "transform",
      }}
    />
  );
}

/**
 * 单个视觉段落。叠化实现：非首段落提前 CROSSFADE_FRAMES 帧挂载，
 * 前 CROSSFADE_FRAMES 帧不透明度 0→1（z-index 高于前一段，形成真叠化），
 * 不移动任何旁白边界。首段落必须从第 0 帧就有可见主体，不能用黑场淡入吃掉开场留存。
 */
export function resolveDharmaSegmentOpacity(frame: number, isFirst: boolean, fadeFrames: number): number {
  if (isFirst || fadeFrames <= 0) return 1;
  return clampInterp(frame, [0, Math.max(1, fadeFrames)], [0, 1]);
}

export function usesDharmaNarrativeDip(previous: DharmaSegment | undefined, current: DharmaSegment): boolean {
  if (!previous || previous.kind !== "image" || current.kind !== "image") return false;
  return previous.shotFunction === "narrative_illustration"
    || current.shotFunction === "narrative_illustration";
}

export function resolveDharmaNarrativeDipOpacity(frame: number, halfFrames = NARRATIVE_DIP_HALF_FRAMES): number {
  const half = Math.max(1, Math.floor(halfFrames));
  return interpolate(frame, [0, half, half * 2], [0, 0.94, 0], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function NarrativeDipVeil() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        zIndex: 890,
        backgroundColor: INK,
        opacity: resolveDharmaNarrativeDipOpacity(frame),
        pointerEvents: "none",
      }}
    />
  );
}

function SegmentLayer({ seg, isFirst, zIndex, fadeFrames }: { seg: DharmaSegment; isFirst: boolean; zIndex: number; fadeFrames: number }) {
  const frame = useCurrentFrame();
  const opacity = resolveDharmaSegmentOpacity(frame, isFirst, fadeFrames);
  return (
    <AbsoluteFill style={{ backgroundColor: INK, overflow: "hidden", zIndex, opacity }}>
      {seg.kind === "video" ? <VideoVisual seg={seg} /> : <ImageVisual seg={seg} />}
      <AbsoluteFill
        style={{
          ...dharmaTreatmentOverlayStyle(seg.treatment),
          pointerEvents: "none",
          zIndex: 2,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: "repeating-linear-gradient(93deg, rgba(255,255,255,0.018) 0, rgba(255,255,255,0.018) 1px, rgba(0,0,0,0.018) 1px, rgba(0,0,0,0.018) 3px)",
          mixBlendMode: "overlay",
          opacity: seg.treatment === "ink_wash" ? 0.72 : 0.38,
          pointerEvents: "none",
          zIndex: 3,
        }}
      />
    </AbsoluteFill>
  );
}

/**
 * Keep visual material quiet enough to read as a temple teaching room. This is a
 * diffuse veil, never a panel behind an individual line of text. A single
 * gradient layer avoids the costly blurred inset shadow on every rendered frame.
 */
function TextureOverlay() {
  return (
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(180deg, rgba(1,5,7,0.42) 0%, rgba(1,5,7,0.1) 36%, rgba(1,5,7,0.52) 100%), radial-gradient(ellipse 92% 88% at center, rgba(1,5,7,0) 22%, rgba(1,5,7,0.18) 54%, rgba(1,5,7,0.66) 100%)",
        pointerEvents: "none",
        zIndex: 900,
      }}
    />
  );
}

/** Original temple-room frame: restrained rails and a small lamp mark, never copied account artwork. */
function SanctumFrame() {
  const rail = {
    position: "absolute" as const,
    top: 34,
    bottom: 34,
    width: 1,
    backgroundColor: "rgba(185,146,75,0.46)",
    boxShadow: "0 0 10px rgba(185,146,75,0.16)",
  };
  return (
    <AbsoluteFill style={{ zIndex: 940, pointerEvents: "none", opacity: 0.76 }}>
      <div style={{ ...rail, left: 28 }} />
      <div style={{ ...rail, right: 28 }} />
      <div style={{ position: "absolute", left: 28, right: 28, top: 34, height: 1, backgroundColor: "rgba(185,146,75,0.28)" }} />
      <div style={{ position: "absolute", left: 28, right: 28, bottom: 34, height: 1, backgroundColor: "rgba(185,146,75,0.2)" }} />
      <div style={{ position: "absolute", left: 42, top: 47, width: 68, height: 1, backgroundColor: "rgba(185,146,75,0.46)" }} />
      <div style={{ position: "absolute", right: 42, top: 47, width: 68, height: 1, backgroundColor: "rgba(185,146,75,0.46)" }} />
      <div
        style={{
          position: "absolute",
          top: 39,
          left: "50%",
          width: 10,
          height: 10,
          transform: "translateX(-50%) rotate(45deg)",
          border: "1px solid rgba(185,146,75,0.7)",
          backgroundColor: "rgba(8,13,18,0.38)",
        }}
      />
    </AbsoluteFill>
  );
}

/** Keeps the central teaching phrase legible at the 1280x720 delivery size. */
export function sacredPhraseFontSize(text: string): number {
  const length = Array.from(text).length;
  if (length <= 10) return 76;
  if (length <= 16) return 66;
  if (length <= 26) return 56;
  return 46;
}

/**
 * The opening invocation and a central quote use the same visual hierarchy.
 * When their windows collide, a very short title is worse than no title: it
 * turns the central phrase into a stack of competing headlines. Keep a title
 * only when it has enough uninterrupted reading time; otherwise let the quote
 * be the sole teaching moment.
 */
export function resolveDharmaOpeningInvocation(
  opening: DharmaOpening | undefined,
  quotes: DharmaQuote[] = [],
): DharmaOpening | undefined {
  if (!opening || opening.durationInFrames < 1) return undefined;
  const endFrame = opening.startFrame + opening.durationInFrames;
  const firstOverlap = quotes
    .filter((quote) => quote.durationInFrames > 0
      && quote.startFrame < endFrame
      && quote.startFrame + quote.durationInFrames > opening.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)[0];
  if (!firstOverlap) return opening;

  const availableFrames = firstOverlap.startFrame - opening.startFrame;
  if (availableFrames < MIN_OPENING_INVOCATION_FRAMES) return undefined;
  return { ...opening, durationInFrames: availableFrames };
}

/** A sparse ritual divider gives hierarchy without introducing a UI container. */
function RitualDivider({ marginBottom = 24 }: { marginBottom?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom }}>
      <div style={{ width: 82, height: 1, backgroundColor: GOLD, opacity: 0.7 }} />
      <div style={{ width: 7, height: 7, transform: "rotate(45deg)", backgroundColor: GOLD, opacity: 0.88 }} />
      <div style={{ width: 82, height: 1, backgroundColor: GOLD, opacity: 0.7 }} />
    </div>
  );
}

/** A teaching phrase, not a modal: ivory central type, a sparse rule, restrained provenance. */
function SutraMoment({ quote }: { quote: DharmaQuote }) {
  const frame = useCurrentFrame();
  const enter = clampInterp(frame, [0, 16], [0, 1]);
  const exit = clampInterp(frame, [Math.max(0, quote.durationInFrames - 14), quote.durationInFrames], [1, 0]);
  const t = Math.min(enter, exit);
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
        pointerEvents: "none",
        opacity: t,
        background: "radial-gradient(ellipse 54% 46% at center, rgba(1,6,9,0.68) 0%, rgba(1,6,9,0.38) 43%, rgba(1,6,9,0) 78%)",
      }}
    >
      <div
        style={{
          width: "82%",
          maxWidth: 1060,
          textAlign: "center",
          transform: `translateY(${(1 - t) * 14}px)`,
        }}
      >
        <RitualDivider />
        <div
          style={{
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: sacredPhraseFontSize(quote.text),
            lineHeight: 1.35,
            color: IVORY,
            letterSpacing: 0,
            WebkitTextStroke: "1.35px rgba(3,7,9,0.88)",
            textShadow: "0 3px 22px rgba(0,0,0,0.92)",
          }}
        >
          {quote.text}
        </div>
        {quote.source ? (
          <div
            style={{
              marginTop: 20,
              fontFamily: SERIF,
              fontSize: 19,
              color: "rgba(242,234,216,0.76)",
              letterSpacing: 0,
              textShadow: "0 2px 8px rgba(0,0,0,0.88)",
            }}
          >
            {quote.source}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

/** Safe title fallback uses episode title, never the stale generic opening_hook field. */
function OpeningInvocation({ opening }: { opening: DharmaOpening }) {
  const frame = useCurrentFrame();
  const enter = clampInterp(frame, [5, 20], [0, 1]);
  const exit = clampInterp(frame, [Math.max(0, opening.durationInFrames - 16), opening.durationInFrames], [1, 0]);
  const t = Math.min(enter, exit);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", zIndex: 1001, pointerEvents: "none", opacity: t }}>
      <div style={{ width: "78%", maxWidth: 1000, textAlign: "center", transform: `translateY(${(1 - t) * 10}px)` }}>
        <RitualDivider marginBottom={26} />
        <div
          style={{
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: sacredPhraseFontSize(opening.text),
            lineHeight: 1.3,
            color: IVORY,
            letterSpacing: 0,
            WebkitTextStroke: "1.35px rgba(3,7,9,0.9)",
            textShadow: "0 3px 22px rgba(0,0,0,0.94)",
          }}
        >
          {opening.text}
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** Flat lower-third wash retains accessibility without turning each clause into a rounded UI pill. */
function SubtitleBar({
  subtitles,
  quotes,
  opening,
}: {
  subtitles: DharmaSubtitleClause[];
  quotes?: DharmaQuote[];
  opening?: DharmaOpening;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const active = subtitles.find((s) => t >= s.startSec && t < s.endSec) ?? null;
  const quoteActive = quotes?.some((quote) => frame >= quote.startFrame && frame < quote.startFrame + quote.durationInFrames);
  const openingActive = opening && frame >= opening.startFrame && frame < opening.startFrame + opening.durationInFrames;
  if (!active || quoteActive || openingActive) return null;
  const clauseStartFrame = Math.round(active.startSec * fps);
  const clauseT = clampInterp(frame, [clauseStartFrame, clauseStartFrame + 9], [0, 1]);
  return (
    <div
      style={{
        position: "absolute",
        left: 112,
        right: 112,
        bottom: 50,
        zIndex: 1100,
        display: "flex",
        justifyContent: "center",
        fontFamily: FONT,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          color: IVORY,
          fontSize: 28,
          lineHeight: 1.5,
          letterSpacing: 0,
          textAlign: "center",
          maxWidth: "100%",
          boxSizing: "border-box",
          background: "linear-gradient(90deg, transparent, rgba(4,9,13,0.7) 16%, rgba(4,9,13,0.7) 84%, transparent)",
          borderTop: "1px solid rgba(185,146,75,0.22)",
          padding: "7px 30px 8px",
          textShadow: "0 2px 10px rgba(0,0,0,0.9)",
          opacity: clauseT,
          transform: `translateY(${(1 - clauseT) * 6}px)`,
        }}
      >
        {active.text}
      </div>
    </div>
  );
}

export function narrationPresence(frame: number, windows: DharmaNarrationWindow[]): number {
  for (const window of windows) {
    if (frame >= window.startFrame - 8 && frame < window.endFrame + 14) {
      if (frame < window.startFrame) return clampInterp(frame, [window.startFrame - 8, window.startFrame], [0, 1]);
      if (frame >= window.endFrame) return clampInterp(frame, [window.endFrame, window.endFrame + 14], [1, 0]);
      return 1;
    }
  }
  return 0;
}

export function buildDharmaBgmLoopStarts(
  durationInFrames: number,
  sourceFrames: number,
  loopFadeFrames: number,
): number[] {
  const step = Math.max(1, sourceFrames - loopFadeFrames);
  const starts: number[] = [];
  for (let from = 0; from < durationInFrames; from += step) starts.push(from);
  return starts;
}

/** Long BGM uses intentional crossfaded repetitions and narration-aware ducking. */
function BgmTrack({
  bgm,
  narrationWindows = [],
}: {
  bgm: NonNullable<DharmaEpisodeProps["bgm"]>;
  narrationWindows?: DharmaNarrationWindow[];
}) {
  const { fps, durationInFrames } = useVideoConfig();
  const base = bgm.volume ?? 0.025;
  const narrationVolume = Math.min(base, bgm.narrationVolume ?? base * 0.5);
  const fadeIn = Math.max(1, Math.round((bgm.fadeInSec ?? 3) * fps));
  const fadeOut = Math.max(1, Math.round((bgm.fadeOutSec ?? 5) * fps));
  const sourceFrames = Math.max(1, Math.round((bgm.sourceDurationSec ?? durationInFrames / fps) * fps));
  const loopFade = Math.min(Math.max(1, Math.round((bgm.loopCrossfadeSec ?? 4) * fps)), Math.max(1, Math.floor(sourceFrames / 3)));
  const loopStarts = buildDharmaBgmLoopStarts(durationInFrames, sourceFrames, loopFade);
  return (
    <>
      {loopStarts.map((from, index) => (
        <Sequence key={from} from={from} durationInFrames={Math.min(sourceFrames, durationInFrames - from)} premountFor={2}>
          <Audio
            src={staticFile(bgm.src)}
            volume={(localFrame) => {
              const globalFrame = from + localFrame;
              const speech = narrationPresence(globalFrame, narrationWindows);
              const ducked = base + (narrationVolume - base) * speech;
              const startGain = index === 0 ? 1 : clampInterp(localFrame, [0, loopFade], [0, 1]);
              const endGain = index === loopStarts.length - 1
                ? 1
                : clampInterp(localFrame, [sourceFrames - loopFade, sourceFrames], [1, 0]);
              const projectIn = clampInterp(globalFrame, [0, fadeIn], [0, 1]);
              const projectOut = clampInterp(globalFrame, [durationInFrames - fadeOut, durationInFrames], [1, 0]);
              return ducked * startGain * endGain * Math.min(projectIn, projectOut);
            }}
          />
        </Sequence>
      ))}
    </>
  );
}

export const DharmaEpisode: React.FC<DharmaEpisodeProps> = ({
  audio,
  audioStartFrame,
  narrationEndFrame,
  bgm,
  segments,
  quotes,
  opening,
  narrationWindows,
  subtitles,
}) => {
  if (!audio) {
    throw new Error("DharmaEpisode requires a master narration audio URL");
  }
  if (!segments.length) {
    throw new Error("DharmaEpisode requires at least one visual segment");
  }
  const { durationInFrames } = useVideoConfig();
  const narrationDurationInFrames = resolveDharmaNarrationDurationInFrames(durationInFrames, narrationEndFrame);
  const resolvedOpening = resolveDharmaOpeningInvocation(opening, quotes ?? []);
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <DharmaFontFace />
      <Sequence from={0} durationInFrames={narrationDurationInFrames} premountFor={2}>
        <Audio src={staticFile(audio)} startFrom={audioStartFrame ?? 0} />
      </Sequence>
      {bgm ? <BgmTrack bgm={bgm} narrationWindows={narrationWindows} /> : null}
      {segments.map((seg, i) => {
        const narrativeDip = usesDharmaNarrativeDip(segments[i - 1], seg);
        // 非首段落提前 CROSSFADE_FRAMES 帧挂载以形成叠化；时长相应延长。
        // 绝对帧位锚定不变——旁白/字幕/金句与画面边界的对齐不受影响。
        const defaultLead = i === 0 ? 0 : Math.min(CROSSFADE_FRAMES, Math.floor(seg.durationInFrames / 3));
        const lead = narrativeDip
          ? 0
          : Math.min(CROSSFADE_FRAMES, Math.max(0, Math.floor(seg.crossfadeLeadFrames ?? defaultLead)));
        const fadeFrames = i === 0
          ? Math.min(18, Math.max(1, Math.floor(seg.durationInFrames / 3)))
          : narrativeDip ? 0 : Math.max(1, lead);
        return (
          <Sequence
            key={i}
            from={Math.max(0, seg.startFrame - lead)}
            durationInFrames={seg.durationInFrames + lead}
            premountFor={2}
          >
            <SegmentLayer seg={seg} isFirst={i === 0} zIndex={i + 1} fadeFrames={fadeFrames} />
          </Sequence>
        );
      })}
      {segments.slice(1).map((seg, index) => {
        const previous = segments[index];
        if (!usesDharmaNarrativeDip(previous, seg)) return null;
        return (
          <Sequence
            key={`narrative-dip-${index + 1}`}
            from={Math.max(0, seg.startFrame - NARRATIVE_DIP_HALF_FRAMES)}
            durationInFrames={NARRATIVE_DIP_HALF_FRAMES * 2 + 1}
            premountFor={2}
          >
            <NarrativeDipVeil />
          </Sequence>
        );
      })}
      <TextureOverlay />
      <SanctumFrame />
      {resolvedOpening ? (
        <Sequence from={Math.max(0, resolvedOpening.startFrame)} durationInFrames={resolvedOpening.durationInFrames}>
          <OpeningInvocation opening={resolvedOpening} />
        </Sequence>
      ) : null}
      {(quotes ?? []).map((quote, i) => (
        <Sequence key={i} from={Math.max(0, quote.startFrame)} durationInFrames={quote.durationInFrames}>
          <SutraMoment quote={quote} />
        </Sequence>
      ))}
      {subtitles?.length ? <SubtitleBar subtitles={subtitles} quotes={quotes} opening={resolvedOpening} /> : null}
    </AbsoluteFill>
  );
};
