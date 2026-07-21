import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion";

const DEFAULT_FADE_FRAMES = 8;

export type NarrativeMotion =
  | "push-in"
  | "push-in-left"
  | "drift-down"
  | "portrait-push";

export type NarrativeShot = {
  id: number | string;
  durationInFrames: number;
  audioDurationInFrames?: number;
  imageUrl: string;
  audioUrl?: string | null;
  caption?: string;
  motion?: NarrativeMotion;
  transitionFrames?: number;
  storyFunction: string;
  action: string;
  result: string;
};

export type NarrativeEpisodeProps = {
  durationInFrames: number;
  fps?: number;
  aspectRatio?: string;
  audioVolume?: number;
  shots: NarrativeShot[];
  voice?: {
    audioConfigId?: number;
    voiceId?: string;
  };
};

type MotionValues = {
  scale: [number, number];
  x: [number, number];
  y: [number, number];
};

const MOTION_VALUES: Record<NarrativeMotion, MotionValues> = {
  "push-in": { scale: [1.04, 1.12], x: [0, -8], y: [0, -3] },
  "push-in-left": { scale: [1.045, 1.115], x: [8, -7], y: [1, -3] },
  "drift-down": { scale: [1.055, 1.12], x: [4, -4], y: [-7, 5] },
  "portrait-push": { scale: [1.04, 1.105], x: [0, -8], y: [0, -2] },
};

function motionValues(motion: NarrativeMotion | undefined): MotionValues {
  return MOTION_VALUES[motion || "push-in"];
}

function Caption({
  text,
  frame,
  durationInFrames,
}: {
  text?: string;
  frame: number;
  durationInFrames: number;
}) {
  if (!text) return null;

  const captionDuration = Math.max(1, durationInFrames);
  const opacity = interpolate(
    frame,
    [0, 8, Math.max(8, captionDuration - 10), captionDuration],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "110px 72px 42px",
        opacity,
        background:
          "linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.62) 74%, rgba(0,0,0,0.78))",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          color: "#fff8e9",
          fontFamily:
            '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: 30,
          fontWeight: 500,
          lineHeight: 1.42,
          textAlign: "center",
          letterSpacing: 0,
          textShadow: "0 2px 12px rgba(0,0,0,0.92), 0 1px 2px rgba(0,0,0,0.9)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function ShotView({
  shot,
  isLast,
  audioVolume,
}: {
  shot: NarrativeShot;
  isLast: boolean;
  audioVolume: number;
}) {
  const localFrame = useCurrentFrame();
  const sourceDuration = Math.max(1, shot.durationInFrames);
  const audioDuration = Math.min(
    sourceDuration,
    Math.max(1, shot.audioDurationInFrames ?? sourceDuration),
  );
  const transitionFrames = Math.max(
    0,
    Math.min(shot.transitionFrames ?? DEFAULT_FADE_FRAMES, Math.floor(sourceDuration / 3)),
  );
  const fadeIn = transitionFrames
    ? interpolate(localFrame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const fadeOut =
    isLast || !transitionFrames
      ? 1
      : interpolate(
          localFrame,
          [sourceDuration, sourceDuration + transitionFrames],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
  const progress = interpolate(localFrame, [0, sourceDuration - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const motion = motionValues(shot.motion);
  const scale = interpolate(progress, [0, 1], motion.scale);
  const x = interpolate(progress, [0, 1], motion.x);
  const y = interpolate(progress, [0, 1], motion.y);
  const captionFrame = Math.min(localFrame, audioDuration);

  return (
    <AbsoluteFill
      style={{
        opacity: fadeIn * fadeOut,
        overflow: "hidden",
        backgroundColor: "#0c0a08",
      }}
    >
      <Img
        src={shot.imageUrl}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
          transformOrigin: "center center",
          filter: "contrast(1.035) saturate(0.96)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.34) 100%)",
          pointerEvents: "none",
        }}
      />
      <Caption
        text={shot.caption}
        frame={captionFrame}
        durationInFrames={audioDuration}
      />
      {shot.audioUrl && <Audio src={shot.audioUrl} volume={audioVolume} />}
    </AbsoluteFill>
  );
}

/**
 * Narrative-first renderer: one complete image owns each shot. Remotion only
 * performs timing, a restrained camera move, readable subtitles, and audio;
 * it never creates runtime cards, cutout layers, or synthetic scene plates.
 */
export const NarrativeEpisode: React.FC<NarrativeEpisodeProps> = ({
  durationInFrames,
  audioVolume = 0.98,
  shots,
}) => {
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#0c0a08", overflow: "hidden" }}>
      {shots.map((shot, index) => {
        const from = cursor;
        cursor += shot.durationInFrames;
        const isLast = index === shots.length - 1;
        const transitionFrames = isLast
          ? 0
          : Math.max(0, shot.transitionFrames ?? DEFAULT_FADE_FRAMES);
        return (
          <Sequence
            key={`${shot.id}-${from}`}
            from={from}
            durationInFrames={Math.min(
              durationInFrames - from,
              shot.durationInFrames + transitionFrames,
            )}
            premountFor={12}
          >
            <ShotView
              shot={shot}
              isLast={isLast}
              audioVolume={audioVolume}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
