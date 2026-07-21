import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { cameraLayerStyle } from "./editorial/camera";
import { buildTimeline, clamp, isFrameVisible, totalDurationInFrames, validateTimeline } from "./editorial/timing";
import {
  incomingTransitionStyle,
  isBridgeTransition,
  outgoingTransitionStyle,
  transitionFrames,
} from "./editorial/transitions";
import { counterText, cueProgress, cueText, textCueStyle } from "./editorial/text";
import type {
  EditorialAsset,
  EditorialGraphicCue,
  EditorialShot,
  EditorialTextCue,
  MagnatesEditorialProps,
  MagnatesEditorialPreviewProps,
} from "./editorial/types";
import { EditorialTelemetryProvider, InstrumentedLayer } from "./editorial/instrumentation";
import { dimensionPx, positionCss, textWidth } from "./editorial/coordinates";
import type { EditorialCoordinateMode } from "./editorial/types";

export type { MagnatesEditorialProps } from "./editorial/types";

const INK = "#0c0c0d";
const PAPER = "#f4f0e7";
const PURPLE = "#9d7cff";
const AMBER = "#f2b84b";
const TEAL = "#67d7c6";
const FONT = 'Arial, "Helvetica Neue", sans-serif';

const OBJECT_POSITIONS: Record<string, string> = {
  center: "center",
  top: "center top",
  bottom: "center bottom",
  left: "left center",
  right: "right center",
  top_left: "left top",
  top_right: "right top",
  bottom_left: "left bottom",
  bottom_right: "right bottom",
};

const CONTROLLED_FILTERS: Record<string, string> = {
  none: "none",
  monochrome: "grayscale(1)",
  warm: "sepia(0.24) saturate(1.18) hue-rotate(-8deg)",
  cool: "saturate(0.86) hue-rotate(10deg)",
  high_contrast: "contrast(1.18) saturate(0.94)",
  soft_blur: "blur(1.5px) saturate(0.9)",
};

function cssObjectPosition(position: string | undefined) {
  return position ? (OBJECT_POSITIONS[position] ?? position) : "center";
}

function cssAssetFilter(filter: string | undefined) {
  return filter === undefined
    ? "brightness(0.72) saturate(0.82) contrast(1.04)"
    : (CONTROLLED_FILTERS[filter] ?? filter);
}

function assetStyle(asset: EditorialAsset): React.CSSProperties {
  return {
    position: "absolute",
    inset: "-3%",
    width: "106%",
    height: "106%",
    objectFit: asset.fit ?? "cover",
    objectPosition: cssObjectPosition(asset.position),
    filter: cssAssetFilter(asset.filter),
  };
}

function BackgroundPlate({ asset }: { asset: EditorialAsset }) {
  const style = assetStyle(asset);
  if (asset.kind === "video") {
    return <OffthreadVideo src={asset.src} muted style={style} />;
  }
  return <Img src={asset.src} style={style} />;
}

function EchoPlate({ asset, style }: { asset: EditorialAsset; style: React.CSSProperties }) {
  // Keep local video assets on Remotion's video path. An <Img> cannot decode an
  // MP4 and would silently turn a distortion bridge into a broken layer.
  if (asset.kind === "video") {
    return <OffthreadVideo src={asset.src} muted style={style} />;
  }
  return <Img src={asset.src} style={style} />;
}

function EditorialText({ cue, frame, coordinateMode }: { cue: EditorialTextCue; frame: number; coordinateMode: EditorialCoordinateMode }) {
  if (!isFrameVisible(frame, cue.startFrame, cue.endFrame)) return null;
  const style = textCueStyle(cue, frame);
  const x = positionCss(cue.x, coordinateMode === "normalized" ? 0.08 : 8, coordinateMode);
  const y = positionCss(cue.y, coordinateMode === "normalized" ? 0.72 : 72, coordinateMode);
  const text = cue.entry === "counter" || cue.type === "counter"
    ? counterText(cue, frame)
    : cueText(cue, frame);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 70,
        pointerEvents: "none",
        ...style,
        width: textWidth(cue.width, coordinateMode),
      }}
    >
      {cue.label ? (
        <div
          style={{
            marginBottom: 8,
            color: cue.accent ?? AMBER,
            fontSize: Math.max(12, (cue.fontSize ?? 54) * 0.23),
            fontWeight: 700,
            letterSpacing: 2.5,
            textTransform: "uppercase",
          }}
        >
          {cue.label}
        </div>
      ) : null}
      <div style={{ whiteSpace: "pre-wrap", fontFamily: FONT }}>{text}</div>
    </div>
  );
}

