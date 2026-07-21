import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  chinaMapBounds,
  chinaProvincePaths,
  chinaRiverPaths,
} from "./chinaMapData";

type Point = { x: number; y: number };
type GeoPoint = { lon: number; lat: number };

export interface WarMapParallaxDemoProps {
  image: string;
  backgroundLayer?: string;
  foregroundLayer?: string;
  title?: string;
}

const fontFamily =
  '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const segmentProgress = (frame: number, start: number, end: number) =>
  clamp01((frame - start) / Math.max(1, end - start));

const eased = (
  frame: number,
  start: number,
  end: number,
  easing: (value: number) => number = Easing.inOut(Easing.ease),
) => easing(segmentProgress(frame, start, end));

const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

const projectGeo = ({ lon, lat }: GeoPoint): Point => ({
  x:
    chinaMapBounds.left +
    ((lon - chinaMapBounds.minLon) /
      (chinaMapBounds.maxLon - chinaMapBounds.minLon)) *
      chinaMapBounds.width,
  y:
    chinaMapBounds.top +
    ((chinaMapBounds.maxLat - lat) /
      (chinaMapBounds.maxLat - chinaMapBounds.minLat)) *
      chinaMapBounds.height,
});

const pointAlong = (points: Point[], progress: number): Point => {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];

  const scaled = clamp01(progress) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const localProgress = scaled - index;
  return {
    x: lerp(points[index].x, points[index + 1].x, localProgress),
    y: lerp(points[index].y, points[index + 1].y, localProgress),
  };
};

const routePath = (points: Point[]) =>
  points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

const sceneTransform = (
  scale: number,
  x: number,
  y: number,
  rotate = 0,
) =>
  `translate3d(${x}px, ${y}px, 0) scale(${scale}) rotate(${rotate}deg)`;

const CameraBadge: React.FC<{ children: string; accent?: string }> = ({
  children,
  accent = "#e9b949",
}) => (
  <div
    style={{
      position: "absolute",
      top: 30,
      left: 36,
      display: "flex",
      alignItems: "center",
      gap: 10,
      color: "rgba(255, 248, 226, 0.92)",
      fontFamily,
      fontSize: 18,
      letterSpacing: 1,
      textShadow: "0 2px 10px rgba(0,0,0,0.7)",
      zIndex: 20,
    }}
  >
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: accent,
        boxShadow: `0 0 18px ${accent}`,
      }}
    />
    {children}
  </div>
);

const DustField: React.FC<{ frame: number; count?: number }> = ({
  frame,
  count = 26,
}) => {
  const particles = Array.from({ length: count }, (_, index) => {
    const x = (index * 47 + 13) % 100;
    const y = (index * 71 + 9) % 100;
    const size = 2 + ((index * 7) % 5);
    const drift = ((frame * (0.12 + (index % 4) * 0.04) + index * 19) % 130) - 15;
    const opacity = 0.08 + ((index * 13) % 5) * 0.025;
    return { x, y, size, drift, opacity };
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 12,
      }}
    >
      {particles.map((particle, index) => (
        <span
          key={index}
          style={{
            position: "absolute",
            left: `${particle.x}%`,
            top: `${particle.y}%`,
            width: particle.size,
            height: particle.size,
            borderRadius: "50%",
            background: "#f5d99b",
            opacity: particle.opacity,
            transform: `translate3d(${particle.drift}px, ${
              Math.sin(frame / 24 + index) * 5
            }px, 0)`,
            filter: "blur(0.5px)",
          }}
        />
      ))}
    </div>
  );
};

