import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const DEFAULT_TRANSITION_FRAMES = 5;
const DEFAULT_PUSH_FRAMES = 8;
const DEFAULT_SCENE_FADE_FRAMES = 6;
// Darken scene boundaries without turning a frame into an unreadable black card.
const SCENE_FADE_OPACITY = 0.45;
const UI_FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const DISPLAY_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';

export type TransitionDirection = "left" | "right" | "up" | "down";
export type TemporalGridLayout = "2x1" | "2x2";
export type CameraPreset =
  | "drift"
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "static";
export type TransitionEffect = "dissolve" | "soft-focus" | "dip-dark";

export type TemporalGridPanel = {
  action: string;
  durationInFrames?: number;
  /** Source cell in the configured sheet; supports 2- or 4-keyframe shots. */
  sourceIndex?: number;
};

/** Optional editorial labels rendered by Remotion, never baked into the sheet. */
export type TemporalGridTextOverlay = {
  context?: string;
  subject?: string;
  start?: string;
  result?: string;
  /** Side with the clearest negative space for this shot's editorial labels. */
  placement?: "left" | "right";
};

export type TemporalCaption = {
  startFrame: number;
  endFrame: number;
  text: string;
};

export type TemporalGridShot = {
  from?: number;
  durationInFrames: number;
  sheetUrl: string;
  /** Number of horizontal/vertical states contained in the source sheet. */
  gridLayout?: TemporalGridLayout;
  panels: TemporalGridPanel[];
  narration?: string;
  transitionFrames?: number;
  transitionMode?: "cut" | "crossfade" | "push";
  transitionDirection?: TransitionDirection;
  transitionEffect?: TransitionEffect;
  /** Ken Burns-style camera path that runs across the entire shot. */
  cameraPreset?: CameraPreset;
  cameraIntensity?: number;
  /** Dark bridge around this shot's boundary, in total frames. */
  sceneTransitionFrames?: number;
  textOverlay?: TemporalGridTextOverlay;
};

export type TemporalGridEpisodeProps = {
  durationInFrames: number;
  audioUrl?: string | null;
  shots: TemporalGridShot[];
  captions?: TemporalCaption[];
};

type PanelWindow = {
  index: number;
  sourceIndex: number;
  start: number;
  duration: number;
};

function gridDimensions(layout: TemporalGridLayout = "2x2") {
  return layout === "2x1"
    ? { columns: 2, rows: 1, panelCount: 2 }
    : { columns: 2, rows: 2, panelCount: 4 };
}

function panelWindows(shot: TemporalGridShot): PanelWindow[] {
  const { panelCount } = gridDimensions(shot.gridLayout);
  const panels = shot.panels.slice(0, panelCount);
  const explicitTotal = panels.reduce(
    (sum, panel) => sum + (panel.durationInFrames ?? 0),
    0,
  );
  const fallbackDuration = Math.max(
    1,
    Math.floor(
      (shot.durationInFrames - explicitTotal) /
        Math.max(1, panels.filter((panel) => panel.durationInFrames == null).length),
    ),
  );

  let start = 0;
  return panels.map((panel, index) => {
    const duration = Math.max(1, panel.durationInFrames ?? fallbackDuration);
    const sourceIndex = Math.max(0, Math.min(panelCount - 1, Math.round(panel.sourceIndex ?? index)));
    const window = { index, sourceIndex, start, duration };
    start += duration;
    return window;
  });
}

function activePanel(windows: PanelWindow[], frame: number): PanelWindow {
  const found = windows.find(
    (window, index) =>
      frame >= window.start &&
      (frame < window.start + window.duration || index === windows.length - 1),
  );
  return found ?? windows[windows.length - 1] ?? { index: 0, sourceIndex: 0, start: 0, duration: 1 };
}

function directionVector(direction: TransitionDirection): [number, number] {
  switch (direction) {
    case "right":
      return [1, 0];
    case "up":
      return [0, -1];
    case "down":
      return [0, 1];
    case "left":
    default:
      return [-1, 0];
  }
}

