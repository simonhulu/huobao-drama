import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  Video,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const PAPER = "#f2e4c6";
const RED = "#a84b3e";

/**
 * 运镜预设（克制、缓入缓出）——当前生产图为完整16:9横屏，旧竖幅格仍可兼容播放。
 * 选择规则（导演逻辑，不是轮换）：
 *  push      推进——聚焦细节/人物情绪/逼近问题
 *  pull      拉出——揭示规模/释然收尾
 *  tiltDown  竖移向下——从天空/高处落到主体（自上而下的揭示）
 *  tiltUp    竖移向上——从地面/细节升向主体（自下而上的逼近）
 *  hold      近乎静止——画面信息密度高时让图自己说话
 */
type CamPath = "push" | "pull" | "tiltDown" | "tiltUp" | "hold";

/**
 * Ken Burns 防黑边铁律：
 *  - 缩放类（push/pull/hold）只对盒子做 scale，scale ≥ 1.05 时 cover 内容永远铺满，禁止带位移；
 *  - 平移类（tiltDown/tiltUp）走 objectPosition，不对画布盒子做大幅 translate，避免露边。
 */
function camStyle(path: CamPath, p: number): React.CSSProperties {
  switch (path) {
    case "push":
      return { transform: `scale(${1.08 + p * 0.14})`, objectPosition: "50% 50%" };
    case "pull":
      return { transform: `scale(${1.22 - p * 0.14})`, objectPosition: "50% 50%" };
    case "tiltDown":
      // 从画面上部扫到下部（自上而下的揭示）
      return { transform: "scale(1.02)", objectPosition: `50% ${10 + p * 70}%` };
    case "tiltUp":
      // 从画面下部升向上部（自下而上的逼近）
      return { transform: "scale(1.02)", objectPosition: `50% ${90 - p * 70}%` };
    case "hold":
      return { transform: `scale(${1.05 + p * 0.02})`, objectPosition: "50% 45%" };
  }
}

/**
 * 过场语法（剪辑行规，不是特效轮换）：
 *  reveal   显影（灰度→彩色左扫）——全片只用一次，开场签名
 *  cut      硬切——同一场景内节拍切换的默认选择
 *  dissolve 叠化——时间流逝/回忆/地点跳转
 *  fade     淡入自黑场——章节/话题转换
 */
type Entrance = "reveal" | "cut" | "dissolve" | "fade";

export type GridGraphic =
  | { type: "bignum"; value: number; prefix?: string; suffix?: string; label: string }
  | { type: "trend"; title: string; unit?: string; points: Array<{ label: string; value: number }> }
  | { type: "card"; title: string; lines: string[] }
  | {
      type: "identity_reveal";
      placement?: "left" | "right";
      aliasLabel?: string;
      alias?: string;
      verdict?: string;
      truthLabel?: string;
      truth?: string;
    };

export type GridStoryCell = {
  src: string;
  move: CamPath;
  enter: Entrance;
  enterFrames?: number; // dissolve/fade 时长，默认 15 帧
  /** 信息图形（可选）：仅在旁白含值得可视化的数字/趋势/结论时出现，
   *  由 Remotion 动画呈现，图片内不生成文字。不是每格都有。 */
  graphic?: GridGraphic;
  sfx?: { paper?: string; click?: string };
};

export type GridStoryShot = {
  title: string;
  narration: string;
  audio: string;
  cells: GridStoryCell[];
  durationInFrames: number;
  /** Grok 默认整镜播放；素材库可声明 cutaway，在静态垫图上短切后返回。 */
  video?: {
    src: string;
    mode?: "full" | "cutaway";
    startFrame?: number;
    durationInFrames?: number;
    sourceStartFrame?: number;
    scale?: number;
    focusX?: number;
    focusY?: number;
    grade?: "neutral" | "period_warm" | "documentary_muted" | "night_muted";
    transitionFrames?: number;
  };
  /** 分句字幕：按音频时间轴切换；缺省时整段常驻 */
  subtitles?: Array<{ text: string; startSec: number; endSec: number }>;
};

