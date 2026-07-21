import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Audio,
  Img,
} from "remotion";

interface RecapCarouselProps {
  dramaTitle?: string;
  recapScript?: string;
  imageUrls: string[];
  audioUrl: string;
}

const TITLE_CARD_SECONDS = 1.5;

export const RecapCarousel: React.FC<RecapCarouselProps> = ({
  dramaTitle,
  recapScript,
  imageUrls,
  audioUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const titleCardFrames = TITLE_CARD_SECONDS * fps;
  const isTitleCard = frame < titleCardFrames;

  // Title card fade in/out
  const titleOpacity = interpolate(
    frame,
    [0, 0.2 * fps, titleCardFrames - 0.2 * fps, titleCardFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Carousel shows after title card
  const carouselFrame = Math.max(0, frame - titleCardFrames);
  const cycleLength = fps * 2.2; // each image holds ~2.2s
  const progress = carouselFrame / cycleLength;
  const slides = imageUrls.length > 0 ? imageUrls : [undefined];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0a0a0a",
        fontFamily:
          '"Hiragino Sans GB", "STHeiti", "Microsoft YaHei", sans-serif',
        overflow: "hidden",
      }}
    >
      {audioUrl && <Audio src={audioUrl} />}

      {/* Title Card */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          opacity: titleOpacity,
          zIndex: isTitleCard ? 2 : 0,
          pointerEvents: "none",
        }}
      >
        <h1
          style={{
            fontSize: Math.min(96, Math.round(width / 10)),
            fontWeight: 400,
            color: "#ffffff",
            margin: 0,
            letterSpacing: "0.1em",
          }}
        >
          前情提要
        </h1>
        {dramaTitle && (
          <p
            style={{
              fontSize: Math.min(40, Math.round(width / 28)),
              color: "#a0a0a0",
              marginTop: 24,
              letterSpacing: "0.05em",
            }}
          >
            {dramaTitle}
          </p>
        )}
      </div>

      {/* Image Carousel */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          opacity: isTitleCard ? 0 : 1,
          zIndex: 1,
        }}
      >
        {slides.map((url, i) => {
          const offset = i - progress;
          const normalizedOffset =
            ((offset % slides.length) + slides.length) % slides.length;
          // Use shortest distance around the circle
          const signedOffset =
            normalizedOffset > slides.length / 2
              ? normalizedOffset - slides.length
              : normalizedOffset;

          const translateX = signedOffset * (width * 0.32);
          const translateZ = interpolate(
            Math.abs(signedOffset),
            [0, 1, 2],
            [0, -80, -160],
            { extrapolateRight: "clamp" }
          );
          const scale = interpolate(
            Math.abs(signedOffset),
            [0, 1, 2],
            [1, 0.72, 0.52],
            { extrapolateRight: "clamp" }
          );
          const opacity = interpolate(
            Math.abs(signedOffset),
            [0, 1, 2],
            [1, 0.55, 0.2],
            { extrapolateRight: "clamp" }
          );
          const zIndex = 10 - Math.round(Math.abs(signedOffset));

          return (
            <div
              key={`${url}-${i}`}
              style={{
                position: "absolute",
                width: Math.round(width * 0.38),
                height: Math.round(height * 0.72),
                borderRadius: 12,
                overflow: "hidden",
                transform: `translateX(${translateX}px) translateZ(${translateZ}px) scale(${scale})`,
                opacity,
                zIndex,
                boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
                backgroundColor: "#222",
              }}
            >
              {url ? (
                <Img
                  src={url}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background:
                      "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Recap script subtitle */}
      {recapScript && (
        <div
          style={{
            position: "absolute",
            bottom: Math.round(height * 0.08),
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "80%",
              padding: "16px 28px",
              backgroundColor: "rgba(0,0,0,0.55)",
              borderRadius: 8,
              textAlign: "center",
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: Math.min(32, Math.round(width / 36)),
                color: "#ffffff",
                lineHeight: 1.5,
                textShadow: "0 2px 8px rgba(0,0,0,0.8)",
              }}
            >
              {recapScript}
            </p>
          </div>
        </div>
      )}

      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
          pointerEvents: "none",
          zIndex: 4,
        }}
      />
    </AbsoluteFill>
  );
};
