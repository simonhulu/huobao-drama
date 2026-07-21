import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Img,
  Audio,
} from "remotion";
import FilmBurn from "./FilmBurn";

export const VintageKenBurns: React.FC<{
  aspectRatio?: string;
  image: string;
  title?: string;
  subtitle?: string;
  audioUrl?: string;
}> = ({ image, title, subtitle, audioUrl }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = frame / durationInFrames;

  // Slow Ken Burns: zoom from 1.1 to 1.25 and pan slightly
  const scale = interpolate(progress, [0, 1], [1.1, 1.28], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(progress, [0, 1], [-3, 3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(progress, [0, 1], [-1, 2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Title fades in/out
  const textOpacity = interpolate(
    frame,
    [0, durationInFrames * 0.2, durationInFrames * 0.75, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#1a1510",
        overflow: "hidden",
      }}
    >
      {/* Sepia-toned image with Ken Burns */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${scale}) translate(${x}%, ${y}%)`,
          filter: "sepia(0.55) contrast(1.05) brightness(0.85)",
        }}
      >
        <Img
          src={image}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </div>

      {/* Film grain overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.18,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          pointerEvents: "none",
          mixBlendMode: "overlay",
        }}
      />

      {/* Dust & scratches */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 3px)",
          pointerEvents: "none",
          opacity: 0.4,
        }}
      />

      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, transparent 30%, rgba(20,15,10,0.5) 70%, rgba(10,8,5,0.9) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Film burn / light leak */}
      <FilmBurn />

      {/* Optional title */}
      {(title || subtitle) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            opacity: textOpacity,
            pointerEvents: "none",
          }}
        >
          {title && (
            <h1
              style={{
                margin: 0,
                fontSize: 84,
                color: "#f0e6d2",
                fontFamily:
                  '"Hiragino Sans GB", "STHeiti", "Microsoft YaHei", serif',
                fontWeight: 500,
                letterSpacing: "0.1em",
                textShadow: "0 2px 20px rgba(0,0,0,0.6)",
              }}
            >
              {title}
            </h1>
          )}
          {subtitle && (
            <p
              style={{
                marginTop: 16,
                fontSize: 36,
                color: "#c9bba0",
                fontFamily:
                  '"Hiragino Sans GB", "STHeiti", "Microsoft YaHei", sans-serif',
                letterSpacing: "0.05em",
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}

      {audioUrl && <Audio src={audioUrl} />}
    </AbsoluteFill>
  );
};