type CameraPath = {
  startScale: number;
  endScale: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
};

function cameraPath(
  preset: CameraPreset = "drift",
  intensity = 1,
): CameraPath {
  const strength = Math.max(0, Math.min(1.5, intensity));
  const paths: Record<CameraPreset, CameraPath> = {
    drift: {
      startScale: 1.025,
      endScale: 1.055,
      startX: -7,
      endX: 7,
      startY: 3,
      endY: -3,
    },
    "push-in": {
      startScale: 1.02,
      endScale: 1.105,
      startX: 7,
      endX: -7,
      startY: 3,
      endY: -3,
    },
    "pull-out": {
      startScale: 1.105,
      endScale: 1.03,
      startX: -7,
      endX: 7,
      startY: -3,
      endY: 3,
    },
    "pan-left": {
      startScale: 1.055,
      endScale: 1.075,
      startX: 18,
      endX: -18,
      startY: 2,
      endY: -2,
    },
    "pan-right": {
      startScale: 1.055,
      endScale: 1.075,
      startX: -18,
      endX: 18,
      startY: -2,
      endY: 2,
    },
    "pan-up": {
      startScale: 1.06,
      endScale: 1.08,
      startX: 0,
      endX: 0,
      startY: 14,
      endY: -14,
    },
    "pan-down": {
      startScale: 1.06,
      endScale: 1.08,
      startX: 0,
      endX: 0,
      startY: -14,
      endY: 14,
    },
    static: {
      startScale: 1.03,
      endScale: 1.04,
      startX: 0,
      endX: 0,
      startY: 0,
      endY: 0,
    },
  };
  const base = paths[preset];
  return {
    startScale: 1 + (base.startScale - 1) * strength,
    endScale: 1 + (base.endScale - 1) * strength,
    startX: base.startX * strength,
    endX: base.endX * strength,
    startY: base.startY * strength,
    endY: base.endY * strength,
  };
}

type PanelTransition = {
  from: PanelWindow;
  to: PanelWindow;
  progress: number;
};

/**
 * Find a transition centered on a panel boundary. Centering it on the
 * boundary keeps the incoming panel in the same position after the move,
 * instead of snapping back on the first frame of the next panel.
 */