const WindFlag: React.FC<{ frame: number }> = ({ frame }) => {
  const phase = frame / 8;
  const width = 172;
  const height = 86;
  const segments = 9;
  const top: Point[] = [];
  const bottom: Point[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const x = (width / segments) * index;
    const wave = Math.sin(phase + index * 0.82) * 6 + Math.sin(phase * 0.55 + index) * 3;
    top.push({ x, y: 7 + wave });
    bottom.push({ x, y: height - 8 + wave });
  }

  const flagPath = [
    `M ${top[0].x} ${top[0].y}`,
    ...top.slice(1).map((point) => `L ${point.x} ${point.y}`),
    ...bottom
      .slice()
      .reverse()
      .map((point) => `L ${point.x} ${point.y}`),
    "Z",
  ].join(" ");

  return (
    <svg
      viewBox="0 0 220 170"
      style={{
        position: "absolute",
        left: 76,
        top: 72,
        width: 220,
        height: 170,
        zIndex: 16,
        opacity: 0.86,
        filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.38))",
      }}
    >
      <path d="M 24 8 L 24 158" stroke="#7d5b39" strokeWidth="5" />
      <path d="M 17 158 L 31 158" stroke="#b28a4e" strokeWidth="5" />
      <path d={flagPath} transform="translate(26 18)" fill="#a52d27" opacity="0.92" />
      <path
        d={flagPath}
        transform="translate(26 18)"
        fill="none"
        stroke="#e3a143"
        strokeWidth="2"
        opacity="0.72"
      />
      <text
        x="112"
        y="78"
        textAnchor="middle"
        fill="#f6d797"
        fontSize="24"
        fontFamily={fontFamily}
        fontWeight="700"
      >
        军
      </text>
    </svg>
  );
};

const LayeredImageScene: React.FC<{
  frame: number;
  image: string;
  backgroundLayer: string;
  foregroundLayer: string;
}> = ({ frame, image, backgroundLayer, foregroundLayer }) => {
  const beat =
    frame < 54
      ? { start: 0, end: 54, kind: "wide" as const }
      : frame < 111
        ? { start: 54, end: 111, kind: "medium" as const }
        : frame < 153
          ? { start: 111, end: 153, kind: "detail" as const }
          : { start: 153, end: 195, kind: "close" as const };
  const p = eased(frame, beat.start, beat.end);
  const settle = eased(frame, beat.start, beat.end, Easing.out(Easing.ease));

  let baseScale = 1.06;
  let baseX = 0;
  let baseY = 0;
  let focusLabel = "环境全景 · 建立关系";

  if (beat.kind === "wide") {
    baseScale = lerp(1.04, 1.1, p);
    baseX = lerp(-10, 15, p);
    baseY = lerp(-4, 2, p);
    focusLabel = "0–1.8s  环境全景 · 建立关系";
  } else if (beat.kind === "medium") {
    baseScale = lerp(1.12, 1.22, settle);
    baseX = lerp(-40, -120, settle);
    baseY = lerp(-4, -17, settle);
    focusLabel = "1.8–3.7s  人物中景 · 进入心理";
  } else if (beat.kind === "detail") {
    baseScale = lerp(1.44, 1.6, settle);
    baseX = lerp(320, 395, settle);
    baseY = lerp(-30, -72, settle);
    focusLabel = "3.7–5.1s  道具特写 · 揭示线索";
  } else {
    baseScale = lerp(1.42, 1.62, settle);
    baseX = lerp(-330, -410, settle);
    baseY = lerp(-42, -72, settle);
    focusLabel = "5.1–6.5s  面部近景 · 情绪落点";
  }

  const bgScale = baseScale + 0.035;
  const fgScale = baseScale + 0.065;
  const breathe = Math.sin(frame / 19) * 1.2;
  const useCleanCrop = beat.kind === "detail" || beat.kind === "close";

  return (
    <AbsoluteFill style={{ background: "#160f0a", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: -80,
          overflow: "hidden",
          background: "#1b120b",
        }}
      >
        <Img
          src={backgroundLayer}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: sceneTransform(bgScale, baseX * 0.18, baseY * 0.18),
            transformOrigin: "center",
            filter: "blur(0.3px) saturate(0.85)",
          }}
        />
        <Img
          src={foregroundLayer}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: sceneTransform(
              fgScale,
              baseX + Math.sin(frame / 31) * 3,
              baseY + breathe,
            ),
            transformOrigin: "center",
            mixBlendMode: "normal",
            opacity: beat.kind === "detail" ? 0.74 : 0.92,
          }}
        />
        {useCleanCrop && (
          <Img
            src={image}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: sceneTransform(baseScale, baseX, baseY),
              transformOrigin: "center",
            }}
          />
        )}
      </div>

      <CameraBadge>{focusLabel}</CameraBadge>
      <WindFlag frame={frame} />
      <DustField frame={frame} />

      <div
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          bottom: 34,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          zIndex: 20,
          color: "#f6e5c2",
          fontFamily,
          textShadow: "0 2px 12px rgba(0,0,0,0.8)",
        }}
      >
        <div>
          <div style={{ fontSize: 31, fontWeight: 700, letterSpacing: 2 }}>
            {"张居正 · 大明风云"}
          </div>
          <div style={{ marginTop: 8, fontSize: 15, opacity: 0.74, letterSpacing: 1 }}>
            背景 / 人物 / 前景深度分层 · 相对位移 0.2× / 0.5× / 1×
          </div>
        </div>
        <div
          style={{
            padding: "9px 14px",
            border: "1px solid rgba(230, 191, 102, 0.56)",
            color: "#e7bd63",
            fontSize: 14,
            letterSpacing: 1,
            background: "rgba(20, 12, 8, 0.48)",
          }}
        >
          DEPTH PARALLAX / LOCAL MODEL
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 18,
          background:
            "linear-gradient(90deg, rgba(9,7,5,0.38), transparent 28%, transparent 72%, rgba(9,7,5,0.46)), linear-gradient(0deg, rgba(8,5,3,0.58), transparent 35%)",
        }}
      />
    </AbsoluteFill>
  );
};

