import { useCurrentFrame, useVideoConfig, interpolate, Img } from "remotion";

interface KenBurnsMove {
  startScale: number;
  endScale: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

const MOVES: KenBurnsMove[] = [
  { startScale: 1.05, endScale: 1.15, startX: -2, endX: 2, startY: -1, endY: 1 },
  { startScale: 1.08, endScale: 1.18, startX: 2, endX: -3, startY: 1, endY: -2 },
  { startScale: 1.03, endScale: 1.12, startX: 0, endX: 3, startY: -2, endY: 0 },
  { startScale: 1.06, endScale: 1.16, startX: -1, endX: 1, startY: 2, endY: -1 },
];

function getGridDimensions(count: number) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

function KenBurnsImage({
  src,
  move,
  style,
}: {
  src: string;
  move: KenBurnsMove;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = frame / durationInFrames;

  const scale = interpolate(
    progress,
    [0, 1],
    [move.startScale, move.endScale],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const x = interpolate(progress, [0, 1], [move.startX, move.endX], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(progress, [0, 1], [move.startY, move.endY], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Img
      src={src}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: `scale(${scale}) translate(${x}%, ${y}%)`,
        transformOrigin: "center center",
        ...style,
      }}
    />
  );
}

function Slideshow({ images }: { images: string[] }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const count = images.length;
  const segment = durationInFrames / count;
  const crossFade = Math.min(segment * 0.35, durationInFrames * 0.12);

  return (
    <>
      {images.map((src, i) => {
        const start = i * segment;
        const end = start + segment + crossFade;

        const opacity = interpolate(
          frame,
          [start, start + crossFade, end - crossFade, end],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        return (
          <div
            key={src}
            style={{
              position: "absolute",
              inset: 0,
              opacity,
            }}
          >
            <KenBurnsImage src={src} move={MOVES[i % MOVES.length]} />
          </div>
        );
      })}
    </>
  );
}

function Collage({ images }: { images: string[] }) {
  const { cols, rows } = getGridDimensions(images.length);
  const cellWidth = 100 / cols;
  const cellHeight = 100 / rows;

  return (
    <>
      {images.map((src, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return (
          <div
            key={src}
            style={{
              position: "absolute",
              left: `${col * cellWidth}%`,
              top: `${row * cellHeight}%`,
              width: `${cellWidth}%`,
              height: `${cellHeight}%`,
              overflow: "hidden",
              boxSizing: "border-box",
              border: "1px solid rgba(0,0,0,0.35)",
            }}
          >
            <KenBurnsImage src={src} move={MOVES[i % MOVES.length]} />
          </div>
        );
      })}
    </>
  );
}

export default function KenBurnsBackground({
  images,
  mode = "collage",
}: {
  images: string[];
  mode?: "slideshow" | "collage";
}) {
  if (!images.length) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        backgroundColor: "#000",
      }}
    >
      {mode === "slideshow" ? (
        <Slideshow images={images} />
      ) : (
        <Collage images={images} />
      )}

      {/* Darkening overlay so text stays readable */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.45)",
          pointerEvents: "none",
        }}
      />

      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, transparent 40%, rgba(0,0,0,0.55) 85%, rgba(0,0,0,0.8) 100%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