function GraphicCue({ cue, frame, coordinateMode }: { cue: EditorialGraphicCue; frame: number; coordinateMode: EditorialCoordinateMode }) {
  if (!isFrameVisible(frame, cue.startFrame, cue.endFrame)) return null;
  const p = cueProgress(frame, {
    subject: cue.subject,
    startFrame: cue.startFrame,
    endFrame: Math.min(cue.endFrame, cue.startFrame + 14),
  });
  const color = cue.color ?? PURPLE;
  const secondaryColor = cue.secondaryColor ?? "rgba(244,240,231,0.5)";
  const left = positionCss(cue.x, coordinateMode === "normalized" ? 0.08 : 8, coordinateMode);
  const top = positionCss(cue.y, coordinateMode === "normalized" ? 0.68 : 68, coordinateMode);
  const width = dimensionPx(cue.width, 280, "x", coordinateMode);
  const defaultHeight = cue.kind === "globe"
    ? (cue.width === undefined ? 280 : width)
    : cue.kind === "monitor"
      ? 170
      : cue.kind === "badge"
        ? 34
        : cue.kind === "divider"
          ? 240
          : 3;
  const height = dimensionPx(cue.height, defaultHeight, "y", coordinateMode);
  const common: React.CSSProperties = {
    position: "absolute",
    left,
    top,
    zIndex: 58,
    pointerEvents: "none",
    opacity: p,
  };

  if (cue.kind === "underline" || cue.kind === "bar") {
    return (
      <div
        style={{
          ...common,
          width,
          height: cue.kind === "bar" ? Math.max(8, height * 3) : height,
          backgroundColor: color,
          transform: `scaleX(${p})`,
          transformOrigin: "left center",
          boxShadow: `0 0 22px ${color}66`,
        }}
      />
    );
  }

  if (cue.kind === "divider") {
    return (
      <div
        style={{
          ...common,
          width: 2,
          height,
          backgroundColor: color,
          transform: `scaleY(${p})`,
          transformOrigin: "top center",
        }}
      />
    );
  }

  if (cue.kind === "grid") {
    return (
      <div
        style={{
          ...common,
          inset: 0,
          width: "100%",
          height: "100%",
          backgroundImage: `linear-gradient(${secondaryColor} 1px, transparent 1px), linear-gradient(90deg, ${secondaryColor} 1px, transparent 1px)`,
          backgroundSize: "72px 72px",
          opacity: p * 0.18,
          maskImage: "linear-gradient(90deg, transparent, black 18%, black 82%, transparent)",
        }}
      />
    );
  }

  if (cue.kind === "monitor") {
    return (
      <div
        style={{
          ...common,
          left,
          top,
          width,
          height,
          border: `2px solid ${secondaryColor}`,
          background: "rgba(6, 8, 12, 0.45)",
          transform: `translateY(${(1 - p) * 16}px) scale(${0.94 + p * 0.06})`,
          boxShadow: `0 12px 34px rgba(0,0,0,0.3), inset 0 0 30px ${color}22`,
        }}
      >
        <div style={{ position: "absolute", inset: 12, border: `1px solid ${color}88`, opacity: 0.8 }} />
        <div style={{ position: "absolute", left: "50%", bottom: -34, width: 2, height: 32, background: secondaryColor }} />
      </div>
    );
  }

  if (cue.kind === "badge") {
    return (
      <div
        style={{
          ...common,
          width,
          height,
          padding: "8px 12px",
          boxSizing: "border-box",
          color: PAPER,
          border: `1px solid ${color}`,
          background: "rgba(9, 9, 10, 0.56)",
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          transform: `translateX(${(1 - p) * -12}px)`,
        }}
      >
        {cue.label ?? cue.subject}
      </div>
    );
  }

  const size = Math.min(width, height || width);
  return (
    <div
      style={{
        ...common,
        left,
        top,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${color}`,
        opacity: p * 0.9,
        transform: `rotate(${p * 12}deg) scale(${0.74 + p * 0.26})`,
        boxShadow: `0 0 0 1px ${secondaryColor}33, 0 0 34px ${color}44`,
      }}
    >
      <div style={{ position: "absolute", left: "18%", right: "18%", top: "50%", height: "32%", borderTop: `1px solid ${secondaryColor}`, borderBottom: `1px solid ${secondaryColor}`, borderRadius: "50%" }} />
      <div style={{ position: "absolute", top: "8%", bottom: "8%", left: "50%", width: "28%", borderLeft: `1px solid ${secondaryColor}`, borderRight: `1px solid ${secondaryColor}`, borderRadius: "50%", transform: "translateX(-50%)" }} />
      <div style={{ position: "absolute", left: "8%", top: "50%", width: "84%", height: 1, backgroundColor: secondaryColor }} />
    </div>
  );
}

function DistortionEcho({ asset, progress }: { asset: EditorialAsset; progress: number }) {
  if (progress <= 0) return null;
  const style = assetStyle(asset);
  return (
    <>
      <EchoPlate asset={asset} style={{ ...style, opacity: progress * 0.42, transform: `translateX(${progress * -10}px)`, filter: `${style.filter ?? ""} saturate(1.8) hue-rotate(-18deg)`, mixBlendMode: "screen", clipPath: "polygon(0 0, 100% 0, 100% 33%, 0 38%)" }} />
      <EchoPlate asset={asset} style={{ ...style, opacity: progress * 0.3, transform: `translateX(${progress * 11}px)`, filter: `${style.filter ?? ""} saturate(1.7) hue-rotate(155deg)`, mixBlendMode: "screen", clipPath: "polygon(0 64%, 100% 58%, 100% 100%, 0 100%)" }} />
    </>
  );
}

function BridgeGraphic({ kind, progress, accent, direction = "in" }: { kind: string; progress: number; accent: string; direction?: "in" | "out" }) {
  if (!isBridgeTransition(kind as Parameters<typeof isBridgeTransition>[0]) || progress <= 0) return null;
  if (kind === "distortion") return <div style={{ position: "absolute", inset: 0, zIndex: 52, opacity: Math.sin(progress * Math.PI) * 0.5, background: `repeating-linear-gradient(0deg, transparent 0 8px, ${accent}44 9px 10px)`, mixBlendMode: "screen" }} />;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 52, opacity: (direction === "out" ? progress : 1 - progress) * 0.72, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: `${(1 - progress) * -20}%`, top: "46%", width: "140%", height: 4, backgroundColor: accent, transform: "rotate(-2deg)", boxShadow: `0 0 30px ${accent}` }} />
      <div style={{ position: "absolute", left: `${progress * 14}%`, top: "51%", width: "100%", height: 1, backgroundColor: "rgba(244,240,231,0.65)" }} />
    </div>
  );
}

function EditorialShot({ shot, incomingOffsetFrames, frameOffset, coordinateMode }: { shot: EditorialShot; incomingOffsetFrames: number; frameOffset: number; coordinateMode: EditorialCoordinateMode }) {
  const frame = useCurrentFrame();
  const duration = shot.durationInFrames;
  const localFrame = frame - incomingOffsetFrames;
  const actualFrame = clamp(localFrame, 0, duration - 1);
  const incomingStyle = incomingTransitionStyle(shot.transitionIn, frame, incomingOffsetFrames);
  const outgoingStyle = outgoingTransitionStyle(shot.transitionOut, actualFrame, duration);
  const bridgeFrames = transitionFrames(shot.transitionIn);
  const bridgeProgress = bridgeFrames > 0 ? clamp(frame / bridgeFrames, 0, 1) : 1;
  const outgoingFrames = transitionFrames(shot.transitionOut);
  const outgoingProgress = outgoingFrames > 0 ? clamp((actualFrame - (duration - outgoingFrames)) / outgoingFrames, 0, 1) : 0;
  const incomingClass = shot.transitionIn?.class ?? "hard_cut";
  const outgoingClass = shot.transitionOut?.class ?? "hard_cut";
  const incomingDistortionProgress = incomingClass === "distortion"
    ? Math.sin(bridgeProgress * Math.PI)
    : 0;
  const outgoingDistortionProgress = outgoingClass === "distortion"
    ? Math.sin(outgoingProgress * Math.PI)
    : 0;
  const cameraStyle = cameraLayerStyle(actualFrame, duration, shot.camera);
  const transitionStyle: React.CSSProperties = {
    ...incomingStyle,
    ...outgoingStyle,
    opacity: Number(incomingStyle.opacity ?? 1) * Number(outgoingStyle.opacity ?? 1),
    filter: [incomingStyle.filter, outgoingStyle.filter].filter(Boolean).join(" ") || undefined,
    transform: [incomingStyle.transform, outgoingStyle.transform].filter(Boolean).join(" ") || undefined,
    // Once the outgoing transition starts it owns the clip. This matters when
    // a shot enters and exits through two matte transitions.
    clipPath: outgoingProgress > 0 && outgoingStyle.clipPath
      ? outgoingStyle.clipPath
      : incomingStyle.clipPath ?? outgoingStyle.clipPath,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: INK, ...transitionStyle }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: INK }}>
        <div style={{ position: "absolute", inset: 0, ...cameraStyle }}>
          <InstrumentedLayer
            layerId={`shot:${shot.id}:background`}
            startFrame={0}
            endFrame={duration + incomingOffsetFrames}
            frameOffset={frameOffset}
            assetId={shot.background.assetId}
            decodeStatus="decoded"
            style={{ position: "absolute", inset: 0 }}
          >
            <BackgroundPlate asset={shot.background} />
          </InstrumentedLayer>
          {shot.tint ? <AbsoluteFill style={{ backgroundColor: shot.tint }} /> : null}
        </div>
        {incomingDistortionProgress > 0 ? <DistortionEcho asset={shot.background} progress={incomingDistortionProgress} /> : null}
        {outgoingDistortionProgress > 0 ? <DistortionEcho asset={shot.background} progress={outgoingDistortionProgress} /> : null}
        <BridgeGraphic kind={incomingClass} progress={bridgeProgress} accent={shot.transitionIn?.accent ?? PURPLE} />
        <BridgeGraphic kind={outgoingClass} progress={outgoingProgress} accent={shot.transitionOut?.accent ?? shot.transitionIn?.accent ?? PURPLE} direction="out" />
        {(shot.graphics ?? []).map((cue, cueIndex) => {
          const cueId = cue.id ?? `${shot.id}:graphic:${cueIndex}`;
          return (
            <InstrumentedLayer
              key={cueId}
              layerId={`cue:${cueId}:root`}
              startFrame={incomingOffsetFrames + cue.startFrame}
              endFrame={incomingOffsetFrames + cue.endFrame}
              frameOffset={frameOffset}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              <GraphicCue cue={cue} frame={localFrame} coordinateMode={coordinateMode} />
            </InstrumentedLayer>
          );
        })}
        {(shot.texts ?? []).map((cue, cueIndex) => {
          const cueId = cue.id ?? `${shot.id}:text:${cueIndex}`;
          return (
            <InstrumentedLayer
              key={cueId}
              layerId={`cue:${cueId}:root`}
              startFrame={incomingOffsetFrames + cue.startFrame}
              endFrame={incomingOffsetFrames + cue.endFrame}
              frameOffset={frameOffset}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              <EditorialText cue={cue} frame={localFrame} coordinateMode={coordinateMode} />
            </InstrumentedLayer>
          );
        })}
        {shot.sourceLabel ? (
          <div style={{ position: "absolute", left: 42, top: 30, zIndex: 80, color: "rgba(244,240,231,0.64)", fontFamily: FONT, fontSize: 12, letterSpacing: 2.2, textTransform: "uppercase" }}>
            {shot.sourceLabel}
          </div>
        ) : null}
        <div style={{ position: "absolute", inset: 0, zIndex: 75, pointerEvents: "none", opacity: shot.grain ?? 0.12, backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 1px, transparent 1px, transparent 4px)", mixBlendMode: "soft-light" }} />
      </div>
    </AbsoluteFill>
  );
}

export const MAGNATES_EDITORIAL_DURATION = 525;

export const defaultMagnatesEditorialShots: EditorialShot[] = [
  {
    id: "hook-contrast",
    durationInFrames: 105,
    semanticRole: "hook",
    background: { src: "", fit: "cover", filter: "brightness(0.58) saturate(0.7) contrast(1.1)" },
    camera: { preset: "push_in", intensity: 0.65, focus: { x: 0.62, y: 0.45 } },
    transitionIn: { class: "matte_transition", frames: 18, accent: PURPLE },
    transitionOut: { class: "graphic_transition", frames: 16, accent: TEAL },
    sourceLabel: "hook / surprise contrast",
    graphics: [
      { kind: "grid", subject: "world map grid", startFrame: 4, endFrame: 104, color: PURPLE },
      { kind: "underline", subject: "purple underline", startFrame: 28, endFrame: 102, x: 8, y: 72, width: 360, color: PURPLE },
    ],
    texts: [
      { subject: "Yahoo logo", text: "YAHOO", startFrame: 8, endFrame: 96, entry: "wipe", x: 8, y: 33, fontSize: 92, weight: 800, color: PAPER },
      { subject: "market cap", type: "counter", startFrame: 24, endFrame: 72, entry: "counter", from: 0, to: 128, prefix: "$", suffix: "B", unit: "USD billions", period: "peak valuation", label: "once valued at", x: 8, y: 59, fontSize: 52, accent: AMBER, color: AMBER },
      { subject: "decision headline", text: "Yahoo said no.", startFrame: 60, endFrame: 102, entry: "slide_up", x: 8, y: 78, fontSize: 34, weight: 600, color: PAPER },
    ],
  },
  {
    id: "mechanism-map",
    durationInFrames: 105,
    semanticRole: "mechanism",
    background: { src: "", fit: "cover", filter: "brightness(0.65) saturate(0.86) contrast(1.05)" },
    camera: { preset: "pan_right", intensity: 0.55, focus: { x: 0.46, y: 0.5 } },
    transitionIn: { class: "graphic_transition", frames: 16, accent: TEAL },
    transitionOut: { class: "blur_bridge", frames: 14, accent: AMBER },
    sourceLabel: "mechanism / layer assembly",
    graphics: [
      { kind: "globe", subject: "world graphic", startFrame: 8, endFrame: 100, x: 67, y: 22, width: 250, height: 250, color: TEAL, secondaryColor: "rgba(244,240,231,0.4)" },
      { kind: "bar", subject: "growth bar", startFrame: 38, endFrame: 100, x: 8, y: 68, width: 470, height: 4, color: TEAL },
      { kind: "badge", subject: "directory to portal", label: "directory  ->  portal", startFrame: 56, endFrame: 102, x: 8, y: 84, width: 270, color: TEAL },
    ],
    texts: [
      { subject: "before search headline", text: "Before search,\nthe web was a mess.", startFrame: 10, endFrame: 54, entry: "type_on", x: 8, y: 31, fontSize: 54, color: PAPER },
      { subject: "mechanism caption", text: "A list became a gateway.", startFrame: 52, endFrame: 103, entry: "slide_left", x: 8, y: 74, fontSize: 40, color: PAPER },
    ],
  },
  {
    id: "comparison-monitor",
    durationInFrames: 105,
    semanticRole: "comparison",
    background: { src: "", fit: "cover", filter: "brightness(0.72) saturate(0.72) contrast(1.08)" },
    camera: { preset: "hold", intensity: 0.28, focus: { x: 0.5, y: 0.5 } },
    transitionIn: { class: "blur_bridge", frames: 14, accent: AMBER },
    transitionOut: { class: "matte_transition", frames: 16, accent: AMBER },
    sourceLabel: "comparison / keep setup, replace metric",
    graphics: [
      { kind: "monitor", subject: "search interface", startFrame: 6, endFrame: 100, x: 57, y: 22, width: 370, height: 220, color: AMBER, secondaryColor: "rgba(244,240,231,0.65)" },
      { kind: "divider", subject: "comparison divider", startFrame: 18, endFrame: 94, x: 51, y: 23, height: 230, color: "rgba(244,240,231,0.4)" },
    ],
    texts: [
      { subject: "Yahoo result", text: "Yahoo", startFrame: 10, endFrame: 46, entry: "fade", x: 9, y: 31, fontSize: 56, color: AMBER },
      { subject: "Google result", text: "Google", startFrame: 48, endFrame: 80, entry: "wipe", x: 9, y: 31, fontSize: 56, color: PAPER },
      { subject: "offer metric", type: "counter", startFrame: 52, endFrame: 103, entry: "counter", from: 1, to: 1, prefix: "$", suffix: "M", unit: "USD millions", period: "offer value", label: "the offer", x: 9, y: 58, fontSize: 66, color: AMBER, accent: AMBER },
    ],
  },
  {
    id: "chapter-rise",
    durationInFrames: 105,
    semanticRole: "crisis",
    background: { src: "", fit: "cover", filter: "brightness(0.55) saturate(0.65) contrast(1.14)" },
    camera: { preset: "pull_out", intensity: 0.65, focus: { x: 0.48, y: 0.52 } },
    transitionIn: { class: "matte_transition", frames: 18, accent: PURPLE },
    transitionOut: { class: "distortion", frames: 14, accent: TEAL },
    sourceLabel: "chapter / matte reveal",
    graphics: [
      { kind: "bar", subject: "purple chapter bar", startFrame: 20, endFrame: 104, x: 8, y: 64, width: 460, height: 5, color: PURPLE },
      { kind: "underline", subject: "purple underline", startFrame: 50, endFrame: 104, x: 8, y: 79, width: 290, color: PURPLE },
    ],
    texts: [
      { subject: "chapter marker", text: "ACT I", startFrame: 26, endFrame: 56, entry: "wipe", x: 8, y: 42, fontSize: 24, weight: 700, color: PURPLE },
      { subject: "The Rise", text: "The Rise", startFrame: 54, endFrame: 104, entry: "type_on", x: 8, y: 69, fontSize: 84, weight: 800, color: PAPER },
    ],
  },
  {
    id: "digital-reversal",
    durationInFrames: 105,
    semanticRole: "reversal",
    background: { src: "", fit: "cover", filter: "brightness(0.65) saturate(0.9) contrast(1.08)" },
    camera: { preset: "whip", intensity: 0.7, focus: { x: 0.5, y: 0.42 } },
    transitionIn: { class: "distortion", frames: 14, accent: TEAL },
    transitionOut: { class: "dissolve", frames: 18, accent: PAPER },
    sourceLabel: "reversal / chromatic bridge",
    graphics: [
      { kind: "globe", subject: "globe outline", startFrame: 5, endFrame: 102, x: 70, y: 16, width: 220, height: 220, color: TEAL, secondaryColor: "rgba(103,215,198,0.38)" },
      { kind: "underline", subject: "however underline", startFrame: 58, endFrame: 104, x: 8, y: 71, width: 370, color: PURPLE },
      { kind: "badge", subject: "persistent metric", label: "views  111K  ->  133K", startFrame: 28, endFrame: 102, x: 8, y: 87, width: 300, color: TEAL },
    ],
    texts: [
      { subject: "90's title", text: "90's", startFrame: 8, endFrame: 48, entry: "slide_left", x: 8, y: 33, fontSize: 92, weight: 800, color: PAPER },
      { subject: "however", text: "however", startFrame: 54, endFrame: 102, entry: "type_on", x: 8, y: 64, fontSize: 70, weight: 800, color: PAPER },
      { subject: "this was never", text: "this was never meant to be a business", startFrame: 64, endFrame: 104, entry: "wipe", x: 8, y: 79, fontSize: 24, weight: 500, color: "rgba(244,240,231,0.8)" },
    ],
  },
];

function renderEditorial({ shots, durationInFrames, fps, audioUrl, targetProfileId, coordinateMode }: {
  shots: EditorialShot[];
  durationInFrames: number;
  fps: number;
  audioUrl?: string | null;
  targetProfileId: "youtube-720p" | "youtube-1080p";
  coordinateMode: EditorialCoordinateMode;
}) {
  const target = targetProfileId === "youtube-1080p"
    ? { scale: 1.5 }
    : { scale: 1 };
  const total = totalDurationInFrames(shots);
  const validationErrors = validateTimeline(shots, durationInFrames);
  if (validationErrors.length > 0 || total !== durationInFrames) {
    throw new Error(`Invalid Magnates editorial recipe:\n${validationErrors.join("\n")}`);
  }
  const timeline = buildTimeline(shots, fps);
  return (
    <EditorialTelemetryProvider>
      <AbsoluteFill style={{ backgroundColor: INK, overflow: "hidden" }}>
        {audioUrl ? <Audio src={audioUrl} /> : null}
        <div style={{ position: "absolute", left: 0, top: 0, width: 1280, height: 720, transform: `scale(${target.scale})`, transformOrigin: "top left", overflow: "hidden" }}>
          {timeline.map((item) => {
            const shot = item.shot;
            const from = Math.max(0, item.startFrame - item.incomingOffsetFrames);
            const offset = item.startFrame - from;
            const duration = shot.durationInFrames + offset;
            return (
              <Sequence key={shot.id} from={from} durationInFrames={duration}>
                <EditorialShot shot={shot} incomingOffsetFrames={offset} frameOffset={from} coordinateMode={coordinateMode} />
              </Sequence>
            );
          })}
        </div>
      </AbsoluteFill>
    </EditorialTelemetryProvider>
  );
}

export const MagnatesEditorial: React.FC<MagnatesEditorialProps> = (props) => {
  if (props.schemaVersion !== 2 || props.recipeSchemaVersion !== "magnates-remotion-recipe-v2") {
    throw new Error("MagnatesEditorial production requires canonical magnates-remotion-recipe-v2 props");
  }
  if (props.compositionId !== "MagnatesEditorial" || props.kind !== "magnates-editorial-recipe-props" || props.visualMode !== "magnates-editorial") {
    throw new Error("MagnatesEditorial production props identity is incomplete");
  }
  const expected = props.targetProfileId === "youtube-1080p"
    ? { width: 1920, height: 1080 }
    : props.targetProfileId === "youtube-720p"
      ? { width: 1280, height: 720 }
      : null;
  if (!expected || props.width !== expected.width || props.height !== expected.height || props.logicalWidth !== 1280 || props.logicalHeight !== 720) {
    throw new Error("MagnatesEditorial production props target profile does not match its exact dimensions");
  }
  if (!Array.isArray(props.shots) || props.shots.length === 0 || !Number.isInteger(props.durationInFrames) || props.durationInFrames < 1) {
    throw new Error("MagnatesEditorial production props require a non-empty, timed shot list");
  }
  for (const shot of props.shots) {
    if (!shot.background?.src || !shot.background.assetId || /^(?:https?:|data:)/i.test(shot.background.src)) {
      throw new Error(`MagnatesEditorial shot ${shot.id || "(unknown)"} has no verified staged background asset`);
    }
    for (const cue of [...(shot.texts ?? []), ...(shot.graphics ?? [])]) {
      if (!cue.id || !cue.subjectId) throw new Error(`MagnatesEditorial shot ${shot.id || "(unknown)"} contains an unidentified cue`);
    }
  }
  const { fps } = useVideoConfig();
  if (fps !== props.fps) throw new Error(`MagnatesEditorial fps ${fps} does not match props fps ${props.fps}`);
  return renderEditorial({
    shots: props.shots,
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    audioUrl: props.audioUrl,
    targetProfileId: props.targetProfileId,
    coordinateMode: "normalized",
  });
};

export const MagnatesEditorialPreview: React.FC<MagnatesEditorialPreviewProps> = ({ shots, durationInFrames, fps = 30, audioUrl }) => {
  const previewShots = (shots?.length ? shots : defaultMagnatesEditorialShots).map((shot, index) => shot.background.src
    ? shot
    : { ...shot, background: { ...shot.background, src: staticFile(["war-map/portrait.png", "war-map/background.png", "grid-ep500/sb1_cell1.png", "grid-ep500/sb1_cell2.png", "cutout-poc/subject.png"][index % 5]) } });
  const total = totalDurationInFrames(previewShots);
  return renderEditorial({
    shots: previewShots,
    durationInFrames: durationInFrames ?? total,
    fps,
    audioUrl,
    targetProfileId: "youtube-720p",
    coordinateMode: "legacy",
  });
};