const City: React.FC<{
  point: Point;
  label: string;
  color: string;
  active: number;
  index: number;
  labelDx?: number;
  labelDy?: number;
}> = ({ point, label, color, active, index, labelDx = 14, labelDy = 5 }) => {
  const pulse = 1 + Math.max(0, Math.sin(active / 9 + index)) * 0.85;
  return (
    <g>
      <circle
        cx={point.x}
        cy={point.y}
        r={18 * pulse}
        fill="none"
        stroke={color}
        strokeWidth="2"
        opacity={0.16 + Math.max(0, Math.sin(active / 9 + index)) * 0.28}
      />
      <circle cx={point.x} cy={point.y} r="7" fill="#f8eed8" stroke={color} strokeWidth="3" />
      <text
        x={point.x + labelDx}
        y={point.y + labelDy}
        fill="#392d25"
        fontSize="16"
        fontFamily={fontFamily}
        fontWeight="700"
        paintOrder="stroke fill"
        stroke="#f5e8cc"
        strokeWidth="4"
      >
        {label}
      </text>
    </g>
  );
};

const ArmyMarker: React.FC<{
  point: Point;
  color: string;
  label: string;
  rotation: number;
}> = ({ point, color, label, rotation }) => (
  <g transform={`translate(${point.x} ${point.y}) rotate(${rotation})`}>
    <circle r="15" fill="#f6e8ca" stroke={color} strokeWidth="3" opacity="0.96" />
    <path d="M -7 4 L 0 -8 L 7 4 L 3 4 L 3 9 L -3 9 L -3 4 Z" fill={color} />
    <text
      x="0"
      y="31"
      textAnchor="middle"
      fill="#392d25"
      fontSize="13"
      fontFamily={fontFamily}
      fontWeight="700"
      paintOrder="stroke"
      stroke="#f5e8cc"
      strokeWidth="4"
    >
      {label}
    </text>
  </g>
);

const PortraitBadge: React.FC<{ image: string; point: Point; label: string }> = ({
  image,
  point,
  label,
}) => (
  <g transform={`translate(${point.x} ${point.y})`}>
    <circle r="38" fill="#111719" stroke="#e4b84f" strokeWidth="3" />
    <clipPath id="portrait-clip">
      <circle r="31" />
    </clipPath>
    <image
      href={image}
      x="-45"
      y="-30"
      width="90"
      height="60"
      preserveAspectRatio="xMidYMid slice"
      clipPath="url(#portrait-clip)"
    />
    <text
      x="0"
      y="58"
      textAnchor="middle"
      fill="#f7e5bd"
      fontSize="15"
      fontFamily={fontFamily}
      paintOrder="stroke"
      stroke="#15181a"
      strokeWidth="5"
    >
      {label}
    </text>
  </g>
);