export type GridStoryPreviewProps = {
  shots: GridStoryShot[];
  durationInFrames?: number;
};

function clampInterp(frame: number, input: [number, number], output: [number, number]): number {
  return interpolate(frame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

const mask = (p: number) =>
  `linear-gradient(to right, black ${Math.max(0, p * 110 - 10)}%, transparent ${Math.min(100, p * 110)}%)`;

/** 信息图形层：数字/趋势/总结卡，按需出现（不是每格都有），克制地放在右下信息区 */
function InfoGraphic({ graphic, sfx, delayFrames = 12 }: { graphic?: GridGraphic; sfx?: GridStoryCell["sfx"]; delayFrames?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!graphic) return null;
  if (graphic.type === "identity_reveal") {
    return <IdentityRevealGraphic g={graphic} sfx={sfx} frame={frame} fps={fps} startFrame={delayFrames} />;
  }
  const t = clampInterp(frame, [delayFrames, delayFrames + 14], [0, 1]);
  return (
    <div
      style={{
        position: "absolute",
        right: 44,
        top: "24%",
        zIndex: 70,
        opacity: t,
        transform: `translateY(${(1 - t) * 10}px)`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          backgroundColor: "rgba(10, 8, 5, 0.72)",
          border: "1px solid rgba(242, 228, 198, 0.28)",
          borderRadius: 12,
          padding: "16px 20px",
          fontFamily: FONT,
        }}
      >
        {graphic.type === "bignum" ? <BignumGraphic g={graphic} frame={frame} fps={fps} startFrame={delayFrames} /> : null}
        {graphic.type === "trend" ? <TrendGraphic g={graphic} frame={frame} startFrame={delayFrames} /> : null}
        {graphic.type === "card" ? <CardGraphic g={graphic} frame={frame} startFrame={delayFrames} /> : null}
      </div>
    </div>
  );
}

function IdentityRevealGraphic({
  g,
  sfx,
  frame,
  fps,
  startFrame,
}: {
  g: Extract<GridGraphic, { type: "identity_reveal" }>;
  sfx?: GridStoryCell["sfx"];
  frame: number;
  fps: number;
  startFrame: number;
}) {
  const claimIn = clampInterp(frame, [startFrame, startFrame + 14], [0, 1]);
  const strikeStart = startFrame + Math.round(2.45 * fps);
  const strike = g.alias ? clampInterp(frame, [strikeStart, strikeStart + 12], [0, 1]) : 0;
  const verdictIn = g.verdict ? clampInterp(frame, [strikeStart + 7, strikeStart + 19], [0, 1]) : 0;
  const truthStart = g.alias ? strikeStart + 14 : startFrame + 8;
  const truthIn = g.truth ? clampInterp(frame, [truthStart, truthStart + 16], [0, 1]) : 0;

  return (
    <>
      {sfx?.paper ? (
        <Sequence from={Math.max(0, startFrame - 3)}>
          <Audio src={staticFile(sfx.paper)} volume={0.12} />
        </Sequence>
      ) : null}
      {sfx?.click ? (
        <Sequence from={strikeStart}>
          <Audio src={staticFile(sfx.click)} volume={0.24} />
        </Sequence>
      ) : null}
      <div
        style={{
          position: "absolute",
          ...(g.placement === "left" ? { left: 54 } : { right: 54 }),
          top: 164,
          width: 430,
          zIndex: 72,
          color: PAPER,
          fontFamily: FONT,
          textShadow: "0 2px 14px rgba(0,0,0,0.78)",
          pointerEvents: "none",
        }}
      >
        {g.alias ? (
          <div style={{ opacity: claimIn, transform: `translateY(${(1 - claimIn) * 8}px)` }}>
            <div style={{ fontSize: 15, color: "rgba(242,228,198,0.72)", marginBottom: 8, letterSpacing: 0 }}>
              {g.aliasLabel || "登记姓名"}
            </div>
            <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
              <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 35, lineHeight: 1.16, overflowWrap: "anywhere", letterSpacing: 0 }}>
                {g.alias}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: -4,
                  right: -8,
                  top: "52%",
                  height: 4,
                  backgroundColor: RED,
                  transform: `rotate(-2deg) scaleX(${strike})`,
                  transformOrigin: "left center",
                  boxShadow: "0 1px 6px rgba(0,0,0,0.35)",
                }}
              />
            </div>
            {g.verdict ? (
              <div style={{ marginTop: 10, color: "#d47868", fontSize: 18, fontWeight: 700, opacity: verdictIn, letterSpacing: 0 }}>
                {g.verdict}
              </div>
            ) : null}
          </div>
        ) : null}
        {g.truth ? (
          <div
            style={{
              marginTop: g.alias ? 24 : 0,
              paddingLeft: 18,
              borderLeft: `4px solid ${RED}`,
              opacity: truthIn,
              transform: `translateX(${(1 - truthIn) * 12}px)`,
            }}
          >
            <div style={{ fontSize: 15, color: "rgba(242,228,198,0.72)", marginBottom: 7, letterSpacing: 0 }}>
              {g.truthLabel || "真实身份"}
            </div>
            <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 38, fontWeight: 700, lineHeight: 1.14, overflowWrap: "anywhere", letterSpacing: 0 }}>
              {g.truth}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function BignumGraphic({ g, frame, fps, startFrame }: { g: Extract<GridGraphic, { type: "bignum" }>; frame: number; fps: number; startFrame: number }) {
  const p = clampInterp(frame, [startFrame + 4, startFrame + 26], [0, 1]);
  const eased = 1 - Math.pow(1 - p, 3);
  const value = g.value * eased;
  const display = g.value >= 100 ? Math.round(value).toLocaleString("en-US") : (Math.round(value * 10) / 10).toString();
  return (
    <div style={{ textAlign: "right", minWidth: 180 }}>
      <div style={{ fontSize: 54, fontWeight: 700, color: PAPER, lineHeight: 1.1, letterSpacing: "0.02em" }}>
        {g.prefix ?? ""}{display}{g.suffix ?? ""}
      </div>
      <div style={{ fontSize: 15, color: "#b8b0a0", marginTop: 6 }}>{g.label}</div>
    </div>
  );
}

