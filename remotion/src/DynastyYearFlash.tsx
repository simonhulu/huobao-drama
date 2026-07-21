import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Audio,
} from "remotion";

interface FlashCard {
  text: string;
  sub?: string;
}

const DEFAULT_CARDS: FlashCard[] = [
  { text: "大明", sub: "Ming Dynasty" },
  { text: "万历十年", sub: "Year of Wanli 10" },
  { text: "1582", sub: "June" },
  { text: "张居正卒", sub: "Zhang Juzheng died" },
];

export const DynastyYearFlash: React.FC<{
  aspectRatio?: string;
  cards?: FlashCard[];
  bellUrl?: string;
}> = ({ cards = DEFAULT_CARDS, bellUrl }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const count = cards.length;
  const totalHold = durationInFrames * 0.75;
  const perCard = totalHold / count;
  const transition = perCard * 0.25;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0a0a0a",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily:
          '"Hiragino Sans GB", "STHeiti", "Microsoft YaHei", serif',
        overflow: "hidden",
      }}
    >
      {/* Subtle texture */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 30% 30%, rgba(60,40,20,0.25), transparent 60%)",
          pointerEvents: "none",
        }}
      />

      {cards.map((card, i) => {
        const start = i * perCard;
        const end = start + perCard + transition;

        const opacity = interpolate(
          frame,
          [start, start + transition, end - transition, end],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        const scale = interpolate(
          frame,
          [start, start + transition, end - transition, end],
          [0.85, 1, 1, 1.1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        const y = interpolate(
          frame,
          [start, start + transition, end - transition, end],
          [20, 0, 0, -20],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              opacity,
              transform: `scale(${scale}) translateY(${y}px)`,
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 120,
                fontWeight: 700,
                color: "#e8dcc0",
                letterSpacing: "0.15em",
                textShadow: "0 0 40px rgba(232,220,192,0.25)",
              }}
            >
              {card.text}
            </h1>
            {card.sub && (
              <p
                style={{
                  marginTop: 24,
                  fontSize: 28,
                  color: "#8a7f6b",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                {card.sub}
              </p>
            )}
          </div>
        );
      })}

      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.5) 80%, rgba(0,0,0,0.85) 100%)",
          pointerEvents: "none",
        }}
      />

      {bellUrl && <Audio src={bellUrl} />}
    </AbsoluteFill>
  );
};
