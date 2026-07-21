import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Audio,
} from "remotion";
import KenBurnsBackground from "./KenBurnsBackground";

const gradientTextStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #a0a0a0 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  backgroundClip: "text",
  color: "transparent",
};

export const BlackTitleIntro: React.FC<{
  aspectRatio?: string;
  mainText: string;
  subText: string;
  images?: string[];
  bgmUrl?: string;
}> = ({ mainText, subText, images = [], bgmUrl }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const fadeInFrames = 0.75 * fps;
  const fadeOutStart = durationInFrames - 0.75 * fps;
  const subDelayFrames = 0.25 * fps;

  const mainOpacity = interpolate(
    frame,
    [0, fadeInFrames, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const subOpacity = interpolate(
    frame,
    [
      subDelayFrames,
      subDelayFrames + fadeInFrames,
      fadeOutStart + subDelayFrames,
      durationInFrames,
    ],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#000000",
        fontFamily:
          '"Hiragino Sans GB", "STHeiti", "Microsoft YaHei", sans-serif',
      }}
    >
      <KenBurnsBackground images={images} mode="collage" />
      {bgmUrl && <Audio src={bgmUrl} />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 1,
        }}
      >
        <h1
          style={{
            ...gradientTextStyle,
            fontSize: 96,
            margin: 0,
            fontWeight: 400,
            opacity: mainOpacity,
          }}
        >
          {mainText}
        </h1>
        <p
          style={{
            ...gradientTextStyle,
            fontSize: 52,
            marginTop: 24,
            fontWeight: 400,
            opacity: subOpacity,
          }}
        >
          {subText}
        </p>
      </div>
    </AbsoluteFill>
  );
};