function TrendGraphic({ g, frame, startFrame }: { g: Extract<GridGraphic, { type: "trend" }>; frame: number; startFrame: number }) {
  const W = 240;
  const H = 110;
  const PAD = 8;
  const max = Math.max(...g.points.map((p) => p.value), 1);
  const slot = (W - PAD * 2) / g.points.length;
  const barW = Math.min(44, slot * 0.55);
  return (
    <div style={{ minWidth: W + 16 }}>
      <div style={{ fontSize: 15, color: "#b8b0a0", marginBottom: 8 }}>
        {g.title}{g.unit ? <span style={{ opacity: 0.7 }}>（{g.unit}）</span> : null}
      </div>
      <svg width={W} height={H + 22} style={{ display: "block" }}>
        {g.points.map((p, i) => {
          const bt = clampInterp(frame, [startFrame + 6 + i * 5, startFrame + 20 + i * 5], [0, 1]);
          const h = Math.max(2, (p.value / max) * (H - 24) * bt);
          const x = PAD + i * slot + (slot - barW) / 2;
          const y = H - 18 - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={h} rx={2} fill={PAPER} opacity={0.9} />
              <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={11} fill={PAPER}>{p.value}</text>
              <text x={x + barW / 2} y={H + 12} textAnchor="middle" fontSize={10} fill={"#b8b0a0"}>{p.label}</text>
            </g>
          );
        })}
        <line x1={PAD} y1={H - 18} x2={W - PAD} y2={H - 18} stroke={"rgba(242,228,198,0.35)"} strokeWidth={1} />
      </svg>
    </div>
  );
}