function panelTransition(
  windows: PanelWindow[],
  frame: number,
  totalFrames: number,
): PanelTransition | null {
  if (windows.length < 2 || totalFrames <= 0) return null;
  for (let index = 0; index < windows.length - 1; index += 1) {
    const from = windows[index];
    const to = windows[index + 1];
    const boundary = from.start + from.duration;
    const half = Math.max(
      1,
      Math.floor(Math.min(totalFrames, from.duration, to.duration) / 2),
    );
    const start = boundary - half;
    const end = boundary + half;
    if (frame < start || frame >= end) continue;
    const progress = interpolate(
      frame - start,
      [0, Math.max(1, end - start - 1)],
      [0, 1],
      {
        easing: Easing.inOut(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      },
    );
    return { from, to, progress };
  }
  return null;
}

function GridCrop({
  sheetUrl,
  panel,
  frame,
  duration,
  motionFrame,
  motionDuration,
  opacity = 1,
  translateX = 0,
  translateY = 0,
  layout = "2x2",
  cameraPreset = "drift",
  cameraIntensity = 1,
  blur = 0,
}: {
  sheetUrl: string;
  panel: number;
  frame: number;
  duration: number;
  motionFrame?: number;
  motionDuration?: number;
  opacity?: number;
  translateX?: number;
  translateY?: number;
  layout?: TemporalGridLayout;
  cameraPreset?: CameraPreset;
  cameraIntensity?: number;
  blur?: number;
}) {
  // Keep the camera drift continuous across panel changes instead of restarting
  // the zoom/pan at every keyframe boundary.
  const cameraDuration = Math.max(1, motionDuration ?? duration);
  const cameraFrame = Math.max(0, Math.min(cameraDuration - 1, motionFrame ?? frame));
  const progress = cameraDuration <= 1 ? 1 : cameraFrame / (cameraDuration - 1);
  const path = cameraPath(cameraPreset, cameraIntensity);
  const scale = interpolate(progress, [0, 1], [path.startScale, path.endScale], {
    easing: Easing.inOut(Easing.quad),
  });
  const driftX = interpolate(progress, [0, 1], [path.startX, path.endX], {
    easing: Easing.inOut(Easing.quad),
  });
  const driftY = interpolate(progress, [0, 1], [path.startY, path.endY], {
    easing: Easing.inOut(Easing.quad),
  });
  const { columns, rows } = gridDimensions(layout);
  const column = panel % columns;
  const row = Math.floor(panel / columns);
  const left =
    -(column * OUTPUT_WIDTH * scale + ((scale - 1) * OUTPUT_WIDTH) / 2) + driftX;
  const top =
    -(row * OUTPUT_HEIGHT * scale + ((scale - 1) * OUTPUT_HEIGHT) / 2) + driftY;

  return (
    <AbsoluteFill
      style={{
        opacity,
        overflow: "hidden",
        backgroundColor: "#17110b",
        transform: `translate3d(${translateX}px, ${translateY}px, 0)`,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
        willChange: "transform, opacity",
      }}
    >
      <Img
        src={sheetUrl}
        style={{
          position: "absolute",
          left,
          top,
          width: OUTPUT_WIDTH * columns * scale,
          height: OUTPUT_HEIGHT * rows * scale,
          maxWidth: "none",
        }}
      />
    </AbsoluteFill>
  );
}

function ShotView({ shot, frame }: { shot: TemporalGridShot; frame: number }) {
  const windows = panelWindows(shot);
  const current = activePanel(windows, frame);
  const mode = shot.transitionMode ?? "crossfade";
  const transitionFrames = mode === "push"
    ? Math.max(2, shot.transitionFrames ?? DEFAULT_PUSH_FRAMES)
    : Math.max(0, shot.transitionFrames ?? DEFAULT_TRANSITION_FRAMES);
  const transition = mode === "cut"
    ? null
    : panelTransition(windows, frame, transitionFrames);
  const transitionEffect = shot.transitionEffect ?? "dissolve";
  const transitionPulse = transition
    ? Math.sin(Math.PI * transition.progress)
    : 0;
  const transitionBlur = transitionEffect === "soft-focus"
    ? transitionPulse * 1.25
    : 0;
  const transitionDip = transitionEffect === "dip-dark"
    ? transitionPulse * 0.14
    : 0;
  const cameraProps = {
    motionFrame: frame,
    motionDuration: shot.durationInFrames,
    layout: shot.gridLayout ?? "2x2",
    cameraPreset: shot.cameraPreset ?? "drift",
    cameraIntensity: shot.cameraIntensity ?? 1,
  };

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {transition && mode === "push" ? (() => {
        const [directionX, directionY] = directionVector(
          shot.transitionDirection ?? "left",
        );
        return (
          <>
            <GridCrop
              sheetUrl={shot.sheetUrl}
              panel={transition.from.sourceIndex}
              frame={frame - transition.from.start}
              duration={transition.from.duration}
              {...cameraProps}
              translateX={directionX * OUTPUT_WIDTH * transition.progress}
              translateY={directionY * OUTPUT_HEIGHT * transition.progress}
              blur={transitionBlur}
            />
            <GridCrop
              sheetUrl={shot.sheetUrl}
              panel={transition.to.sourceIndex}
              frame={frame - transition.to.start}
              duration={transition.to.duration}
              {...cameraProps}
              translateX={
                -directionX * OUTPUT_WIDTH * (1 - transition.progress)
              }
              translateY={
                -directionY * OUTPUT_HEIGHT * (1 - transition.progress)
              }
              blur={transitionBlur}
            />
          </>
        );
      })() : transition ? (
        <>
          <GridCrop
            sheetUrl={shot.sheetUrl}
            panel={transition.from.sourceIndex}
            frame={frame - transition.from.start}
            duration={transition.from.duration}
            {...cameraProps}
            opacity={1 - transition.progress}
            blur={transitionBlur}
          />
          <GridCrop
            sheetUrl={shot.sheetUrl}
            panel={transition.to.sourceIndex}
            frame={frame - transition.to.start}
            duration={transition.to.duration}
            {...cameraProps}
            opacity={transition.progress}
            blur={transitionBlur}
          />
        </>
      ) : (
        <GridCrop
          sheetUrl={shot.sheetUrl}
          panel={current.sourceIndex}
          frame={frame - current.start}
          duration={current.duration}
          {...cameraProps}
        />
      )}
      <StoryTextOverlay shot={shot} frame={frame} />
      {transitionDip > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: "#0b0907",
            opacity: transitionDip,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
}

function shotStart(shot: TemporalGridShot, index: number, shots: TemporalGridShot[]) {
  if (typeof shot.from === "number") return shot.from;
  return shots
    .slice(0, index)
    .reduce((sum, previous) => sum + previous.durationInFrames, 0);
}

function sceneTransitionOpacity(frame: number, shots: TemporalGridShot[]) {
  for (let index = 1; index < shots.length; index += 1) {
    const boundary = shotStart(shots[index], index, shots);
    const half = Math.max(
      1,
      Math.floor(
        Math.max(2, shots[index].sceneTransitionFrames ?? DEFAULT_SCENE_FADE_FRAMES) /
          2,
      ),
    );
    const start = boundary - half;
    const end = boundary + half;
    if (frame < start || frame >= end) continue;

    if (frame < boundary) {
      return interpolate(
        frame - start,
        [0, Math.max(1, half - 1)],
        [0, SCENE_FADE_OPACITY],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
    }
    return interpolate(
      frame - boundary,
      [0, half],
      [SCENE_FADE_OPACITY, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  }
  return 0;
}

function StoryTextOverlay({
  shot,
  frame,
}: {
  shot: TemporalGridShot;
  frame: number;
}) {
  const text = shot.textOverlay;
  if (!text || (!text.context && !text.subject && !text.start && !text.result)) {
    return null;
  }

  const { fps } = useVideoConfig();
  const windows = panelWindows(shot);
  const resultStart = windows[1]?.start ?? Math.round(shot.durationInFrames * 0.5);
  const resultProgress = interpolate(
    frame,
    [Math.max(0, resultStart - 10), resultStart + 18],
    [0, 1],
    { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const introProgress = interpolate(frame, [0, 16], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitProgress = interpolate(
    frame,
    [Math.max(0, shot.durationInFrames - 16), shot.durationInFrames],
    [1, 0],
    { easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const visibleOpacity = introProgress * exitProgress;
  const startOpacity = visibleOpacity * (1 - resultProgress);
  const resultOpacity = visibleOpacity * resultProgress;
  const placement = text.placement ?? "left";
  const isRight = placement === "right";
  const textAlign = isRight ? "right" : "left";
  const actionLength = Math.max(text.start?.length ?? 0, text.result?.length ?? 0);
  const actionFontSize = actionLength > 9 ? 30 : actionLength > 6 ? 34 : 38;
  const lineWidth = Math.min(230, Math.max(112, actionLength * 21));
  const direction = isRight ? 1 : -1;

  /**
   * Borrow the timing language of lower-thirds and animated-text templates,
   * but keep it quiet enough for a story film: the rule establishes the
   * editorial position first, then each short action label follows in a
   * restrained character-by-character spring.
   */
  const actionLabel = (
    label: string | undefined,
    state: "start" | "result",
    opacity: number,
  ) => {
    if (!label) return null;
    const stateStart = state === "start" ? 0 : Math.max(0, resultStart + 2);
    const lineProgress = interpolate(
      frame,
      [stateStart, stateStart + 8],
      [0, 1],
      { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    const textStart = stateStart + 7;
    const chars = Array.from(label);
    const perCharDelay = chars.length > 10 ? 1.5 : 2.1;
    const useCharacterSpring = chars.length <= 14;
    const phraseProgress = interpolate(
      frame,
      [textStart, textStart + 14],
      [0, 1],
      { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          bottom: 0,
          opacity,
          textAlign,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            ...(isRight ? { right: 0 } : { left: 0 }),
            bottom: -15,
            width: lineWidth,
            height: 2,
            background: "linear-gradient(90deg, rgba(212,173,114,0.16), #d4ad72)",
            opacity: lineProgress,
            transform: `scaleX(${Math.max(0.01, lineProgress)})`,
            transformOrigin: isRight ? "right center" : "left center",
            boxShadow: "0 0 12px rgba(212, 173, 114, 0.28)",
          }}
        />
        <div
          style={{
            display: "inline-flex",
            justifyContent: isRight ? "flex-end" : "flex-start",
            maxWidth: 430,
            minHeight: 50,
            overflow: "visible",
            whiteSpace: "nowrap",
          }}
        >
          {useCharacterSpring
            ? chars.map((char, index) => {
                const entry = spring({
                  frame: Math.max(0, frame - textStart - index * perCharDelay),
                  fps,
                  from: 0,
                  to: 1,
                  config: { damping: state === "result" ? 14 : 16, mass: 0.58, stiffness: 115 },
                });
                const progress = Math.max(0, Math.min(1.08, entry));
                const charOpacity = Math.max(0, Math.min(1, progress));
                const y = interpolate(progress, [0, 1], [11, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const x = interpolate(progress, [0, 1], [direction * 8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const rotate = interpolate(progress, [0, 1], [direction * 1.8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const scale = interpolate(progress, [0, 1], [state === "result" ? 0.94 : 0.98, state === "result" ? 1.015 : 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                return (
                  <span
                    key={`${state}-${index}`}
                    style={{
                      display: "inline-block",
                      opacity: charOpacity,
                      transform: `translate3d(${x}px, ${y}px, 0) rotate(${rotate}deg) scale(${scale})`,
                      filter: `blur(${(1 - charOpacity) * 2.2}px)`,
                      transformOrigin: "center bottom",
                    }}
                  >
                    {char === " " ? "\u00a0" : char}
                  </span>
                );
              })
            : (
              <span
                style={{
                  display: "inline-block",
                  opacity: phraseProgress,
                  transform: `translate3d(${direction * (1 - phraseProgress) * 10}px, ${(1 - phraseProgress) * 10}px, 0)`,
                  filter: `blur(${(1 - phraseProgress) * 2}px)`,
                  clipPath: isRight
                    ? `inset(0 0 0 ${100 - phraseProgress * 100}%)`
                    : `inset(0 ${100 - phraseProgress * 100}% 0 0)`,
                }}
              >
                {label}
              </span>
            )}
        </div>
      </div>
    );
  };

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 20 }}>
      <div
        style={{
          position: "absolute",
          top: 38,
          ...(isRight ? { right: 52 } : { left: 52 }),
          width: 380,
          textAlign,
          color: "rgba(250, 244, 231, 0.94)",
          fontFamily: UI_FONT,
          textShadow: "0 2px 12px rgba(0, 0, 0, 0.82)",
          opacity: visibleOpacity,
          transform: `translate3d(${(1 - introProgress) * (isRight ? 18 : -18)}px, ${(1 - introProgress) * -8}px, 0)`,
          clipPath: isRight
            ? `inset(0 0 0 ${100 - introProgress * 100}%)`
            : `inset(0 ${100 - introProgress * 100}% 0 0)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: isRight ? "flex-end" : "flex-start",
            flexDirection: isRight ? "row-reverse" : "row",
            gap: 10,
            fontSize: 17,
            lineHeight: 1.2,
            fontWeight: 600,
          }}
        >
          <span style={{ width: 28, height: 2, backgroundColor: "#d4ad72", display: "inline-block" }} />
          <span>{text.context || ""}</span>
        </div>
        {text.subject && (
          <div style={{ marginTop: 9, fontSize: 15, lineHeight: 1.2, opacity: 0.72 }}>
            {text.subject}
          </div>
        )}
      </div>

      <div
        style={{
          position: "absolute",
          ...(isRight ? { right: 56 } : { left: 56 }),
          // Keep the editorial action label above the caption rail and away from the frame edge.
          bottom: 142,
          width: 430,
          minHeight: 72,
          textAlign,
          color: "#fff8e9",
          fontFamily: DISPLAY_FONT,
          textShadow: "0 3px 18px rgba(0, 0, 0, 0.9)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            fontSize: actionFontSize,
            lineHeight: 1.16,
            fontWeight: 700,
            color: "#fff8e9",
            fontFamily: DISPLAY_FONT,
          }}
        >
          {actionLabel(text.start, "start", startOpacity)}
          {actionLabel(text.result, "result", resultOpacity)}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function CaptionTrack({ captions }: { captions?: TemporalCaption[] }) {
  const frame = useCurrentFrame();
  if (!captions?.length) return null;

  const active = captions.find(
    (caption) => frame >= caption.startFrame && frame < caption.endFrame,
  );
  if (!active) return null;

  const duration = Math.max(1, active.endFrame - active.startFrame);
  const edge = Math.min(8, Math.max(2, Math.floor(duration / 5)));
  const local = frame - active.startFrame;
  const opacity = interpolate(local, [0, edge, Math.max(edge + 1, duration - edge), duration], [0, 1, 1, 0], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const reveal = interpolate(local, [0, Math.min(10, Math.max(3, duration - 1))], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(reveal, [0, 1], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fontSize = active.text.length > 38 ? 25 : active.text.length > 28 ? 27 : 30;

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 188,
          zIndex: 50,
          opacity: opacity * 0.86,
          background: "linear-gradient(180deg, rgba(8, 6, 5, 0), rgba(8, 6, 5, 0.72))",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 38,
          zIndex: 60,
          display: "flex",
          justifyContent: "center",
          opacity,
          transform: `translate3d(0, ${translateY}px, 0)`,
          color: "#fff9ed",
          fontFamily: UI_FONT,
          fontSize,
          lineHeight: 1.38,
          fontWeight: 600,
          textAlign: "center",
          whiteSpace: "pre-wrap",
          textShadow: "0 2px 10px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.95)",
          WebkitTextStroke: "0.25px rgba(0, 0, 0, 0.28)",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            clipPath: `inset(0 ${100 - reveal * 100}% 0 0)`,
            filter: `blur(${(1 - reveal) * 2.5}px)`,
          }}
        >
          {active.text}
        </div>
      </div>
    </>
  );
}

/**
 * Each shot owns one temporal sheet. The renderer only crops and animates its
 * story states in order; it never creates runtime cards or layers.
 */
export const TemporalGridEpisode: React.FC<TemporalGridEpisodeProps> = ({
  durationInFrames,
  audioUrl,
  shots,
  captions,
}) => {
  const frame = useCurrentFrame();
  const shotIndex = shots.findIndex((shot, index) => {
    const from = shotStart(shot, index, shots);
    return frame >= from && frame < from + shot.durationInFrames;
  });
  const shot = shots[shotIndex];
  const from = shot ? shotStart(shot, shotIndex, shots) : 0;
  const sceneFadeOpacity = sceneTransitionOpacity(frame, shots);

  return (
    <AbsoluteFill
      style={{
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        backgroundColor: "#17110b",
      }}
    >
      {audioUrl && <Audio src={audioUrl} volume={0.98} />}
      {shot && <ShotView shot={shot} frame={frame - from} />}
      <CaptionTrack captions={captions} />
      {!shot && <AbsoluteFill style={{ backgroundColor: "#17110b" }} />}
      {sceneFadeOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: "#0b0907",
            opacity: sceneFadeOpacity,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export const temporalGridDuration = (shots: TemporalGridShot[]) =>
  shots.reduce((sum, shot) => sum + shot.durationInFrames, 0);
