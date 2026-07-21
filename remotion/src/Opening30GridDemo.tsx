import { AbsoluteFill, Audio, Img, useCurrentFrame } from "remotion";

const BASE = "http://localhost:5679/static";
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const PANEL_COUNT = 4;
const PANEL_DURATION = 225; // 7.5 seconds at 30 fps.

const DEFAULT_SHEET = `${BASE}/remotion/project-8/grid/hook.png`;

export type Opening30GridDemoProps = {
  durationInFrames?: number;
  audioUrl?: string | null;
  sheetUrl?: string;
};

/**
 * The source is one generated 2x2 image. Remotion only changes the crop
 * window; it never creates cards or composes character/prop layers.
 */
function TemporalGridCrop({ sheetUrl, panel }: { sheetUrl: string; panel: number }) {
  const column = panel % 2;
  const row = Math.floor(panel / 2);

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#17110b" }}>
      <Img
        src={sheetUrl}
        style={{
          position: "absolute",
          left: -column * OUTPUT_WIDTH,
          top: -row * OUTPUT_HEIGHT,
          width: OUTPUT_WIDTH * 2,
          height: OUTPUT_HEIGHT * 2,
          maxWidth: "none",
        }}
      />
    </AbsoluteFill>
  );
}

export const OPENING_30_GRID_DURATION = PANEL_COUNT * PANEL_DURATION;

export const Opening30GridDemo: React.FC<Opening30GridDemoProps> = ({
  audioUrl,
  sheetUrl = DEFAULT_SHEET,
}) => {
  const frame = useCurrentFrame();
  const panel = Math.min(PANEL_COUNT - 1, Math.floor(frame / PANEL_DURATION));

  return (
    <AbsoluteFill style={{ width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, backgroundColor: "#17110b" }}>
      {audioUrl && <Audio src={audioUrl} volume={0.98} />}
      <TemporalGridCrop sheetUrl={sheetUrl} panel={panel} />
    </AbsoluteFill>
  );
};
