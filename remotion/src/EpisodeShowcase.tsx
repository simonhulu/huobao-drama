import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { chinaMapBounds, chinaProvincePaths, chinaRiverPaths } from "./chinaMapData";
import { worldGeoJson } from "./worldMapData";

type Focus = { x: number; y: number; zoom: number };

export type EditBeat = {
  id: string;
  start: number;
  end: number;
  text: string;
  role: string;
  framing: string;
  focus: Focus;
  motion: string;
  easing: string;
  transition: string;
  rationale: string;
  layerMode: string;
  layers: Array<{ name: string; depth: number; motionMultiplier: number }>;
  fallback: string | null;
  warnings: string[];
};

export type CaptionSegment = {
  startFrame: number;
  endFrame: number;
  text: string;
};

export type CharacterCard = {
  key: string;
  name: string;
  imageUrl: string;
  startFrame: number;
  endFrame: number;
  detail: string;
  accent: string;
  x?: number;
  y?: number;
  scale?: number;
  zIndex?: number;
  requiresAlpha?: boolean;
};

export type StoryContractView = {
  beatId?: string;
  function?: string;
  actorIds?: string[];
  target?: string;
  action?: string;
  phase?: string;
  beforeState?: string;
  afterState?: string;
  visualProof?: string[];
};

export type StockBroll = {
  provider: "pexels" | "pixabay" | "coverr" | string;
  videoId: string;
  title?: string;
  creator?: string;
  videoUrl: string;
  localPath: string;
  sourceUrl: string;
  licenseUrl: string;
  duration?: number;
  opacity?: number;
  blendMode?: "screen" | "soft-light" | "overlay" | "multiply" | "normal";
  presentation?: "full-frame" | "inset-cutaway";
  startFrame?: number;
  endFrame?: number;
};

type MapLocation = {
  id: string;
  label: string;
  lon: number;
  lat: number;
  coordinateSource: string;
  labelDx?: number;
  labelDy?: number;
};

type MapRoute = {
  id?: string;
  from: string;
  to: string;
  historyStatus: string;
  color: string;
  label?: string;
  labelAt?: { lon: number; lat: number };
  waypoints?: Array<{ lon: number; lat: number }>;
  opacity?: number;
};

type MigrationMap = {
  mode: string;
  mapFamily?: string;
  projection: string;
  bounds?: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  historyStatus: string;
  source: { name: string; license: string; url: string };
  title?: string;
  subtitle?: string;
  legend?: string[];
  locations: MapLocation[];
  routes: MapRoute[];
  warnings: string[];
};

export type ShowcaseShot = {
  storyboardNumber: number;
  storyboardId: number;
  duration: number;
  durationInFrames: number;
  title: string;
  shotType?: string;
  imageUrl: string;
  fallbackImageUrl?: string | null;
  audioUrl?: string | null;
  narration?: string | null;
  graphic: string;
  visualMode?: string;
  characters?: CharacterCard[];
  map?: MigrationMap | null;
  stockBroll?: StockBroll[];
  beats: EditBeat[];
  captionSegments?: CaptionSegment[];
  sourceEvidence?: Record<string, unknown>;
  renderContract?: Record<string, unknown>;
  storyAction?: string;
  story?: StoryContractView;
  warnings?: string[];
};

export type EpisodeShowcaseProps = {
  episodeId: number;
  episodeNumber: number;
  title: string;
  fps: number;
  shots: ShowcaseShot[];
  durationInFrames: number;
  audioUrl?: string | null;
  audioVolume?: number;
};

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "SimSun", serif';
const GOLD = "#e6b85e";
const PAPER = "#f6ead2";
const INSET = 58;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function beatFrames(beat: EditBeat, fps: number) {
  return {
    from: Math.max(0, Math.round(beat.start * fps)),
    duration: Math.max(1, Math.round((beat.end - beat.start) * fps)),
  };
}

type PlateSegment = {
  beat: EditBeat;
  from: number;
  duration: number;
};

/**
 * Keep the camera plate alive for the whole shot. Beat metadata can describe
 * only the active motion window, while the character layer intentionally
 * spans the complete shot duration.
 */
function plateSegments(shot: ShowcaseShot, fps: number): PlateSegment[] {
  const total = Math.max(1, shot.durationInFrames);
  const beats = shot.beats.length > 0 ? shot.beats : [];
  if (beats.length === 0) return [];

  // The current producer emits one beat per shot. Extending it preserves a
  // continuous camera move instead of restarting the motion in a tail fill.
  if (beats.length === 1) {
    return [{
      beat: { ...beats[0], start: 0, end: total / fps },
      from: 0,
      duration: total,
    }];
  }

  const segments: PlateSegment[] = [];
  const ranges = beats
    .map((beat) => {
      const timing = beatFrames(beat, fps);
      const from = clamp(timing.from, 0, total);
      const end = clamp(from + timing.duration, from, total);
      return { beat, from, end };
    })
    .sort((a, b) => a.from - b.from);

  let cursor = 0;
  let previousBeat = ranges[0]?.beat;
  for (const range of ranges) {
    if (range.from > cursor && previousBeat) {
      segments.push({
        beat: { ...previousBeat, id: `${previousBeat.id}-fill-${cursor}`, start: 0, end: (range.from - cursor) / fps },
        from: cursor,
        duration: range.from - cursor,
      });
    }
    if (range.end > range.from) {
      segments.push({ beat: range.beat, from: range.from, duration: range.end - range.from });
      cursor = Math.max(cursor, range.end);
      previousBeat = range.beat;
    }
  }
  if (cursor < total && previousBeat) {
    segments.push({
      beat: { ...previousBeat, id: `${previousBeat.id}-tail-${cursor}`, start: 0, end: (total - cursor) / fps },
      from: cursor,
      duration: total - cursor,
    });
  }
  return segments;
}