function CardGraphic({ g, frame, startFrame }: { g: Extract<GridGraphic, { type: "card" }>; frame: number; startFrame: number }) {
  return (
    <div style={{ maxWidth: 260 }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: PAPER, marginBottom: 6 }}>{g.title}</div>
      {(g.lines ?? []).slice(0, 2).map((line, i) => {
        const lt = clampInterp(frame, [startFrame + 6 + i * 6, startFrame + 16 + i * 6], [0, 1]);
        return (
          <div key={i} style={{ fontSize: 14, color: "#d5cdbd", lineHeight: 1.6, opacity: lt, transform: `translateY(${(1 - lt) * 4}px)` }}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

function CellFrame({
  cell,
  prevSrc,
  durationInFrames,
}: {
  cell: GridStoryCell;
  prevSrc?: string;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cam = camStyle(cell.move, p);

  const img = (s: string, extra: React.CSSProperties = {}) => (
    <Img
      src={staticFile(s)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        ...extra,
      }}
    />
  );

  // 显影：全片开场的签名动作（灰度→彩色左扫，两层同图遮罩）
  if (cell.enter === "reveal") {
    const blankEnd = Math.round(0.2 * fps);
    const grayEnd = blankEnd + Math.min(Math.round(1.45 * fps), Math.round(durationInFrames * 0.4));
    const colorEnd = grayEnd + Math.min(Math.round(1.2 * fps), Math.round(durationInFrames * 0.35));
    const grayP = clampInterp(frame, [blankEnd, grayEnd], [0, 1]);
    const colorP = clampInterp(frame, [grayEnd, colorEnd], [0, 1]);
    return (
      <AbsoluteFill style={{ backgroundColor: "#14100c", overflow: "hidden" }}>
        {img(cell.src, {
          filter: "grayscale(1) brightness(0.9)",
          ...cam,
          WebkitMaskImage: mask(grayP),
          maskImage: mask(grayP),
        })}
        {img(cell.src, {
          ...cam,
          WebkitMaskImage: mask(colorP),
          maskImage: mask(colorP),
        })}
      </AbsoluteFill>
    );
  }

  // 叠化：上一格渐隐、本格渐显（时间/回忆跳转）
  if (cell.enter === "dissolve") {
    const dur = cell.enterFrames ?? 15;
    const t = clampInterp(frame, [0, dur], [0, 1]);
    return (
      <AbsoluteFill style={{ backgroundColor: "#14100c", overflow: "hidden" }}>
        {prevSrc ? img(prevSrc, { transform: "scale(1.06)", opacity: 1 - t }) : null}
        {img(cell.src, { ...cam, opacity: t })}
      </AbsoluteFill>
    );
  }

  // 淡入自黑场（章节/话题转换）
  if (cell.enter === "fade") {
    const dur = cell.enterFrames ?? 12;
    const t = clampInterp(frame, [0, dur], [1, 0]);
    return (
      <AbsoluteFill style={{ backgroundColor: "#14100c", overflow: "hidden" }}>
        {img(cell.src, { ...cam })}
        <AbsoluteFill style={{ backgroundColor: "#0d0b08", opacity: t, pointerEvents: "none" }} />
      </AbsoluteFill>
    );
  }

  // 硬切：直接呈现，只有运镜
  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c", overflow: "hidden" }}>
      {img(cell.src, { ...cam })}
    </AbsoluteFill>
  );
}

function videoGrade(grade: NonNullable<GridStoryShot["video"]>["grade"]): string | undefined {
  if (grade === "period_warm") return "saturate(0.78) contrast(1.08) sepia(0.12) brightness(0.92)";
  if (grade === "documentary_muted") return "saturate(0.68) contrast(1.1) brightness(0.9)";
  if (grade === "night_muted") return "brightness(0.56) saturate(0.52) contrast(1.2) sepia(0.08)";
  return undefined;
}

function VideoLayer({
  video,
  durationInFrames,
  immediate,
}: {
  video: NonNullable<GridStoryShot["video"]>;
  durationInFrames: number;
  immediate: boolean;
}) {
  const frame = useCurrentFrame();
  const transitionFrames = Math.min(
    video.transitionFrames ?? 8,
    Math.max(0, Math.floor(durationInFrames / 3)),
  );
  const fadeIn = immediate || transitionFrames === 0
    ? 1
    : clampInterp(frame, [0, transitionFrames], [0, 1]);
  const fadeOut = video.mode === "cutaway" && transitionFrames > 0
    ? clampInterp(frame, [Math.max(0, durationInFrames - transitionFrames), durationInFrames], [1, 0])
    : 1;
  return (
    <Video
      src={staticFile(video.src)}
      muted
      trimBefore={video.sourceStartFrame}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: `${video.focusX ?? 50}% ${video.focusY ?? 50}%`,
        opacity: fadeIn * fadeOut,
        transform: `scale(${video.scale ?? 1})`,
        transformOrigin: `${video.focusX ?? 50}% ${video.focusY ?? 50}%`,
        filter: videoGrade(video.grade),
      }}
    />
  );
}

/** 视频镜头画面：Grok 整镜覆盖；素材库短切后回到静态叙事垫图。 */
function VideoFrame({
  video,
  fallbackCell,
  durationInFrames,
  immediate,
}: {
  video: NonNullable<GridStoryShot["video"]>;
  fallbackCell: GridStoryCell;
  durationInFrames: number;
  immediate: boolean;
}) {
  const isCutaway = video.mode === "cutaway";
  const startFrame = isCutaway ? Math.max(0, video.startFrame ?? 0) : 0;
  const videoDuration = isCutaway
    ? Math.max(1, Math.min(durationInFrames - startFrame, video.durationInFrames ?? durationInFrames))
    : durationInFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c", overflow: "hidden" }}>
      {isCutaway ? (
        <CellFrame cell={fallbackCell} durationInFrames={durationInFrames} />
      ) : (
        <Img src={staticFile(fallbackCell.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      )}
      <Sequence from={startFrame} durationInFrames={videoDuration} premountFor={2}>
        <VideoLayer video={video} durationInFrames={videoDuration} immediate={immediate && !isCutaway} />
      </Sequence>
    </AbsoluteFill>
  );
}

/** 胶片颗粒 + 暗角 */
function TextureOverlay() {
  return (
    <>
      <AbsoluteFill
        style={{
          opacity: 0.16,
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,246,220,0.06) 0, rgba(255,246,220,0.06) 1px, transparent 1px, transparent 4px)",
          mixBlendMode: "screen",
          pointerEvents: "none",
        }}
      />
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, transparent 58%, rgba(10,8,5,0.42) 100%)",
          pointerEvents: "none",
        }}
      />
    </>
  );
}