const RouteTrail: React.FC<{
  points: Point[];
  progress: number;
  color: string;
  frame: number;
}> = ({ points, progress, color, frame }) => {
  if (progress <= 0.01) return null;
  return (
    <g pointerEvents="none">
      {Array.from({ length: 6 }, (_, index) => {
        const trailProgress = progress - index * 0.025;
        const point = pointAlong(points, trailProgress);
        const opacity = Math.max(0.08, 0.58 - index * 0.085);
        const breathe = 1 + Math.sin(frame / 4 + index) * 0.18;
        return (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={2.5 * breathe}
            fill={color}
            opacity={opacity}
          />
        );
      })}
    </g>
  );
};

const RouteHead: React.FC<{
  point: Point;
  color: string;
  frame: number;
  opacity: number;
}> = ({ point, color, frame, opacity }) => {
  const pulse = 1 + Math.sin(frame / 3) * 0.18;
  return (
    <g transform={`translate(${point.x} ${point.y})`} opacity={opacity} pointerEvents="none">
      <circle r={8 * pulse} fill="none" stroke={color} strokeWidth="2" opacity="0.42" />
      <circle r="3.5" fill="#fff0c7" stroke={color} strokeWidth="2" />
    </g>
  );
};

const BattlePulse: React.FC<{
  point: Point;
  frame: number;
  start: number;
  end: number;
  color: string;
}> = ({ point, frame, start, end, color }) => {
  if (frame < start || frame > end) return null;
  const progress = eased(frame, start, end, Easing.out(Easing.ease));
  const opacity = 1 - progress;
  const radius = 10 + progress * 48;
  return (
    <g transform={`translate(${point.x} ${point.y})`} pointerEvents="none">
      <circle r={radius} fill="none" stroke={color} strokeWidth={2.5 - progress * 1.4} opacity={opacity * 0.82} />
      <circle r={radius * 0.62} fill="none" stroke="#f7e2b7" strokeWidth="1" strokeDasharray="3 7" opacity={opacity * 0.56} />
      {[0, 45, 90, 135].map((rotation) => (
        <line
          key={rotation}
          x1="0"
          y1={-radius - 5}
          x2="0"
          y2={-radius - 15}
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          opacity={opacity * 0.62}
          transform={`rotate(${rotation})`}
        />
      ))}
      <circle r="5" fill={color} opacity={opacity * 0.8} />
    </g>
  );
};

const MapDust: React.FC<{ frame: number }> = ({ frame }) => (
  <g pointerEvents="none" opacity="0.62">
    {Array.from({ length: 18 }, (_, index) => {
      const x = 92 + ((index * 157) % 1010);
      const baseY = 112 + ((index * 83) % 430);
      const drift = ((frame * (0.18 + (index % 3) * 0.06) + index * 21) % 42) - 21;
      const y = baseY + Math.sin(frame / 19 + index) * 4;
      return (
        <circle
          key={index}
          cx={x + drift}
          cy={y}
          r={1.2 + (index % 3) * 0.6}
          fill="#fff1cf"
          opacity={0.12 + (index % 4) * 0.035}
        />
      );
    })}
  </g>
);