function localProgress(frame: number, duration: number, easing: string) {
  const safeDuration = Math.max(1, duration);
  const easingFn = easing === "ease-out"
    ? Easing.out(Easing.cubic)
    : easing === "ease-in"
      ? Easing.in(Easing.cubic)
      : easing === "ease-in-out"
        ? Easing.inOut(Easing.cubic)
        : Easing.linear;
  return interpolate(frame, [0, safeDuration], [0, 1], {
    easing: easingFn,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function semanticMotion(beat: EditBeat, frame: number, fps: number, duration: number) {
  const motion = `${beat.motion} ${beat.role} ${beat.text}`;
  const target = beat.focus;
  const isHold = /hold|still|静止|定格|停留|保持|near-static/i.test(motion);
  const isPullBack = /pull-back|拉远|远离/i.test(motion);
  const isLateral = /lateral|横移|扫过|跟拍|pan|向左|向右|左侧|右侧/i.test(motion);
  const isRapidCrop = /rapid crop|sharp crop|rapid|sharp|impact/i.test(motion);
  const isTinyPush = /tiny push|subtle push/i.test(motion);
  const targetZoom = clamp(Number(target.zoom) || 1.05, 1, 2.2);

  let progress = localProgress(frame, duration, beat.easing);
  if (isHold) {
    progress = interpolate(frame, [0, duration], [0.08, 0.18], {
      easing: Easing.inOut(Easing.quad),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  if (isRapidCrop) {
    progress = interpolate(frame, [0, duration * 0.38, duration], [0, 1, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  const springSettle = spring({
    frame: Math.max(0, frame - Math.min(6, duration * 0.12)),
    fps,
    config: { damping: 24, mass: 0.7, stiffness: 90 },
    durationInFrames: Math.max(1, Math.round(duration * 0.4)),
  });
  if (beat.role === "emotion" || isTinyPush) {
    progress = clamp(progress * 0.72 + springSettle * 0.28, 0, 1);
  }

  let startZoom = targetZoom - 0.05;
  let endZoom = targetZoom;
  if (isPullBack) {
    startZoom = targetZoom + 0.12;
    endZoom = targetZoom;
  }
  if (isRapidCrop) {
    startZoom = Math.max(1, targetZoom - 0.18);
    endZoom = targetZoom + 0.04;
  }
  if (isHold) {
    startZoom = Math.max(1, targetZoom - 0.01);
    endZoom = targetZoom;
  }

  let startX = clamp(target.x, 0, 1);
  let endX = clamp(target.x, 0, 1);
  if (isLateral) {
    const rightward = /向右|右侧|to the right|right/i.test(motion);
    const leftward = /向左|左侧|to the left|left/i.test(motion);
    if (rightward) startX = clamp(target.x - 0.055, 0, 1);
    if (leftward) startX = clamp(target.x + 0.055, 0, 1);
    if (!rightward && !leftward) startX = clamp(target.x - 0.035, 0, 1);
  }

  return {
    x: interpolate(progress, [0, 1], [startX, endX], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    y: interpolate(progress, [0, 1], [target.y + (isHold ? 0 : 0.018), target.y], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    zoom: interpolate(progress, [0, 1], [startZoom, endZoom], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  };
}

function AnimatedText({
  text,
  delay = 0,
  stagger = 1.25,
  animation = "rise",
  style = {},
}: {
  text: string;
  delay?: number;
  stagger?: number;
  animation?: "rise" | "wipe" | "scale" | "type";
  style?: Record<string, string | number>;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const characters = Array.from(text);
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "center", maxWidth: "100%", whiteSpace: "normal", ...style }}>
      {characters.map((character, index) => {
        const localFrame = Math.max(0, frame - delay - index * stagger);
        const enter = spring({
          frame: localFrame,
          fps,
          config: { damping: 22, mass: 0.55, stiffness: 180 },
          durationInFrames: 18,
        });
        const translateX = animation === "wipe" || animation === "type" ? (1 - enter) * 22 : 0;
        const translateY = animation === "rise" ? (1 - enter) * 22 : 0;
        const scale = animation === "scale" ? 0.78 + enter * 0.22 : 1;
        return (
          <span
            key={`${character}-${index}`}
            style={{
              display: "inline-block",
              opacity: enter,
              transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`,
              transformOrigin: "center bottom",
            }}
          >
            {character === " " ? "\u00a0" : character}
          </span>
        );
      })}
    </span>
  );
}

function CameraPlate({ imageUrl, beat }: { imageUrl: string; beat: EditBeat }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const duration = Math.max(1, Math.round((beat.end - beat.start) * fps));
  const camera = semanticMotion(beat, frame, fps, duration);
  const seed = stableHash(beat.id);
  const actionMotion = /action|follow|pan|横移|跟拍/i.test(`${beat.role} ${beat.motion}`);
  const impactMotion = beat.role === "impact" || /impact|sharp|hard cut/i.test(beat.motion);
  const movementEnvelope = impactMotion
    ? interpolate(frame, [0, 2, 8, duration], [1, 0.62, 0.12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : actionMotion
      ? interpolate(frame, [0, duration * 0.18, duration], [0, 1, 0.35], { easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : interpolate(frame, [0, duration], [0.24, 0.16], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const shakeX = Math.sin(frame * 0.68 + (seed % 19)) * (impactMotion ? 9 : 1.8) * movementEnvelope;
  const shakeY = Math.cos(frame * 0.53 + (seed % 13)) * (impactMotion ? 6 : 1.1) * movementEnvelope;
  const driftX = actionMotion ? Math.sin(frame * 0.12 + (seed % 11)) * 3.2 * movementEnvelope : 0;
  const rotation = Math.sin(frame * 0.1 + (seed % 7)) * (impactMotion ? 0.42 : actionMotion ? 0.12 : 0.04) * movementEnvelope;
  const maxDx = width * Math.max(0, camera.zoom - 1) * 0.5;
  const maxDy = height * Math.max(0, camera.zoom - 1) * 0.5;
  const dx = clamp((0.5 - camera.x) * width * camera.zoom + driftX + shakeX, -maxDx - 12, maxDx + 12);
  const dy = clamp((0.5 - camera.y) * height * camera.zoom + shakeY, -maxDy - 10, maxDy + 10);
  const filter = beat.role === "impact"
    ? "contrast(1.12) saturate(1.16) brightness(0.92)"
      : beat.role === "emotion"
        ? "contrast(1.04) saturate(0.9) brightness(0.94)"
        : "contrast(1.05) saturate(1.03) brightness(0.95)";

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#0b0c0d" }}>
      <Img
        src={imageUrl}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translate3d(${dx}px, ${dy}px, 0) scale(${camera.zoom}) rotate(${rotation}deg)`,
          transformOrigin: "center center",
          filter,
        }}
      />
    </AbsoluteFill>
  );
}

function StockBrollClip({ item, durationInFrames }: { item: StockBroll; durationInFrames: number }) {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, Math.min(12, durationInFrames / 4), Math.max(1, durationInFrames - 14), durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const drift = Math.sin(frame * 0.025 + stableHash(item.videoId) % 13) * 0.8;
  const video = <OffthreadVideo src={item.videoUrl} muted volume={0} playbackRate={0.96} style={{ position: "absolute", inset: "-5%", width: "110%", height: "110%", objectFit: "cover", filter: "saturate(0.78) contrast(1.06) brightness(0.86)", transform: `scale(1.03) translate3d(${drift}%, 0, 0)` }} />;
  const opacity = fade * (item.opacity ?? 0.96);
  if (item.presentation === "inset-cutaway") {
    return <AbsoluteFill style={{ opacity, pointerEvents: "none", zIndex: 14 }}>
      <div style={{ position: "absolute", top: 76, right: 52, bottom: 138, width: "36%", overflow: "hidden", border: "1px solid rgba(247,235,205,0.64)", boxShadow: "0 16px 38px rgba(0,0,0,0.36)", backgroundColor: "#141716" }}>
        {video}
        <div style={{ position: "absolute", inset: 0, border: "10px solid rgba(7,10,10,0.16)" }} />
      </div>
    </AbsoluteFill>;
  }
  return <AbsoluteFill style={{ opacity, mixBlendMode: item.blendMode === "normal" ? "normal" : item.blendMode ?? "screen", overflow: "hidden", pointerEvents: "none", zIndex: 2 }}>
    {video}
  </AbsoluteFill>;
}

function StockBrollLayer({ items, shotDurationInFrames, primary = false }: { items: StockBroll[]; shotDurationInFrames: number; primary?: boolean }) {
  const { fps } = useVideoConfig();
  return <>
    {items.map((item, index) => {
      if (!item.videoUrl || !item.localPath) return null;
      const from = Math.max(0, Math.round(item.startFrame ?? 0));
      const sourceFrames = item.duration ? Math.max(1, Math.round(item.duration * fps)) : shotDurationInFrames;
      const requestedEnd = item.endFrame ?? from + sourceFrames;
      const durationInFrames = Math.max(1, Math.min(shotDurationInFrames - from, Math.round(requestedEnd - from)));
      if (from >= shotDurationInFrames || durationInFrames <= 0) return null;
      const renderItem = primary ? { ...item, presentation: "full-frame" as const, opacity: Math.max(0.96, item.opacity ?? 0.96) } : item;
      return <Sequence key={`${item.provider}-${item.videoId}-${index}`} from={from} durationInFrames={durationInFrames} premountFor={2}><StockBrollClip item={renderItem} durationInFrames={durationInFrames} /></Sequence>;
    })}
  </>;
}

function CaptionOverlay({ shot }: { shot: ShowcaseShot }) {
  const frame = useCurrentFrame();
  const active = shot.captionSegments?.find((segment) => frame >= segment.startFrame && frame < segment.endFrame);
  if (!active?.text) return null;
  const fade = interpolate(frame, [active.startFrame, active.startFrame + 5, active.endFrame - 8, active.endFrame], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 94, right: 94, bottom: 42, display: "flex", justifyContent: "center", opacity: fade, fontFamily: FONT, zIndex: 40 }}>
      <div style={{ boxSizing: "border-box", width: "min(88%, 1080px)", maxHeight: 126, overflow: "hidden", padding: "12px 24px 13px", backgroundColor: "rgba(9,10,10,0.76)", borderLeft: `3px solid ${GOLD}`, boxShadow: "0 9px 30px rgba(0,0,0,0.26)", transform: `translateY(${(1 - fade) * 8}px)` }}>
        <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", overflowWrap: "anywhere", wordBreak: "break-all", color: "#fff9ee", fontSize: 28, lineHeight: 1.42, letterSpacing: "0.02em", textAlign: "center", textShadow: "0 2px 8px rgba(0,0,0,0.65)" }}>
          <AnimatedText text={active.text} delay={active.startFrame} stagger={0.55} animation="rise" />
        </span>
      </div>
    </div>
  );
}

function AnimatedRule({ width = 120, delay = 0 }: { width?: number; delay?: number }) {
  const frame = useCurrentFrame();
  const enter = spring({ frame: Math.max(0, frame - delay), fps: 30, config: { damping: 24, mass: 0.6, stiffness: 150 }, durationInFrames: 20 });
  return <div style={{ width: width * enter, height: 2, backgroundColor: GOLD }} />;
}

function GraphicOverlay({ graphic }: { graphic: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps: 30, config: { damping: 18, mass: 0.7, stiffness: 100 }, durationInFrames: Math.min(24, durationInFrames) });
  const fade = interpolate(frame, [0, 10, durationInFrames - 14, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = clamp(enter * fade, 0, 1);
  const labelStyle = { fontFamily: FONT, color: PAPER, textShadow: "0 2px 10px rgba(0,0,0,0.65)" };
  const shell = (children: React.ReactNode, style: Record<string, string | number> = {}) => <div style={{ position: "absolute", opacity, ...labelStyle, ...style }}>{children}</div>;

  if (graphic === "opening") {
    return shell(<><div style={{ fontSize: 19, color: GOLD, letterSpacing: "0.16em" }}><AnimatedText text="时间回望" animation="wipe" /></div><div style={{ marginTop: 8, fontFamily: SERIF, fontSize: 68, letterSpacing: "0.08em" }}><AnimatedText text="170年前" delay={7} animation="scale" /></div><div style={{ marginTop: 7, fontSize: 18, opacity: 0.78 }}><AnimatedText text="太平天国 · 1850年代" delay={15} animation="rise" /></div><div style={{ marginTop: 15 }}><AnimatedRule delay={20} /></div></>, { left: 74, bottom: 170 });
  }
  if (graphic === "question") {
    return <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", opacity, ...labelStyle }}><div style={{ textAlign: "center", transform: `scale(${0.94 + enter * 0.06})` }}><div style={{ fontSize: 18, letterSpacing: "0.28em", color: GOLD }}><AnimatedText text="核心追问" animation="wipe" /></div><div style={{ marginTop: 12, fontFamily: SERIF, fontSize: 78, letterSpacing: "0.04em" }}><AnimatedText text="为何偏偏是 1850？" delay={8} animation="scale" /></div><div style={{ margin: "19px auto 0" }}><AnimatedRule delay={22} /></div></div></div>;
  }
  if (graphic === "year") {
    return shell(<><div style={{ fontSize: 20, letterSpacing: "0.16em", color: GOLD }}><AnimatedText text="1840" animation="scale" /></div><div style={{ marginTop: 6, fontSize: 25, fontFamily: SERIF }}><AnimatedText text="鸦片战争" delay={6} animation="rise" /></div><div style={{ marginTop: 8 }}><AnimatedRule width={94} delay={15} /></div></>, { top: 106, right: 74, textAlign: "right" });
  }
  if (graphic === "rulers" || graphic === "triptych") return null;
  if (graphic === "population") {
    const bar = interpolate(frame, [0, durationInFrames * 0.6], [0, 86], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return shell(<><div style={{ fontSize: 17, letterSpacing: "0.15em", color: GOLD }}><AnimatedText text="1850年代 · 全国人口" animation="wipe" /></div><div style={{ marginTop: 5, fontSize: 96, fontWeight: 600, lineHeight: 1 }}><AnimatedText text="4.3" delay={8} animation="scale" /><span style={{ fontSize: 44 }}>亿</span></div><div style={{ marginTop: 13, height: 5, backgroundColor: "rgba(255,255,255,0.22)" }}><div style={{ width: `${bar}%`, height: "100%", backgroundColor: GOLD }} /></div><div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14, opacity: 0.76 }}><span><AnimatedText text="人多" delay={17} /></span><span><AnimatedText text="地不多" delay={20} /></span></div><div style={{ marginTop: 13, display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 5 }}>{Array.from({ length: 50 }).map((_, index) => <span key={index} style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: index < Math.round(bar / 2) ? GOLD : "rgba(255,255,255,0.25)" }} />)}</div></>, { top: 104, right: 66, width: 310 });
  }
  if (graphic === "land") {
    return shell(<><div style={{ fontSize: 17, letterSpacing: "0.14em", color: GOLD }}><AnimatedText text="1833年 · 人均耕地" animation="wipe" /></div><div style={{ marginTop: 4, fontSize: 84, fontFamily: SERIF, lineHeight: 1 }}><AnimatedText text="1.86" delay={8} animation="scale" /> <span style={{ fontSize: 31 }}>亩</span></div><div style={{ marginTop: 9, fontSize: 19, opacity: 0.84 }}><AnimatedText text="地不够种，大量农民失地" delay={18} /></div></>, { left: 72, bottom: 170 });
  }
  if (graphic === "compare") {
    return <div style={{ position: "absolute", inset: 0, opacity, ...labelStyle }}><div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, backgroundColor: "rgba(228,184,93,0.72)" }} /><div style={{ position: "absolute", left: 62, top: 105, fontSize: 22, color: GOLD }}><AnimatedText text="洪水" animation="wipe" /></div><div style={{ position: "absolute", right: 62, top: 105, fontSize: 22, color: GOLD, textAlign: "right" }}><AnimatedText text="旱灾" delay={8} animation="wipe" /></div><div style={{ position: "absolute", left: 62, right: 62, bottom: 170, display: "flex", justifyContent: "space-between", fontSize: 15, opacity: 0.78 }}><AnimatedText text="长江流域" delay={12} /><AnimatedText text="黄河流域" delay={17} /></div></div>;
  }
  if (graphic === "tunnel") {
    const line = interpolate(frame, [0, durationInFrames * 0.78], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return shell(<><div style={{ fontSize: 17, letterSpacing: "0.14em", color: GOLD }}><AnimatedText text="攻城战术" animation="wipe" /></div><div style={{ marginTop: 9, height: 2, backgroundColor: "rgba(255,255,255,0.28)" }}><div style={{ width: `${line}%`, height: "100%", backgroundColor: GOLD }} /></div><div style={{ marginTop: 8, fontSize: 18, opacity: 0.8 }}><AnimatedText text="地道 · 火药 · 城墙" delay={10} /></div></>, { left: 68, right: 68, bottom: 158 });
  }
  if (graphic === "trade") {
    const line = interpolate(frame, [0, durationInFrames * 0.72], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return shell(<><div style={{ display: "flex", justifyContent: "space-between", fontSize: 19 }}><AnimatedText text="广州港" animation="wipe" /><AnimatedText text="世界市场" delay={8} animation="wipe" /></div><div style={{ marginTop: 16, position: "relative", height: 3, backgroundColor: "rgba(255,255,255,0.25)" }}><div style={{ width: `${line}%`, height: "100%", backgroundColor: GOLD }} /><div style={{ position: "absolute", left: `${line}%`, top: -5, width: 12, height: 12, borderRadius: "50%", backgroundColor: GOLD }} /></div><div style={{ marginTop: 8, textAlign: "center", fontSize: 15, opacity: 0.8 }}><AnimatedText text="茶叶 · 丝绸 · 瓷器" delay={15} /></div></>, { left: 70, right: 70, top: 108 });
  }
  if (graphic === "flow") {
    const flow = interpolate(frame, [0, durationInFrames * 0.7], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return shell(<><div style={{ display: "flex", justifyContent: "space-between", fontSize: 18 }}><AnimatedText text="英国工业革命" animation="wipe" /><span style={{ color: GOLD }}><AnimatedText text="白银流向中国" delay={9} animation="wipe" /></span></div><div style={{ marginTop: 10, height: 4, backgroundColor: "rgba(255,255,255,0.24)" }}><div style={{ width: `${flow}%`, height: "100%", backgroundColor: GOLD }} /></div></>, { left: 70, right: 70, bottom: 170 });
  }
  return null;
}

function LayeredCharacterSequence({ cards }: { cards: CharacterCard[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {cards.map((card, index) => {
        // The independent pipeline marks only BiRefNet-verified RGBA assets
        // as renderable. This guard keeps legacy/full-frame character props
        // from bypassing the producer contract.
        if (card.requiresAlpha !== true) return null;
        const enter = spring({ frame: Math.max(0, frame - card.startFrame), fps, config: { damping: 22, mass: 0.72, stiffness: 120 }, durationInFrames: 24 });
        const exit = interpolate(frame, [card.endFrame - 14, card.endFrame + 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const visible = frame >= card.startFrame - 2 && frame <= card.endFrame + 4;
        if (!visible) return null;
        const direction = index % 2 === 0 ? -1 : 1;
        const x = card.x ?? (0.48 + index * 0.17);
        const y = card.y ?? 0.04;
        const scale = card.scale ?? (0.76 - Math.min(index, 2) * 0.06);
        const lift = (1 - enter) * 30;
        const slide = direction * (1 - enter) * 46;
        const breathe = 1 + Math.sin(frame * 0.055 + index * 1.7) * 0.008;
        return (
          <div
            key={card.key}
            style={{
              position: "absolute",
              left: `${x * 100}%`,
              bottom: `${y * 100}%`,
              width: `${scale * 100}%`,
              height: "92%",
              zIndex: card.zIndex ?? 20 + index,
              opacity: clamp(enter * exit, 0, 1),
              transform: `translate3d(${slide}px, ${lift}px, 0) scale(${breathe})`,
              transformOrigin: "center bottom",
              pointerEvents: "none",
            }}
          >
            <Img
              src={card.imageUrl}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                objectPosition: "center bottom",
                filter: "drop-shadow(0 18px 22px rgba(0,0,0,0.34)) contrast(1.04) saturate(0.94)",
              }}
            />
            <div style={{ position: "absolute", left: "50%", bottom: 22, transform: "translateX(-50%)", whiteSpace: "nowrap", fontFamily: FONT, color: PAPER, fontSize: 20, textShadow: "0 2px 8px rgba(0,0,0,0.72)" }}>
              <AnimatedText text={card.name} delay={card.startFrame + 8} animation="wipe" />
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

type StoryActionCode =
  | "hook_control"
  | "rail_data"
  | "network_capture"
  | "court_order"
  | "split_share"
  | "theme_cycle";

function StoryCharacter({
  card,
  action,
}: {
  card: CharacterCard;
  action: StoryActionCode;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: Math.max(0, frame - (card.startFrame ?? 0)),
    fps,
    config: { damping: 24, mass: 0.7, stiffness: 130 },
    durationInFrames: 26,
  });
  const endFrame = card.endFrame || Number.MAX_SAFE_INTEGER;
  const exit = interpolate(frame, [endFrame - 12, endFrame + 3], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const visible = frame >= (card.startFrame ?? 0) - 2 && frame <= endFrame + 3;
  if (!visible || card.requiresAlpha !== true) return null;

  const direction = action === "court_order" ? -1 : 1;
  const x = card.x ?? 0.04;
  const y = card.y ?? 0.02;
  const scale = card.scale ?? 0.58;
  const actionSway = action === "rail_data" || action === "network_capture"
    ? Math.sin(frame * 0.08) * 2.2
    : action === "theme_cycle"
      ? Math.sin(frame * 0.045) * 1.1
      : 0;
  const lift = (1 - enter) * 28;
  const slide = direction * (1 - enter) * 48;
  const opacity = clamp(enter * exit, 0, 1);

  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        bottom: `${y * 100}%`,
        width: `${scale * 100}%`,
        height: "93%",
        zIndex: card.zIndex ?? 22,
        opacity,
        transform: `translate3d(${slide + actionSway}px, ${lift}px, 0)`,
        transformOrigin: "center bottom",
        pointerEvents: "none",
      }}
    >
      <Img
        src={card.imageUrl}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "center bottom",
          filter: "drop-shadow(0 20px 24px rgba(0,0,0,0.42)) contrast(1.05) saturate(0.92)",
        }}
      />
    </div>
  );
}

function EvidenceShell({
  title,
  subtitle,
  children,
  style = {},
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  style?: Record<string, string | number>;
}) {
  return (
    <div
      style={{
        position: "absolute",
        right: 48,
        top: 64,
        width: 610,
        minHeight: 360,
        boxSizing: "border-box",
        padding: "22px 24px 20px",
        border: "1px solid rgba(242,220,172,0.62)",
        background: "rgba(20,24,23,0.78)",
        boxShadow: "0 20px 44px rgba(0,0,0,0.28)",
        color: PAPER,
        fontFamily: FONT,
        zIndex: 24,
        ...style,
      }}
    >
      <div style={{ color: GOLD, fontSize: 15, letterSpacing: "0.16em" }}>{title}</div>
      {subtitle && <div style={{ marginTop: 7, color: "rgba(255,249,236,0.72)", fontSize: 16 }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function StoryActionLabel({
  text,
  left,
  top,
  opacity = 1,
  accent = GOLD,
}: {
  text: string;
  left: number;
  top: number;
  opacity?: number;
  accent?: string;
}) {
  return (
    <div style={{ position: "absolute", left, top, opacity, color: PAPER, fontFamily: FONT, fontSize: 18, zIndex: 28, whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-block", width: 8, height: 8, marginRight: 10, borderRadius: "50%", background: accent, boxShadow: `0 0 14px ${accent}` }} />
      {text}
    </div>
  );
}

function HookControlVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps: 30, config: { damping: 24, mass: 0.7, stiffness: 130 }, durationInFrames: 22 });
  const loss = interpolate(frame, [0, durationInFrames * 0.42], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const system = interpolate(frame, [durationInFrames * 0.35, durationInFrames * 0.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="败局的入口" subtitle="不是输给对手，而是先把对手变成数据">
        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1fr 52px 1fr", alignItems: "center", gap: 12 }}>
          <div style={{ padding: "18px 16px", border: "1px solid rgba(231,139,111,0.62)", background: "rgba(101,47,38,0.34)", opacity: 1 - loss * 0.52 }}>
            <div style={{ color: "#efad92", fontSize: 14, letterSpacing: "0.12em" }}>对手</div>
            <div style={{ marginTop: 13, fontFamily: SERIF, fontSize: 30 }}>运输成本</div>
            <div style={{ marginTop: 12, height: 4, background: "rgba(255,255,255,0.22)" }}><div style={{ width: `${(1 - loss) * 100}%`, height: "100%", background: "#d9775b" }} /></div>
          </div>
          <div style={{ textAlign: "center", color: "#e99a79", fontSize: 22, opacity: 0.9 }}>×</div>
          <div style={{ padding: "18px 16px", border: `1px solid rgba(230,184,94,${0.45 + system * 0.45})`, background: "rgba(112,81,31,0.28)", transform: `translateY(${(1 - system) * 10}px)`, opacity: 0.72 + system * 0.28 }}>
            <div style={{ color: GOLD, fontSize: 14, letterSpacing: "0.12em" }}>洛克菲勒</div>
            <div style={{ marginTop: 13, fontFamily: SERIF, fontSize: 30 }}>标准石油</div>
            <div style={{ marginTop: 12, height: 4, background: "rgba(255,255,255,0.22)" }}><div style={{ width: `${system * 100}%`, height: "100%", background: GOLD }} /></div>
          </div>
        </div>
        <div style={{ marginTop: 34, color: "rgba(255,249,236,0.78)", fontSize: 17, lineHeight: 1.55, opacity: enter }}>
          先控制运输和信息，才有资格谈“赢”。
        </div>
      </EvidenceShell>
      <StoryActionLabel text="控制先于竞争" left={650} top={500} opacity={enter} />
    </AbsoluteFill>
  );
}

function RailDataVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [10, durationInFrames * 0.84], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const packet = interpolate(progress, [0, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="铁路折扣与运输数据" subtitle="一个协议，同时改变价格和视野" style={{ width: 568 }}>
        <div style={{ position: "relative", height: 276, marginTop: 22 }}>
          <div style={{ position: "absolute", left: 10, top: 22, width: 176, padding: "16px 14px", border: "1px solid rgba(227,215,185,0.5)", background: "rgba(241,229,201,0.12)" }}>
            <div style={{ color: GOLD, fontSize: 14 }}>铁路公司</div>
            <div style={{ marginTop: 12, fontFamily: SERIF, fontSize: 25 }}>运价表</div>
            <div style={{ marginTop: 13, color: "#f0b089", fontSize: 24 }}>折扣 −20%</div>
          </div>
          <svg viewBox="0 0 520 276" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <path d="M 190 100 C 270 38, 338 38, 395 104" fill="none" stroke={GOLD} strokeWidth="3" strokeDasharray="1" strokeDashoffset={1 - packet} pathLength="1" opacity="0.88" />
            <circle cx={190 + packet * 205} cy={100 - Math.sin(packet * Math.PI) * 55} r="7" fill="#fff2cb" stroke={GOLD} strokeWidth="3" opacity={packet > 0.04 ? 1 : 0} />
          </svg>
          <div style={{ position: "absolute", right: 2, top: 86, width: 222, padding: "16px 14px", border: `1px solid rgba(230,184,94,${0.5 + progress * 0.42})`, background: "rgba(112,81,31,0.28)", transform: `translateY(${(1 - progress) * 18}px)` }}>
            <div style={{ color: GOLD, fontSize: 14 }}>洛克菲勒的账本</div>
            <div style={{ marginTop: 12, fontFamily: SERIF, fontSize: 24 }}>竞争对手运输数据</div>
            <div style={{ marginTop: 12, display: "flex", gap: 7, alignItems: "end", height: 42 }}>
              {[0.35, 0.58, 0.78, 0.95].map((height, index) => <span key={index} style={{ width: 24, height: `${height * 100}%`, background: index < Math.ceil(progress * 4) ? GOLD : "rgba(255,255,255,0.2)" }} />)}
            </div>
          </div>
        </div>
        <div style={{ color: "rgba(255,249,236,0.78)", fontSize: 16, lineHeight: 1.5 }}>折扣降低成本，数据提前暴露对手的路线和弱点。</div>
      </EvidenceShell>
      <StoryActionLabel text="信息流入账本" left={684} top={500} opacity={0.75 + progress * 0.25} />
    </AbsoluteFill>
  );
}

function NetworkCaptureVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [8, durationInFrames * 0.86], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const nodes = ["管线", "炼油厂", "仓储", "销售网络"];
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="一层层收进体系" subtitle="不是一个工厂，而是一条能自我闭合的链" style={{ width: 620 }}>
        <div style={{ position: "relative", height: 300, marginTop: 20 }}>
          <svg viewBox="0 0 570 300" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            {nodes.map((label, index) => {
              const x = 60 + (index % 2) * 260;
              const y = 28 + Math.floor(index / 2) * 132;
              const nodeProgress = clamp(progress * nodes.length - index, 0, 1);
              const lineProgress = clamp(progress * nodes.length - index - 0.28, 0, 1);
              return (
                <g key={label} opacity={0.42 + nodeProgress * 0.58}>
                  <path d={`M 284 151 C ${x + 100} ${y + 56}, ${x + 84} ${y + 56}, ${x + 84} ${y + 56}`} fill="none" stroke={GOLD} strokeWidth="2.5" strokeDasharray="1" strokeDashoffset={1 - lineProgress} pathLength="1" opacity={lineProgress} />
                  <rect x={x} y={y} width="168" height="60" rx="3" fill={nodeProgress > 0.25 ? "rgba(110,80,34,0.44)" : "rgba(255,255,255,0.07)"} stroke={nodeProgress > 0.25 ? GOLD : "rgba(255,255,255,0.28)"} strokeWidth="1.5" />
                  <text x={x + 18} y={y + 28} fill="#fff7e7" fontSize="19" fontFamily={FONT}>{label}</text>
                  <text x={x + 18} y={y + 48} fill={nodeProgress > 0.25 ? GOLD : "rgba(255,255,255,0.52)"} fontSize="13" fontFamily={FONT}>{nodeProgress > 0.78 ? "已纳入" : "待纳入"}</text>
                </g>
              );
            })}
            <rect x="216" y="123" width="136" height="58" rx="3" fill="rgba(19,28,27,0.92)" stroke={GOLD} strokeWidth="2" />
            <text x="284" y="158" textAnchor="middle" fill={GOLD} fontSize="18" fontFamily={FONT}>标准石油体系</text>
          </svg>
        </div>
        <div style={{ color: "rgba(255,249,236,0.78)", fontSize: 16 }}>每收进一个节点，下一节点的成本和信息都更可控。</div>
      </EvidenceShell>
      <StoryActionLabel text="资产进入同一套规则" left={694} top={505} opacity={0.78 + progress * 0.22} />
    </AbsoluteFill>
  );
}

function CourtOrderVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = spring({ frame: Math.max(0, frame - 10), fps: 30, config: { damping: 22, mass: 0.72, stiffness: 125 }, durationInFrames: 28 });
  const cut = interpolate(frame, [durationInFrames * 0.46, durationInFrames * 0.58], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="1911 · 最高法院拆解令" subtitle="法律第一次把手伸进这张网络" style={{ width: 560, minHeight: 382 }}>
        <div style={{ position: "relative", height: 250, marginTop: 22 }}>
          <div style={{ position: "absolute", left: 18, right: 18, top: 12, padding: "22px 22px", background: "#f2e6c9", color: "#312c25", transform: `translateY(${(1 - enter) * -40}px) rotate(${(1 - enter) * -2.5}deg)`, opacity: enter, boxShadow: "0 14px 24px rgba(0,0,0,0.25)" }}>
            <div style={{ fontFamily: SERIF, fontSize: 29 }}>最高法院</div>
            <div style={{ marginTop: 15, fontSize: 18 }}>命令拆解标准石油</div>
            <div style={{ marginTop: 16, height: 2, background: "rgba(49,44,37,0.35)" }} />
            <div style={{ marginTop: 13, fontSize: 14, opacity: 0.7 }}>帝国的统一结构，至此被写进判决。</div>
            <div style={{ position: "absolute", right: 18, bottom: 16, padding: "5px 9px", border: "2px solid #a74838", color: "#a74838", fontSize: 16, transform: "rotate(-8deg)", opacity: cut }}>拆 解</div>
          </div>
          <div style={{ position: "absolute", left: 20, right: 20, bottom: 18, height: 3, background: `rgba(227,119,92,${cut})`, transform: `scaleX(${cut})`, transformOrigin: "left", boxShadow: `0 0 18px rgba(227,119,92,${cut * 0.85})` }} />
        </div>
        <div style={{ color: "rgba(255,249,236,0.8)", fontSize: 16 }}>看起来，帝国终于被法律击碎了。</div>
      </EvidenceShell>
      <StoryActionLabel text="判决改变了结构" left={692} top={520} opacity={0.72 + cut * 0.28} accent="#e27a5c" />
    </AbsoluteFill>
  );
}

function SplitShareVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const split = interpolate(frame, [10, durationInFrames * 0.52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const wealth = interpolate(frame, [durationInFrames * 0.5, durationInFrames * 0.88], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const companies = ["炼油公司", "铁路公司", "管线公司", "销售公司"];
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="拆成三十多家公司" subtitle="结构被拆开，所有权却没有消失" style={{ width: 620 }}>
        <div style={{ position: "relative", height: 290, marginTop: 18 }}>
          <svg viewBox="0 0 570 290" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <path d="M 285 72 C 285 120, 120 150, 95 225 M 285 72 C 285 120, 205 150, 205 225 M 285 72 C 285 120, 365 150, 365 225 M 285 72 C 285 120, 450 150, 475 225" fill="none" stroke={GOLD} strokeWidth="2.2" strokeDasharray="1" strokeDashoffset={1 - split} pathLength="1" opacity={split} />
            <rect x="201" y="22" width="168" height="62" rx="3" fill="rgba(104,76,29,0.55)" stroke={GOLD} strokeWidth="2" opacity={1 - split * 0.68} />
            <text x="285" y="59" textAnchor="middle" fill="#fff7e7" fontSize="20" fontFamily={FONT}>标准石油</text>
            {companies.map((label, index) => {
              const x = [10, 120, 280, 390][index];
              const y = 208 + (1 - split) * 42;
              const companyOpacity = interpolate(split, [0.12 + index * 0.09, 0.44 + index * 0.09], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
              return <g key={label} opacity={companyOpacity}><rect x={x} y={y} width="100" height="48" rx="3" fill="rgba(27,34,31,0.9)" stroke="#d9a653" strokeWidth="1.5" /><text x={x + 50} y={y + 29} textAnchor="middle" fill="#fff5dd" fontSize="14" fontFamily={FONT}>{label}</text></g>;
            })}
            <circle cx="285" cy="266" r="12" fill="#f6e5b9" stroke={GOLD} strokeWidth="3" opacity={wealth} />
            <path d="M 285 251 V 227" stroke={GOLD} strokeWidth="2.5" strokeDasharray="1" strokeDashoffset={1 - wealth} pathLength="1" opacity={wealth} />
          </svg>
          <div style={{ position: "absolute", left: "50%", bottom: 0, transform: "translateX(-50%)", color: GOLD, fontSize: 15, opacity: wealth }}>洛克菲勒持有股份</div>
        </div>
        <div style={{ color: "rgba(255,249,236,0.82)", fontSize: 17 }}>法律拆掉的是公司外壳，不是他手里的所有权。</div>
      </EvidenceShell>
      <StoryActionLabel text="帝国解体，财富重估" left={682} top={515} opacity={0.74 + wealth * 0.26} />
    </AbsoluteFill>
  );
}

function ThemeCycleVisual() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [8, durationInFrames * 0.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const steps = [
    { title: "效率", detail: "降低成本", color: "#d9a653" },
    { title: "规模", detail: "统一节点", color: "#c68b58" },
    { title: "规则", detail: "控制行业", color: "#9cba9b" },
  ];
  return (
    <AbsoluteFill style={{ zIndex: 24, pointerEvents: "none" }}>
      <EvidenceShell title="真正值得看的因果链" subtitle="效率变成武器，规模变成规则，规则最终反过来审判它" style={{ width: 650 }}>
        <div style={{ position: "relative", marginTop: 32, height: 180 }}>
          <svg viewBox="0 0 600 180" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <path d="M 88 86 H 500" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2" />
            <path d="M 88 86 H 500" fill="none" stroke={GOLD} strokeWidth="3" strokeDasharray="1" strokeDashoffset={1 - progress} pathLength="1" />
            <path d="M 500 86 C 540 86, 540 144, 425 153 C 292 164, 200 158, 130 126" fill="none" stroke="#df8063" strokeWidth="2.6" strokeDasharray="7 8" opacity={progress > 0.7 ? (progress - 0.7) / 0.3 : 0} />
          </svg>
          {steps.map((step, index) => {
            const local = clamp(progress * 3 - index, 0, 1);
            const x = [8, 210, 412][index];
            return <div key={step.title} style={{ position: "absolute", left: x, top: 32 - local * 8, width: 152, opacity: 0.56 + local * 0.44, padding: "15px 14px", border: `1px solid ${step.color}`, background: "rgba(23,29,27,0.9)", boxShadow: local > 0.5 ? `0 0 24px ${step.color}33` : "none" }}><div style={{ color: step.color, fontFamily: SERIF, fontSize: 26 }}>{step.title}</div><div style={{ marginTop: 8, color: "rgba(255,249,236,0.75)", fontSize: 15 }}>{step.detail}</div></div>;
          })}
        </div>
        <div style={{ marginTop: 10, color: "#e18a6d", fontSize: 16, opacity: progress > 0.68 ? (progress - 0.68) / 0.32 : 0 }}>规则反过来审判</div>
      </EvidenceShell>
      <StoryActionLabel text="同一套能力，也制造了审判它的理由" left={650} top={508} opacity={0.68 + progress * 0.32} accent="#df8063" />
    </AbsoluteFill>
  );
}

function StoryActionLayer({ shot }: { shot: ShowcaseShot }) {
  const action = (shot.storyAction || "") as StoryActionCode;
  const card = shot.characters?.[0];
  const visual = action === "hook_control"
    ? <HookControlVisual />
    : action === "rail_data"
      ? <RailDataVisual />
      : action === "network_capture"
        ? <NetworkCaptureVisual />
        : action === "court_order"
          ? <CourtOrderVisual />
          : action === "split_share"
            ? <SplitShareVisual />
            : action === "theme_cycle"
              ? <ThemeCycleVisual />
              : null;
  if (!visual && !card) return null;
  return <>{card && <StoryCharacter card={card} action={action || "network_capture"} />}{visual}</>;
}

type Point = { x: number; y: number };

function projectGeo({ lon, lat }: { lon: number; lat: number }): Point {
  return {
    x: chinaMapBounds.left + ((lon - chinaMapBounds.minLon) / (chinaMapBounds.maxLon - chinaMapBounds.minLon)) * chinaMapBounds.width,
    y: chinaMapBounds.top + ((chinaMapBounds.maxLat - lat) / (chinaMapBounds.maxLat - chinaMapBounds.minLat)) * chinaMapBounds.height,
  };
}

function pointAlong(points: Point[], progress: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const scaled = clamp(progress, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  return { x: points[index].x + (points[index + 1].x - points[index].x) * local, y: points[index].y + (points[index + 1].y - points[index].y) * local };
}

function pointsPath(points: Point[]) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function MigrationMapScene({ map, sceneId }: { map: MigrationMap; sceneId: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const seaId = `migration-${sceneId}-sea`;
  const paperId = `migration-${sceneId}-paper`;
  const shadowId = `migration-${sceneId}-shadow`;
  const routeProgress = interpolate(frame, [18, durationInFrames * 0.72], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cameraProgress = interpolate(frame, [0, durationInFrames * 0.3, durationInFrames], [0, 1, 0.72], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const locations = new Map(map.locations.map((location) => [location.id, location]));
  const primaryRoute = map.routes[0];
  const from = primaryRoute ? locations.get(primaryRoute.from) : undefined;
  const to = primaryRoute ? locations.get(primaryRoute.to) : undefined;
  const routeLocations = [from, to].filter(Boolean) as MapLocation[];
  const route = primaryRoute && from && to
    ? [from, ...(primaryRoute.waypoints ?? []).map((point) => ({ ...point, id: "waypoint", label: "", coordinateSource: "illustrative" })), to].map(projectGeo)
    : map.locations.map(projectGeo);
  const moving = pointAlong(route, routeProgress);
  const zoom = 1.05 + cameraProgress * 0.12;
  const mapX = -24 - cameraProgress * 48;
  const mapY = -8 - cameraProgress * 28;
  const titleEnter = spring({ frame, fps: 30, config: { damping: 20, mass: 0.7, stiffness: 120 }, durationInFrames: 24 });

  return (
    <AbsoluteFill style={{ backgroundColor: "#9fb9ba", overflow: "hidden", fontFamily: FONT, color: "#2b3838" }}>
      <svg viewBox="0 0 1280 720" width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <linearGradient id={seaId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#bfd0cc" /><stop offset="1" stopColor="#829fa2" /></linearGradient>
          <linearGradient id={`migration-${sceneId}-land`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f2e4c5" /><stop offset="1" stopColor="#d7be92" /></linearGradient>
          <pattern id={paperId} width="70" height="70" patternUnits="userSpaceOnUse"><path d="M 4 15 L 63 11 M 9 51 L 59 62" stroke="#8f6d4d" strokeOpacity="0.08" /><circle cx="25" cy="30" r="1" fill="#8f6d4d" fillOpacity="0.1" /></pattern>
          <filter id={shadowId} x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="9" stdDeviation="12" floodColor="#314848" floodOpacity="0.28" /></filter>
        </defs>
        <rect width="1280" height="720" fill={`url(#${seaId})`} />
        <rect x="42" y="54" width="1196" height="616" fill="#f0e2c2" fillOpacity="0.16" stroke="#e9dec8" strokeOpacity="0.68" filter={`url(#${shadowId})`} />
        <g transform={`translate(${mapX} ${mapY}) scale(${zoom})`}>
          {chinaProvincePaths.map((province, index) => <path key={province.name} d={province.d} fill={index % 2 === 0 ? "#f0dfbb" : "#e5cfaa"} stroke="#9e8561" strokeWidth="1.1" strokeLinejoin="round" opacity="0.93" />)}
          <rect x="68" y="86" width="1080" height="500" fill={`url(#${paperId})`} opacity="0.58" pointerEvents="none" />
          {chinaRiverPaths.map((river, index) => <path key={`${river.name}-${index}`} d={river.d} fill="none" stroke="#5b9497" strokeWidth={river.name === "Chang Jiang" || river.name === "Yangtze" ? 2.8 : 1.2} opacity={river.name === "Chang Jiang" || river.name === "Yangtze" ? 0.6 : 0.25} />)}
          <path d={pointsPath(route)} fill="none" stroke="#833d32" strokeOpacity="0.2" strokeWidth="22" strokeLinecap="round" />
          <path d={pointsPath(route)} fill="none" stroke="#8f3d31" strokeOpacity="0.42" strokeWidth="8" strokeLinecap="round" strokeDasharray="12 9" />
          <path d={pointsPath(route)} fill="none" stroke="#e06d4b" strokeWidth="7" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - routeProgress} />
          <path d={pointsPath(route)} fill="none" stroke="#ffd28d" strokeWidth="2" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - routeProgress} />
          {routeLocations.map((location, index) => {
            const point = projectGeo(location);
            return <g key={location.id}><circle cx={point.x} cy={point.y} r="14" fill="none" stroke="#d66c4c" strokeWidth="2" opacity="0.2" /><circle cx={point.x} cy={point.y} r="6" fill="#fff5dd" stroke="#a84e3c" strokeWidth="3" /><text x={point.x + 12} y={point.y + 5} fontFamily={FONT} fontSize="17" fontWeight="700" fill="#3c332b" paintOrder="stroke fill" stroke="#f7e9c9" strokeWidth="5" opacity={0.78 + routeProgress * 0.22}>{location.label}</text></g>;
          })}
          {routeProgress > 0.02 && <g transform={`translate(${moving.x} ${moving.y})`}><circle r="6" fill="#fff4ce" stroke="#a84e3c" strokeWidth="3" /><path d="M -4 12 L 0 20 L 4 12" fill="#a84e3c" /></g>}
        </g>
      </svg>
      <div style={{ position: "absolute", left: 70, top: 112, opacity: titleEnter, transform: `translateY(${(1 - titleEnter) * 22}px)`, zIndex: 10 }}>
        <div style={{ fontSize: 18, letterSpacing: "0.18em", color: "#a84e3c" }}><AnimatedText text={map.title || "空间关系"} animation="wipe" /></div>
        <div style={{ marginTop: 9, fontFamily: SERIF, fontSize: 55 }}><AnimatedText text={map.subtitle || "路线示意"} delay={8} animation="scale" /></div>
        <div style={{ marginTop: 16 }}><AnimatedRule width={188} delay={22} /></div>
      </div>
      <div style={{ position: "absolute", right: 70, top: 116, padding: "12px 16px", border: "1px solid rgba(93,66,47,0.42)", backgroundColor: "rgba(245,231,198,0.72)", color: "#564438", fontSize: 17, zIndex: 10 }}><AnimatedText text={map.subtitle || "示意路线"} delay={12} animation="wipe" /></div>
      <div style={{ position: "absolute", left: 70, bottom: 160, color: "#584638", fontSize: 16, opacity: 0.84, zIndex: 10 }}><AnimatedText text="路线用于表达叙事方向，不代表单一可考证路径" delay={25} /></div>
    </AbsoluteFill>
  );
}

type WorldPoint = { x: number; y: number };

const WORLD_BOUNDS = {
  left: 44,
  top: 58,
  width: 1192,
  height: 572,
  minLon: -20,
  maxLon: 140,
  minLat: -12,
  maxLat: 72,
};

const WORLD_FEATURES = worldGeoJson.features ?? [];

type RenderWorldBounds = typeof WORLD_BOUNDS;

function mapRenderBounds(map: MigrationMap): RenderWorldBounds {
  const bounds = map.bounds;
  return {
    ...WORLD_BOUNDS,
    minLon: Number.isFinite(bounds?.minLon) ? bounds!.minLon : WORLD_BOUNDS.minLon,
    maxLon: Number.isFinite(bounds?.maxLon) ? bounds!.maxLon : WORLD_BOUNDS.maxLon,
    minLat: Number.isFinite(bounds?.minLat) ? bounds!.minLat : WORLD_BOUNDS.minLat,
    maxLat: Number.isFinite(bounds?.maxLat) ? bounds!.maxLat : WORLD_BOUNDS.maxLat,
  };
}

function projectWorld({ lon, lat }: { lon: number; lat: number }, bounds: RenderWorldBounds = WORLD_BOUNDS): WorldPoint {
  return {
    x: bounds.left + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * bounds.width,
    y: bounds.top + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * bounds.height,
  };
}

function worldRingPath(ring: unknown, bounds: RenderWorldBounds = WORLD_BOUNDS) {
  const points = (ring as Array<[number, number]>).map(([lon, lat]) => projectWorld({ lon, lat }, bounds));
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ") + " Z";
}

function worldFeaturePath(feature: (typeof WORLD_FEATURES)[number], bounds: RenderWorldBounds = WORLD_BOUNDS) {
  const geometry = feature.geometry;
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return (geometry.coordinates as unknown as unknown[]).map((ring) => worldRingPath(ring, bounds)).join(" ");
  }
  return (geometry.coordinates as unknown as unknown[]).map((polygon) => (polygon as unknown as unknown[]).map((ring) => worldRingPath(ring, bounds)).join(" ")).join(" ");
}

function mapTransform(scale: number, x: number, y: number) {
  return `translate(${640 + x} ${360 + y}) scale(${scale}) translate(-640 -360)`;
}

function routePointsFor(route: MapRoute, locations: Map<string, MapLocation>, bounds: RenderWorldBounds = WORLD_BOUNDS) {
  const from = locations.get(route.from);
  const to = locations.get(route.to);
  if (!from || !to) return [];
  return [from, ...(route.waypoints ?? []).map((point) => ({ ...point, coordinateSource: "illustrative", id: "waypoint", label: "" })), to].map((point) => projectWorld(point, bounds));
}

function smoothRoutePath(points: WorldPoint[]) {
  if (points.length < 2) return "";
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1] ?? current;
    const start = { x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2 };
    const end = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
    if (index === 1) path += ` L ${start.x.toFixed(2)} ${start.y.toFixed(2)}`;
    path += ` Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
}

function routeHeading(points: WorldPoint[], progress: number) {
  const here = pointAlong(points, progress);
  const ahead = pointAlong(points, Math.min(1, progress + 0.02));
  return Math.atan2(ahead.y - here.y, ahead.x - here.x) * (180 / Math.PI);
}

function mapRouteProgress(mode: string, routeId: string, frame: number, durationInFrames: number, routeIndex = 0) {
  const isFirst = routeIndex === 0 || routeId === "goods-out" || routeId === "industrial-goods";
  const start = isFirst ? durationInFrames * 0.12 : durationInFrames * Math.min(0.7, 0.28 + routeIndex * 0.1);
  const end = isFirst ? durationInFrames * 0.56 : durationInFrames * Math.min(0.9, 0.68 + routeIndex * 0.06);
  const progress = interpolate(frame, [start, end], [0, 1], {
    easing: isFirst ? Easing.out(Easing.cubic) : Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (mode === "silver-flow" && routeId === "silver-to-china") {
    return interpolate(frame, [durationInFrames * 0.48, durationInFrames * 0.8], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  return progress;
}

function FlowMarker({ point, heading, color, kind, opacity }: { point: WorldPoint; heading: number; color: string; kind: "goods" | "silver"; opacity: number }) {
  return (
    <g transform={`translate(${point.x} ${point.y}) rotate(${heading})`} opacity={opacity} pointerEvents="none">
      <circle r={kind === "silver" ? 7 : 6} fill="#f7ebcc" stroke={color} strokeWidth="2.5" />
      {kind === "silver" ? <path d="M 0 -3 L 5 0 L 0 3 L -5 0 Z" fill={color} /> : <path d="M -5 -3 L 4 -3 L 8 0 L 4 3 L -5 3 L -2 0 Z" fill={color} />}
    </g>
  );
}

function FlowTrail({ points, progress, color, opacity }: { points: WorldPoint[]; progress: number; color: string; opacity: number }) {
  if (progress <= 0.02) return null;
  return (
    <g pointerEvents="none">
      {[0.018, 0.038, 0.058, 0.078].map((offset, index) => {
        const point = pointAlong(points, Math.max(0, progress - offset));
        return <circle key={offset} cx={point.x} cy={point.y} r={2.8 - index * 0.35} fill={color} opacity={opacity * (0.58 - index * 0.11)} />;
      })}
    </g>
  );
}

function FlowCity({ location, point, frame, delay, accent }: { location: MapLocation; point: WorldPoint; frame: number; delay: number; accent: string }) {
  const { fps } = useVideoConfig();
  const enter = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 25, mass: 0.65, stiffness: 130 }, durationInFrames: 24 });
  const labelDx = location.labelDx ?? 12;
  const labelDy = location.labelDy ?? -10;
  return (
    <g transform={`translate(${point.x} ${point.y}) scale(${0.72 + enter * 0.28})`} opacity={enter}>
      <circle r="8" fill="#f8eed8" stroke={accent} strokeWidth="3" />
      <path d="M -13 0 H 13 M 0 -13 V 13" stroke={accent} strokeWidth="1" opacity="0.5" />
      <text x={labelDx} y={labelDy} fill="#302d29" fontSize="17" fontFamily={FONT} fontWeight="700" paintOrder="stroke fill" stroke="#f4e7ca" strokeWidth="5">{location.label}</text>
    </g>
  );
}

function FlowRouteLabel({ point, text: label, color, frame, delay, align = "middle" }: { point: WorldPoint; text: string; color: string; frame: number; delay: number; align?: "start" | "middle" | "end" }) {
  const { fps } = useVideoConfig();
  const enter = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 25, mass: 0.62, stiffness: 140 }, durationInFrames: 22 });
  const width = Math.max(132, label.length * 19 + 28);
  const offsetX = align === "start" ? 0 : align === "end" ? -width : -width / 2;
  return (
    <g transform={`translate(${point.x + offsetX} ${point.y})`} opacity={enter}>
      <rect x="0" y="-22" width={width} height="36" rx="3" fill="rgba(17,24,25,0.78)" stroke={color} strokeOpacity="0.72" />
      <rect x="0" y="-22" width="4" height="36" fill={color} />
      <text x="16" y="2" fill="#f8eed9" fontFamily={FONT} fontSize="16" fontWeight="600">{label}</text>
    </g>
  );
}

function TradeFlowMapScene({ map, sceneId }: { map: MigrationMap; sceneId: string }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const seaId = `trade-${sceneId}-sea`;
  const landFocusId = `trade-${sceneId}-land-focus`;
  const gridId = `trade-${sceneId}-grid`;
  const vignetteId = `trade-${sceneId}-vignette`;
  const clipId = `trade-${sceneId}-clip`;
  const locations = new Map(map.locations.map((location) => [location.id, location]));
  const renderBounds = mapRenderBounds(map);
  const isSilverFlow = map.mode === "silver-flow";
  const intro = spring({ frame, fps, config: { damping: 28, mass: 0.8, stiffness: 85 }, durationInFrames: 34 });
  const camera = interpolate(frame, [0, durationInFrames * 0.28, durationInFrames * 0.72, durationInFrames], [0, 1, 0.76, 0.82], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const mapScale = 1.015 + camera * 0.035;
  const mapX = isSilverFlow ? -8 * camera : -3 * camera;
  const mapY = -3 * camera;
  const title = map.title || "空间关系";
  const subtitle = map.subtitle || "路线示意";
  const locationsById = new Map(map.locations.map((location) => [location.id, projectWorld(location, renderBounds)]));
  const legend = map.legend?.length ? map.legend : ["路线", "节点"];

  return (
    <AbsoluteFill style={{ background: "#aabdbc", overflow: "hidden", color: "#2f3534", fontFamily: FONT }}>
      <svg viewBox="0 0 1280 720" width="100%" height="100%" style={{ position: "absolute", inset: 0 }} shapeRendering="geometricPrecision">
        <defs>
          <linearGradient id={seaId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c4d2cd" />
            <stop offset="0.54" stopColor="#a9c2c0" />
            <stop offset="1" stopColor="#8ea9aa" />
          </linearGradient>
          <linearGradient id="trade-land" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1e2c2" />
            <stop offset="0.55" stopColor="#e6d0a7" />
            <stop offset="1" stopColor="#d2b78b" />
          </linearGradient>
          <linearGradient id={landFocusId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ecd09b" />
            <stop offset="1" stopColor="#c7955e" />
          </linearGradient>
          <pattern id={gridId} width="64" height="64" patternUnits="userSpaceOnUse">
            <path d="M 0 32 H 64 M 32 0 V 64" stroke="#e7efdf" strokeOpacity="0.12" strokeWidth="1" />
          </pattern>
          <radialGradient id={vignetteId} cx="50%" cy="46%" r="72%">
            <stop offset="0.64" stopColor="#243b3b" stopOpacity="0" />
            <stop offset="1" stopColor="#243b3b" stopOpacity="0.4" />
          </radialGradient>
          <clipPath id={clipId}><rect x="44" y="58" width="1192" height="572" /></clipPath>
        </defs>
        <rect width="1280" height="720" fill={`url(#${seaId})`} />
        <rect x="44" y="58" width="1192" height="572" fill="#d9e4dd" opacity="0.34" />
        <g transform={mapTransform(mapScale, mapX, mapY)} clipPath={`url(#${clipId})`}>
          {WORLD_FEATURES.map((feature, index) => {
            const name = feature.properties?.name ?? "";
            const fill = name === "China" || name === "England" ? `url(#${landFocusId})` : index % 3 === 0 ? "#efe0bf" : index % 3 === 1 ? "#e5cfaa" : "#ead8b7";
            const path = worldFeaturePath(feature, renderBounds);
            if (!path) return null;
            return <path key={feature.id ?? `${name}-${index}`} d={path} fill={fill} stroke="#927d61" strokeWidth="0.9" strokeLinejoin="round" opacity={0.94} fillRule="evenodd" />;
          })}
          <path d="M 44 344 H 1236" stroke="#7ca3a1" strokeOpacity="0.22" strokeDasharray="3 13" />
          <path d="M 44 238 H 1236" stroke="#7ca3a1" strokeOpacity="0.16" strokeDasharray="3 17" />
          {map.routes.map((route, index) => {
            const points = routePointsFor(route, locations, renderBounds);
            const path = smoothRoutePath(points);
            const progress = mapRouteProgress(map.mode, route.id ?? `${index}`, frame, durationInFrames, index);
            const opacity = route.opacity ?? 1;
            const markerPoint = pointAlong(points, progress);
            const heading = routeHeading(points, progress);
            const kind = route.id?.includes("silver") ? "silver" : "goods";
            return (
              <g key={route.id ?? `${route.from}-${route.to}-${index}`}>
                <path d={path} fill="none" stroke={route.color} strokeWidth="11" strokeLinecap="round" opacity={0.11 * opacity} />
                <path d={path} fill="none" stroke={route.color} strokeWidth="2.4" strokeLinecap="round" strokeDasharray="1" strokeDashoffset={1 - progress} pathLength="1" opacity={0.96 * opacity} />
                <path d={path} fill="none" stroke="#fff3d0" strokeWidth="0.8" strokeLinecap="round" strokeDasharray="1" strokeDashoffset={1 - progress} pathLength="1" opacity={0.68 * opacity} />
                <FlowTrail points={points} progress={progress} color={route.color} opacity={opacity} />
                <FlowMarker point={markerPoint} heading={heading} color={route.color} kind={kind} opacity={progress > 0.01 ? opacity : 0} />
                {route.label && route.labelAt && <FlowRouteLabel point={projectWorld(route.labelAt, renderBounds)} text={route.label} color={route.color} frame={frame} delay={index === 0 ? 48 : 92} />}
              </g>
            );
          })}
          {map.locations.map((location, index) => {
            const point = locationsById.get(location.id);
            if (!point) return null;
            const accent = index === 0 ? "#b15f43" : index === 1 ? "#d19a43" : "#527a7b";
            return <FlowCity key={location.id} location={location} point={point} frame={frame} delay={24 + index * 10} accent={accent} />;
          })}
        </g>
        <rect width="1280" height="720" fill={`url(#${vignetteId})`} pointerEvents="none" />
        <path d="M 44 58 H 1236 V 630 H 44 Z" fill="none" stroke="#e7ddc7" strokeOpacity="0.72" strokeWidth="1.5" />
      </svg>

      <div style={{ position: "absolute", left: 70, top: 82, width: 650, opacity: intro, transform: `translateY(${(1 - intro) * 18}px)`, zIndex: 10 }}>
        <div style={{ color: isSilverFlow ? "#b46b48" : "#ae7840", fontSize: 15, letterSpacing: "0.2em" }}><AnimatedText text={title} animation="wipe" /></div>
        <div style={{ marginTop: 8, color: "#293635", fontFamily: SERIF, fontSize: 34, lineHeight: 1.16, letterSpacing: "0.06em", textShadow: "0 1px 0 rgba(246,235,210,0.45)" }}><AnimatedText text={subtitle} delay={7} animation="scale" /></div>
        <div style={{ marginTop: 13, width: 112, height: 2, backgroundColor: isSilverFlow ? "#d7a94d" : "#d9984f", transformOrigin: "left", transform: `scaleX(${interpolate(intro, [0, 1], [0, 1])})` }} />
      </div>
      <div style={{ position: "absolute", right: 70, top: 92, display: "flex", gap: 18, alignItems: "center", color: "rgba(45,55,53,0.78)", fontSize: 14, opacity: intro, zIndex: 10 }}>
        {legend.map((item, index) => <span key={`${item}-${index}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><i style={{ width: 22, height: 3, background: index === 0 ? "#d9984f" : "#d7a94d", display: "inline-block" }} />{item}</span>)}
      </div>
    </AbsoluteFill>
  );
}

function ShotScene({ shot }: { shot: ShowcaseShot }) {
  const { fps } = useVideoConfig();
  const hasCharacters = (shot.characters?.length || 0) > 0;
  const hasStock = (shot.stockBroll?.length || 0) > 0;
  const isStoryFirst = Boolean(shot.storyAction);
  const isTradeMap = Boolean(shot.map && (shot.map.mapFamily || shot.visualMode === "trade-surplus-map-video" || shot.visualMode === "silver-flow-map-video" || shot.visualMode === "trade-surplus" || shot.visualMode === "silver-flow" || shot.visualMode?.startsWith("us-")));
  const isMap = Boolean(shot.map && !isTradeMap && (shot.shotType === "map" || shot.visualMode === "map-video" || shot.visualMode === "map-svg" || shot.visualMode === "migration"));
  const isLayeredComposite = hasCharacters && (shot.shotType === "hybrid" || shot.visualMode === "layered-composite" || shot.visualMode === "hybrid-composite");
  const hasLegacyCharacters = shot.visualMode === "character-sequence" && hasCharacters;
  // A hybrid shot without its alpha layers must still show a real visual
  // source. Use the downloaded stock clip as a full-frame cutaway instead of
  // exposing the legacy full-frame character/episode image.
  const stockPrimary = hasStock && (shot.visualMode === "stock-broll" || (shot.shotType === "hybrid" && !hasCharacters));
  const plateUrl = shot.imageUrl || shot.fallbackImageUrl || "";
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0c0d", overflow: "hidden" }}>
      {isStoryFirst ? <>
        {plateUrl && plateSegments(shot, fps).map(({ beat, from, duration }) => (
          <Sequence key={beat.id} from={from} durationInFrames={duration} premountFor={8}><CameraPlate imageUrl={plateUrl} beat={beat} /></Sequence>
        ))}
        <StoryActionLayer shot={shot} />
      </> : isMap ? <MigrationMapScene map={shot.map as MigrationMap} sceneId={String(shot.storyboardId)} /> : isTradeMap ? <TradeFlowMapScene map={shot.map as MigrationMap} sceneId={String(shot.storyboardId)} /> : stockPrimary ? <StockBrollLayer items={shot.stockBroll as StockBroll[]} shotDurationInFrames={shot.durationInFrames} primary /> : isLayeredComposite ? <>
        {plateUrl && plateSegments(shot, fps).map(({ beat, from, duration }) => {
          return <Sequence key={beat.id} from={from} durationInFrames={duration} premountFor={8}><CameraPlate imageUrl={plateUrl} beat={beat} /></Sequence>;
        })}
        <LayeredCharacterSequence cards={shot.characters as CharacterCard[]} />
      </> : hasLegacyCharacters ? <>
        {plateUrl && plateSegments(shot, fps).map(({ beat, from, duration }) => {
          return <Sequence key={beat.id} from={from} durationInFrames={duration} premountFor={8}><CameraPlate imageUrl={plateUrl} beat={beat} /></Sequence>;
        })}
        <LayeredCharacterSequence cards={shot.characters as CharacterCard[]} />
      </> : plateSegments(shot, fps).map(({ beat, from, duration }) => {
        return plateUrl ? <Sequence key={beat.id} from={from} durationInFrames={duration} premountFor={8}><CameraPlate imageUrl={plateUrl} beat={beat} /></Sequence> : null;
      })}
      {!isStoryFirst && !isMap && !isTradeMap && !stockPrimary && shot.stockBroll && <StockBrollLayer items={shot.stockBroll} shotDurationInFrames={shot.durationInFrames} />}
      {!isStoryFirst && !isMap && !isTradeMap && !stockPrimary && !isLayeredComposite && !hasLegacyCharacters && <GraphicOverlay graphic={shot.graphic} />}
      {!isMap && !isTradeMap && (isLayeredComposite || hasLegacyCharacters) && shot.graphic === "rulers" && <div style={{ position: "absolute", top: 116, right: 70, fontFamily: FONT, color: PAPER, fontSize: 17, opacity: 0.78, zIndex: 20 }}><AnimatedText text="政策如何落到百姓身上" animation="wipe" /></div>}
      <CaptionOverlay shot={shot} />
      {shot.audioUrl && <Audio src={shot.audioUrl} volume={0.96} />}
    </AbsoluteFill>
  );
}

export const EpisodeShowcase: React.FC<EpisodeShowcaseProps> = ({ shots, audioUrl, audioVolume = 0.96 }) => {
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0c0d" }}>
      {audioUrl && <Audio src={audioUrl} volume={audioVolume} />}
      {shots.map((shot, index) => {
        const from = cursor;
        cursor += shot.durationInFrames;
        return <Sequence key={`${shot.storyboardId}-${index}`} from={from} durationInFrames={shot.durationInFrames} premountFor={12}><ShotScene shot={shot} /></Sequence>;
      })}
    </AbsoluteFill>
  );
};