/** 场景标题：序号 + 标题 + 红色下划线扫入 */
function ShotTitle({ index, total, title }: { index: number; total: number; title: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = spring({
    frame,
    fps,
    config: { damping: 22, mass: 0.62, stiffness: 145 },
    durationInFrames: 18,
  });
  const underline = clampInterp(frame, [8, 22], [0, 1]);

  return (
    <div
      style={{
        position: "absolute",
        left: 44,
        top: 40,
        zIndex: 80,
        opacity: intro,
        transform: `translateY(${(1 - intro) * 12}px)`,
        color: PAPER,
        fontFamily: FONT,
        textShadow: "0 2px 10px rgba(0,0,0,0.55)",
      }}
    >
      <div style={{ fontSize: 15, letterSpacing: 3, opacity: 0.85, marginBottom: 6 }}>
        {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </div>
      <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 2 }}>{title}</div>
      <div
        style={{
          marginTop: 8,
          height: 4,
          width: 120,
          backgroundColor: RED,
          transform: `scaleX(${underline})`,
          transformOrigin: "left center",
        }}
      />
    </div>
  );
}

/** 底部字幕条：按分句时间轴切换当前句 */
function SubtitleBar({ text, subtitles }: { text: string; subtitles?: GridStoryShot["subtitles"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = spring({
    frame: Math.max(0, frame - 4),
    fps,
    config: { damping: 24, mass: 0.7, stiffness: 150 },
    durationInFrames: 16,
  });
  const t = frame / fps;
  const activeClause = subtitles?.length
    ? subtitles.find((s) => t >= s.startSec && t < s.endSec) ?? subtitles[subtitles.length - 1]
    : null;
  const active = activeClause?.text ?? text;
  // 分句切换动效：新句入场 9 帧内淡入 + 上移，避免整段常驻的生硬跳变。
  const clauseStartFrame = activeClause ? Math.round(activeClause.startSec * fps) : 0;
  const clauseT = clampInterp(frame, [clauseStartFrame, clauseStartFrame + 9], [0, 1]);
  return (
    <div
      style={{
        position: "absolute",
        left: 44,
        right: 44,
        bottom: 34,
        zIndex: 80,
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        opacity: intro,
        transform: `translateY(${(1 - intro) * 10}px)`,
        fontFamily: FONT,
      }}
    >
      <div style={{ width: 5, alignSelf: "stretch", backgroundColor: PAPER, opacity: 0.9, borderRadius: 2 }} />
      <div
        style={{
          color: "#f7f1e4",
          fontSize: 25,
          lineHeight: 1.5,
          letterSpacing: 0.5,
          // 半透明底板：亮画面/暗画面都保证字幕可读。
          backgroundColor: "rgba(10, 8, 5, 0.55)",
          borderRadius: 8,
          padding: "4px 14px",
          textShadow: "0 2px 8px rgba(0,0,0,0.8)",
          opacity: clauseT,
          transform: `translateY(${(1 - clauseT) * 6}px)`,
        }}
      >
        {active}
      </div>
    </div>
  );
}

function Shot({ shot, index, total }: { shot: GridStoryShot; index: number; total: number }) {
  const { fps } = useVideoConfig();

  // 新生产契约每镜只有一张图；旧双格数据仍按原顺序兼容播放。
  const durationSec = shot.durationInFrames / fps;
  const cellCount = Math.max(1, Math.min(4, Math.round(durationSec / 4.5)));
  const usable = shot.cells.slice(0, cellCount);
  const baseFrames = Math.floor(shot.durationInFrames / usable.length);

  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c" }}>
      {shot.video ? (
        <VideoFrame
          video={shot.video}
          fallbackCell={shot.cells[0]}
          durationInFrames={shot.durationInFrames}
          immediate={index === 0}
        />
      ) : (
        usable.map((cell, i) => {
          const isLast = i === usable.length - 1;
          const dur = isLast ? shot.durationInFrames - baseFrames * (usable.length - 1) : baseFrames;
          return (
            <Sequence key={i} from={i * baseFrames} durationInFrames={dur}>
              <CellFrame cell={cell} prevSrc={i > 0 ? usable[i - 1].src : undefined} durationInFrames={dur} />
              <InfoGraphic graphic={cell.graphic} sfx={cell.sfx} />
            </Sequence>
          );
        })
      )}

      {shot.video && shot.cells[0]?.graphic ? <InfoGraphic graphic={shot.cells[0].graphic} sfx={shot.cells[0].sfx} /> : null}

      <TextureOverlay />
      <ShotTitle index={index} total={total} title={shot.title} />
      <SubtitleBar text={shot.narration} subtitles={shot.subtitles} />
      <Audio src={staticFile(shot.audio)} />
    </AbsoluteFill>
  );
}

export const GridStoryPreview: React.FC<GridStoryPreviewProps> = ({ shots }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c" }}>
      {shots.map((shot, i) => {
        const seq = (
          <Sequence key={i} from={from} durationInFrames={shot.durationInFrames}>
            <Shot shot={shot} index={i} total={shots.length} />
          </Sequence>
        );
        from += shot.durationInFrames;
        return seq;
      })}
    </AbsoluteFill>
  );
};
