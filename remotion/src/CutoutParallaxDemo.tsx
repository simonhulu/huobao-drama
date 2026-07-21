import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export interface CutoutParallaxDemoProps {
  background?: string;
  subject?: string;
  foreground?: string;
}

const fontFamily =
  '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';

export const CutoutParallaxDemo: React.FC<CutoutParallaxDemoProps> = ({
  background = staticFile("war-map/background.png"),
  subject = staticFile("cutout-poc/subject.png"),
  foreground = staticFile("war-map/foreground.png"),
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });
  const backgroundScale = interpolate(progress, [0, 1], [1.02, 1.1]);
  const subjectScale = interpolate(progress, [0, 1], [0.86, 0.98]);
  const subjectX = interpolate(progress, [0, 1], [-34, 28]);
  const subjectY = interpolate(progress, [0, 1], [34, -8]);
  const foregroundX = interpolate(progress, [0, 1], [18, -20]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#111318", overflow: "hidden" }}>
      <Img
        src={background}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${backgroundScale})`,
          filter: "brightness(0.72) saturate(0.82)",
        }}
      />

      <AbsoluteFill
        style={{
          backgroundColor: "rgba(12, 15, 24, 0.28)",
          mixBlendMode: "multiply",
        }}
      />

      <Img
        src={subject}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "68%",
          height: "96%",
          objectFit: "contain",
          objectPosition: "center bottom",
          transform: `translate(calc(-50% + ${subjectX}px), calc(-50% + ${subjectY}px)) scale(${subjectScale})`,
          filter: "drop-shadow(0 22px 22px rgba(0, 0, 0, 0.42))",
        }}
      />

      <Img
        src={foreground}
        style={{
          position: "absolute",
          width: "112%",
          height: "112%",
          left: "50%",
          top: "50%",
          objectFit: "cover",
          transform: `translate(calc(-50% + ${foregroundX}px), -50%)`,
          opacity: 0.22,
          mixBlendMode: "screen",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 42,
          top: 34,
          color: "rgba(255, 244, 219, 0.88)",
          fontFamily,
          fontSize: 18,
          letterSpacing: 1,
          textShadow: "0 2px 12px rgba(0, 0, 0, 0.8)",
        }}
      >
        CUTOUT / PARALLAX TEST
      </div>

      <div
        style={{
          position: "absolute",
          left: 42,
          bottom: 34,
          color: "rgba(255, 244, 219, 0.76)",
          fontFamily,
          fontSize: 16,
          textShadow: "0 2px 10px rgba(0, 0, 0, 0.8)",
        }}
      >
        background / transparent subject / foreground
      </div>
    </AbsoluteFill>
  );
};