const WarMapScene: React.FC<{ frame: number; image: string; title: string }> = ({
  frame,
  image,
  title,
}) => {
  const { fps } = useVideoConfig();
  const mapFrame = frame - 195;
  const titleIn = spring({
    frame: Math.max(0, mapFrame - 2),
    fps,
    config: { damping: 18, stiffness: 120 },
  });
  const routeOneProgress = eased(mapFrame, 12, 76, Easing.out(Easing.ease));
  const routeTwoProgress = eased(mapFrame, 54, 116, Easing.out(Easing.ease));
  const advanceOne = eased(mapFrame, 72, 160, Easing.inOut(Easing.ease));
  const advanceTwo = eased(mapFrame, 112, 184, Easing.inOut(Easing.ease));
  const cityFlash = eased(mapFrame, 148, 188, Easing.out(Easing.ease));
  const cameraIn = eased(mapFrame, 0, 48, Easing.out(Easing.ease));
  const cameraFocus = eased(mapFrame, 42, 108, Easing.inOut(Easing.ease));
  const cameraOut = eased(mapFrame, 145, 188, Easing.in(Easing.ease));

  // Historical names are kept for the story, while every endpoint is tied to
  // the modern geographic coordinate of that place.
  const routeOneGeo: GeoPoint[] = [
    { lon: 112.2398, lat: 30.3351 },
    { lon: 112.14, lat: 31.15 },
    { lon: 112.122, lat: 32.009 },
    { lon: 112.22, lat: 33.2 },
    { lon: 112.454, lat: 34.6197 },
    { lon: 111.15, lat: 34.48 },
    { lon: 109.75, lat: 34.35 },
    { lon: 108.9398, lat: 34.3416 },
  ];
  const routeTwoGeo: GeoPoint[] = [
    { lon: 118.7969, lat: 32.0603 },
    { lon: 118.0, lat: 32.4 },
    { lon: 116.9, lat: 33.0 },
    { lon: 115.8, lat: 33.6 },
    { lon: 114.5, lat: 34.1 },
    { lon: 112.454, lat: 34.6197 },
  ];
  const routeOne = routeOneGeo.map(projectGeo);
  const routeTwo = routeTwoGeo.map(projectGeo);
  const jingzhou = projectGeo({ lon: 112.2398, lat: 30.3351 });
  const xiangyang = projectGeo({ lon: 112.122, lat: 32.009 });
  const luoyang = projectGeo({ lon: 112.454, lat: 34.6197 });
  const jianye = projectGeo({ lon: 118.7969, lat: 32.0603 });
  const changAn = projectGeo({ lon: 108.9398, lat: 34.3416 });
  const commandPoint = projectGeo({ lon: 110.2, lat: 38.2 });
  const armyOne = pointAlong(routeOne, advanceOne);
  const armyTwo = pointAlong(routeTwo, advanceTwo);
  const routeOneHead = pointAlong(routeOne, routeOneProgress);
  const routeTwoHead = pointAlong(routeTwo, routeTwoProgress);
  const mapScale = 0.96 + cameraIn * 0.055 + cameraFocus * 0.035 - cameraOut * 0.045;
  const mapX = -12 * cameraIn - 18 * cameraFocus + 16 * cameraOut;
  const mapY = -6 * cameraIn - 8 * cameraFocus + 8 * cameraOut;
  const titleOpacity = clamp01(titleIn * 1.5);
  const provinceFills = ["#e9d8b7", "#e4cfaa", "#eddcbd", "#dfc69f"];
  const regionLabels = [
    { lon: 104.8, lat: 35.4, text: "陇右" },
    { lon: 108.55, lat: 34.9, text: "关中" },
    { lon: 111.7, lat: 36.0, text: "河洛" },
    { lon: 112.0, lat: 31.2, text: "荆襄" },
    { lon: 116.1, lat: 33.2, text: "淮南" },
    { lon: 118.0, lat: 29.7, text: "江东" },
  ];

  return (
    <AbsoluteFill
      style={{
        background: "#a9c1c1",
        color: "#392d25",
        fontFamily,
        overflow: "hidden",
      }}
    >
      <svg
        viewBox="0 0 1280 720"
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0 }}
        shapeRendering="geometricPrecision"
      >
        <defs>
          <linearGradient id="sea-wash" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b9cecb" />
            <stop offset="0.55" stopColor="#a5bfc0" />
            <stop offset="1" stopColor="#8eabad" />
          </linearGradient>
          <linearGradient id="land-paper" x1="0" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor="#f1e2c1" />
            <stop offset="0.5" stopColor="#e7d3ad" />
            <stop offset="1" stopColor="#d7bd90" />
          </linearGradient>
          <radialGradient id="edge-vignette" cx="50%" cy="46%" r="70%">
            <stop offset="0.6" stopColor="#3f4f4e" stopOpacity="0" />
            <stop offset="1" stopColor="#263a3b" stopOpacity="0.46" />
          </radialGradient>
          <pattern id="sea-lines" width="84" height="42" patternUnits="userSpaceOnUse">
            <path d="M 0 12 C 16 4 28 20 42 12 S 68 4 84 12" fill="none" stroke="#e0ece5" strokeOpacity="0.28" strokeWidth="1" />
            <path d="M -16 31 C 0 23 12 39 26 31 S 52 23 68 31 S 94 23 110 31" fill="none" stroke="#6f9698" strokeOpacity="0.15" strokeWidth="1" />
          </pattern>
          <pattern id="paper-fibers" width="78" height="78" patternUnits="userSpaceOnUse">
            <path d="M 8 16 L 72 12 M 18 58 L 66 65 M 4 42 L 32 45" stroke="#8f6d4d" strokeOpacity="0.09" strokeWidth="1" />
            <circle cx="18" cy="28" r="1" fill="#8f6d4d" fillOpacity="0.1" />
            <circle cx="61" cy="35" r="1" fill="#8f6d4d" fillOpacity="0.08" />
          </pattern>
          <filter id="map-shadow" x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="9" stdDeviation="12" floodColor="#314848" floodOpacity="0.28" />
          </filter>
          <filter id="route-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="1280" height="720" fill="url(#sea-wash)" />
        <rect width="1280" height="720" fill="url(#sea-lines)" opacity="0.48" />
        <rect x="42" y="54" width="1196" height="616" fill="#f0e2c2" fillOpacity="0.18" stroke="#e9dec8" strokeOpacity="0.64" strokeWidth="1" filter="url(#map-shadow)" />

        <g transform={`translate(${mapX} ${mapY}) scale(${mapScale})`}>
          <rect x="62" y="80" width="1092" height="516" fill="url(#land-paper)" fillOpacity="0.22" />

          {chinaProvincePaths.map((province, index) => (
            <path
              key={province.name}
              d={province.d}
              fill={provinceFills[index % provinceFills.length]}
              fillRule="evenodd"
              stroke="#9e8561"
              strokeWidth="1.15"
              strokeLinejoin="round"
              opacity="0.9"
            />
          ))}

          <rect x="68" y="86" width="1080" height="500" fill="url(#paper-fibers)" opacity="0.5" pointerEvents="none" />
          <MapDust frame={mapFrame} />

          <g opacity="0.18">
            {[100, 105, 110, 115, 120].map((lon) => {
              const top = projectGeo({ lon, lat: chinaMapBounds.maxLat });
              const bottom = projectGeo({ lon, lat: chinaMapBounds.minLat });
              return <line key={`lon-${lon}`} x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} stroke="#6f6657" strokeDasharray="2 12" />;
            })}
            {[22, 26, 30, 34, 38].map((lat) => {
              const left = projectGeo({ lon: chinaMapBounds.minLon, lat });
              const right = projectGeo({ lon: chinaMapBounds.maxLon, lat });
              return <line key={`lat-${lat}`} x1={left.x} y1={left.y} x2={right.x} y2={right.y} stroke="#6f6657" strokeDasharray="2 12" />;
            })}
          </g>

          {chinaRiverPaths.map((river, index) => {
            const majorRiver = river.name === "Chang Jiang" || river.name === "Yangtze";
            return (
              <g key={`${river.name}-${index}`}>
                <path
                  d={river.d}
                  fill="none"
                  stroke="#4f8d91"
                  strokeWidth={majorRiver ? 3 : 1.5}
                  strokeLinecap="round"
                  opacity={majorRiver ? 0.72 : 0.34}
                />
                <path
                  d={river.d}
                  fill="none"
                  stroke="#e2f0dc"
                  strokeWidth={majorRiver ? 1.5 : 0.8}
                  strokeLinecap="round"
                  strokeDasharray={majorRiver ? "2 18" : "1 22"}
                  strokeDashoffset={-mapFrame * (majorRiver ? 1.8 : 1.1)}
                  opacity={majorRiver ? 0.6 : 0.24}
                />
              </g>
            );
          })}

          <text x={projectGeo({ lon: 114.3, lat: 36.3 }).x} y={projectGeo({ lon: 114.3, lat: 36.3 }).y - 8} fill="#3d7378" fontSize="15" fontFamily={fontFamily} letterSpacing="3" opacity="0.82">
            黄河
          </text>
          <text x={projectGeo({ lon: 114.3, lat: 30.25 }).x} y={projectGeo({ lon: 114.3, lat: 30.25 }).y + 18} fill="#3d7378" fontSize="15" fontFamily={fontFamily} letterSpacing="3" opacity="0.82">
            长江
          </text>

          {regionLabels.map((region) => {
            const point = projectGeo({ lon: region.lon, lat: region.lat });
            return (
              <text key={region.text} x={point.x} y={point.y} fill="#6b5640" fontSize="15" fontFamily={fontFamily} letterSpacing="5" opacity="0.38">
                {region.text}
              </text>
            );
          })}

          <path d={routePath(routeOne)} fill="none" stroke="#9d6238" strokeWidth="15" strokeLinecap="round" opacity="0.18" filter="url(#route-glow)" />
          <path d={routePath(routeOne)} fill="none" stroke="#a96835" strokeWidth="5" strokeLinecap="round" strokeDasharray="1" strokeDashoffset={1 - routeOneProgress} pathLength="1" />
          <path d={routePath(routeTwo)} fill="none" stroke="#963e35" strokeWidth="15" strokeLinecap="round" opacity="0.16" filter="url(#route-glow)" />
          <path d={routePath(routeTwo)} fill="none" stroke="#9a4036" strokeWidth="5" strokeLinecap="round" strokeDasharray="1" strokeDashoffset={1 - routeTwoProgress} pathLength="1" />

          <RouteHead point={routeOneHead} color="#a96835" frame={mapFrame} opacity={routeOneProgress > 0 ? 0.92 : 0} />
          <RouteHead point={routeTwoHead} color="#9a4036" frame={mapFrame} opacity={routeTwoProgress > 0 ? 0.92 : 0} />
          <RouteTrail points={routeOne} progress={advanceOne} color="#a96835" frame={mapFrame} />
          <RouteTrail points={routeTwo} progress={advanceTwo} color="#9a4036" frame={mapFrame} />
          <BattlePulse point={jianye} frame={mapFrame} start={58} end={96} color="#9a4036" />
          <BattlePulse point={luoyang} frame={mapFrame} start={142} end={180} color="#a96835" />

          <City point={jingzhou} label="荆州" color="#a96835" active={mapFrame} index={1} labelDy={22} />
          <City point={xiangyang} label="襄阳" color="#a96835" active={mapFrame} index={2} labelDy={-10} />
          <City point={luoyang} label="洛阳" color="#9a4036" active={mapFrame} index={3} labelDy={-10} />
          <City point={jianye} label="建业" color="#9a4036" active={mapFrame} index={4} />
          <City point={changAn} label="长安" color="#a96835" active={mapFrame} index={5} labelDx={-48} labelDy={-10} />

          <ArmyMarker point={armyOne} color="#a96835" label="北府军" rotation={-28} />
          <ArmyMarker point={armyTwo} color="#9a4036" label="禁军" rotation={-155} />
          <PortraitBadge image={image} point={commandPoint} label="中军" />
        </g>

        <g opacity={titleOpacity}>
          <path d="M 76 92 H 366 M 76 92 V 166" fill="none" stroke="#8f6847" strokeWidth="1.5" />
          <text x="92" y="124" fill="#6f4431" fontSize="16" fontFamily={fontFamily} letterSpacing="4">
            东中部 · 行军图
          </text>
          <text x="92" y="154" fill="#342921" fontSize="27" fontFamily={fontFamily} fontWeight="700">
            荆州 → 洛阳 → 长安
          </text>
        </g>

        <g transform="translate(1075 586)" opacity="0.74">
          <circle r="31" fill="#f0dfba" fillOpacity="0.35" stroke="#7e6145" strokeWidth="1" />
          <path d="M 0 -25 L 5 0 L 0 25 L -5 0 Z" fill="#8f5038" opacity="0.8" />
          <path d="M -25 0 L 0 5 L 25 0 L 0 -5 Z" fill="#6d8b89" opacity="0.8" />
          <text x="0" y="-36" textAnchor="middle" fill="#544338" fontSize="12" fontFamily={fontFamily}>北</text>
        </g>

        <g transform="translate(82 622)" opacity="0.84">
          <path d="M 0 0 H 250" stroke="#714c38" strokeWidth="2" />
          <path d="M 0 -5 V 5 M 62.5 -5 V 5 M 125 -5 V 5 M 187.5 -5 V 5 M 250 -5 V 5" stroke="#714c38" strokeWidth="1.5" />
          <text x="0" y="26" fill="#664838" fontSize="13" fontFamily={fontFamily}>0</text>
          <text x="118" y="26" fill="#664838" fontSize="13" fontFamily={fontFamily}>400</text>
          <text x="236" y="26" fill="#664838" fontSize="13" fontFamily={fontFamily}>800 km</text>
        </g>

        <g transform="translate(878 620)" opacity="0.9">
          <path d="M 0 0 H 32" stroke="#a96835" strokeWidth="5" strokeLinecap="round" />
          <text x="44" y="5" fill="#553d31" fontSize="13" fontFamily={fontFamily}>北府军</text>
          <path d="M 128 0 H 160" stroke="#9a4036" strokeWidth="5" strokeLinecap="round" />
          <text x="172" y="5" fill="#553d31" fontSize="13" fontFamily={fontFamily}>禁军</text>
        </g>

        <path d="M 48 670 H 1232 M 48 54 H 1232" stroke="#eadcc3" strokeOpacity="0.72" />
        <rect width="1280" height="720" fill="url(#edge-vignette)" pointerEvents="none" />
        <rect width="1280" height="720" fill="#c59054" opacity={cityFlash * 0.08} pointerEvents="none" />
      </svg>

      <div
        style={{
          position: "absolute",
          top: 27,
          left: 38,
          zIndex: 20,
          color: "rgba(57,45,37,0.82)",
          fontFamily,
          fontSize: 16,
          letterSpacing: 2,
        }}
      >
        历史地名 · 真实经纬度 · 行军路线动态
      </div>
      <div
        style={{
          position: "absolute",
          top: 27,
          right: 38,
          zIndex: 20,
          opacity: titleOpacity,
          color: "rgba(57,45,37,0.78)",
          fontFamily,
          fontSize: 16,
          letterSpacing: 2,
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

export const WarMapParallaxDemo: React.FC<WarMapParallaxDemoProps> = ({
  image,
  backgroundLayer = image,
  foregroundLayer = image,
  title = "静态图动态化实验片段",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const mapStart = 195;
  const mapVisible = frame >= mapStart;
  const transitionProgress = interpolate(
    frame,
    [mapStart - 8, mapStart, mapStart + 10],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease) },
  );

  return (
    <AbsoluteFill style={{ background: "#101617" }}>
      {!mapVisible && (
        <LayeredImageScene
          frame={frame}
          image={image}
          backgroundLayer={backgroundLayer}
          foregroundLayer={foregroundLayer}
        />
      )}
      {mapVisible && <WarMapScene frame={frame} image={image} title={title} />}
      {transitionProgress > 0 && transitionProgress < 1 && (
        <AbsoluteFill
          style={{
            background: "#f6e9c8",
            opacity: transitionProgress * 0.78,
            zIndex: 50,
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 4,
          zIndex: 60,
          background: "rgba(236, 189, 83, 0.42)",
          transformOrigin: "left",
          transform: `scaleX(${clamp01(frame / Math.max(1, durationInFrames - 1))})`,
        }}
      />
    </AbsoluteFill>
  );
};
