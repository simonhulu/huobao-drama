import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export default function FilmBurn() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const totalFrames = durationInFrames;

  const intensity = interpolate(
    frame,
    [0, totalFrames * 0.5, totalFrames],
    [0, 0.85, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const xShift1 = 50 + Math.sin(frame * 0.05) * 30;
  const yShift1 = 50 + Math.cos(frame * 0.04) * 20;
  const xShift2 = 50 + Math.sin(frame * 0.07 + 2) * 25;
  const yShift2 = 50 + Math.cos(frame * 0.06 + 1) * 30;
  const xShift3 = 50 + Math.sin(frame * 0.03 + 4) * 20;
  const yShift3 = 50 + Math.cos(frame * 0.08 + 3) * 15;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at ${xShift1}% ${yShift1}%, rgba(249, 115, 22, ${intensity * 0.7}), transparent 60%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at ${xShift2}% ${yShift2}%, rgba(251, 191, 36, ${intensity * 0.5}), transparent 50%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at ${xShift3}% ${yShift3}%, rgba(255, 255, 255, ${intensity * 0.3}), transparent 40%)`,
        }}
      />
    </div>
  );
}
