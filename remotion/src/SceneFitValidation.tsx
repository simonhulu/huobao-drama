import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const BASE = "http://localhost:5679/static";
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "SimSun", serif';
const PAPER = "#f2e2bd";
const INK = "#33271d";
const RED = "#9f4338";
const GOLD = "#c99445";

export type SceneFitValidationProps = {
  durationInFrames: number;
  audioUrl?: string | null;
};

const asset = {
  background: `${BASE}/images/9b8cdcad-8f71-4e99-8fdc-2a785f75100d.png`,
  rockefeller: `${BASE}/remotion/project-8/assets/rockefeller-stand.png`,
  rockefellerOperator: `${BASE}/remotion/project-8/assets/rockefeller-operator.png`,
  morris: `${BASE}/remotion/project-8/assets/morris-stand.png`,
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function progress(frame: number, delay: number, duration = 22) {
  const { fps } = useVideoConfig();
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 24, mass: 0.65, stiffness: 135 },
    durationInFrames: duration,
  });
}

function ScenePlate({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const camera = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [1.015, 1.045], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#211914", overflow: "hidden" }}>
      <Img
        src={asset.background}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${camera})`,
          filter: "brightness(0.68) saturate(0.74) contrast(1.04) sepia(0.08)",
        }}
      />
      <AbsoluteFill style={{ backgroundColor: "rgba(32, 24, 17, 0.14)" }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 18% 52%, rgba(255,221,164,0.13), transparent 38%), linear-gradient(90deg, rgba(10,7,4,0.05), rgba(10,7,4,0.22))", pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(255,244,213,0.05) 0, rgba(255,244,213,0.05) 1px, transparent 1px, transparent 4px)", opacity: 0.45, pointerEvents: "none" }} />
      {children}
    </AbsoluteFill>
  );
}

function DeskForeground() {
  return (
    <>
      <div style={{ position: "absolute", left: 90, right: 90, top: 505, height: 48, zIndex: 42, transform: "perspective(560px) rotateX(3deg)", transformOrigin: "center top", pointerEvents: "none", background: "linear-gradient(180deg, #765033 0%, #4a2e1d 58%, #2a1910 100%)", borderTop: "2px solid rgba(229,177,99,0.66)", borderBottom: "1px solid rgba(19,11,7,0.9)", boxShadow: "0 -10px 22px rgba(0,0,0,0.34), inset 0 -8px 14px rgba(22,12,7,0.38)" }} />
      <div style={{ position: "absolute", left: 90, right: 90, top: 548, bottom: -18, zIndex: 60, pointerEvents: "none", background: "linear-gradient(180deg, #432918 0%, #2a1810 65%, #160d08 100%)", borderTop: "1px solid rgba(17,10,6,0.9)", boxShadow: "0 -5px 14px rgba(0,0,0,0.25)" }}>
        <div style={{ position: "absolute", left: 62, top: 0, width: 3, bottom: 0, backgroundColor: "rgba(224,170,89,0.18)" }} />
        <div style={{ position: "absolute", right: 62, top: 0, width: 3, bottom: 0, backgroundColor: "rgba(224,170,89,0.18)" }} />
      </div>
    </>
  );
}

function Character({ src, left, height, bottom = 57, delay, direction, zIndex = 22, shadowY = 498, scaleX = 1 }: { src: string; left: number; height: number; bottom?: number; delay: number; direction: 1 | -1; zIndex?: number; shadowY?: number; scaleX?: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = progress(frame, delay, 26);
  const exit = interpolate(frame, [durationInFrames - 14, durationInFrames + 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sway = Math.sin(frame * 0.052 + left) * 0.18;
  return (
    <>
      <div style={{ position: "absolute", left: left - 78, top: shadowY, width: 156, height: 16, zIndex: zIndex - 1, opacity: clamp(enter * 0.32), borderRadius: "50%", backgroundColor: "rgba(0,0,0,0.48)", filter: "blur(7px)", transform: `scaleX(${0.82 + enter * 0.18})` }} />
      <div style={{ position: "absolute", left, bottom, height, zIndex, opacity: clamp(enter * exit), transform: `translate3d(calc(-50% + ${direction * (1 - enter) * 86}px), ${(1 - enter) * 18}px, 0) rotate(${sway}deg) scaleX(${scaleX})`, transformOrigin: "center bottom", filter: "drop-shadow(0 12px 10px rgba(0,0,0,0.32))" }}>
        <Img src={src} style={{ height: "100%", width: "auto", display: "block", objectFit: "contain", filter: "brightness(0.82) saturate(0.72) sepia(0.12) contrast(1.06)" }} />
      </div>
    </>
  );
}

function Contract({ delay }: { delay: number }) {
  const frame = useCurrentFrame();
  const enter = progress(frame, delay, 34);
  const x = interpolate(enter, [0, 0.5, 1], [438, 590, 724]);
  const y = interpolate(enter, [0, 1], [474, 505]);
  const rotate = interpolate(enter, [0, 1], [-8, -2]);
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 232, height: 116, zIndex: 46, opacity: enter, transform: `translate(-50%, -50%) rotate(${rotate}deg)`, transformOrigin: "center center", padding: "14px 16px", boxSizing: "border-box", backgroundColor: PAPER, color: INK, border: "1px solid rgba(66,44,25,0.7)", boxShadow: "0 13px 16px rgba(0,0,0,0.34)", fontFamily: FONT }}>
      <div style={{ fontFamily: SERIF, fontSize: 23 }}>铁路运价表</div>
      <div style={{ width: "70%", height: 2, marginTop: 9, backgroundColor: "rgba(55,38,24,0.5)" }} />
      <div style={{ marginTop: 10, fontSize: 13, opacity: 0.76 }}>标准石油 · 每桶运费</div>
      <div style={{ marginTop: 7, width: "88%", height: 3, backgroundColor: "rgba(55,38,24,0.23)" }} />
      <div style={{ position: "absolute", right: 10, bottom: 10, padding: "3px 7px", border: `2px solid ${RED}`, color: RED, fontSize: 14, transform: `rotate(-8deg) scale(${clamp(progress(frame, delay + 32, 12) * 0.22 + 0.78)})`, opacity: progress(frame, delay + 32, 12) }}>折扣 -20%</div>
    </div>
  );
}

function Ledger() {
  const frame = useCurrentFrame();
  const enter = progress(frame, 54, 24);
  const open = progress(frame, 82, 18);
  return (
    <div style={{ position: "absolute", left: 1015, top: 500, width: 190, height: 120, zIndex: 47, opacity: enter, transform: `translate(-50%, ${(1 - enter) * 22}px) rotate(3deg)`, transformOrigin: "center center", filter: "drop-shadow(0 12px 15px rgba(0,0,0,0.35))" }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#452c1c", border: "2px solid #25170f" }} />
      <div style={{ position: "absolute", left: 12, top: 10, width: 90, height: 110, padding: "11px 10px", boxSizing: "border-box", backgroundColor: "#ead6a9", color: INK, border: "1px solid rgba(74,48,26,0.55)", transform: `rotateY(${(1 - open) * 12}deg)`, transformOrigin: "right center", fontFamily: FONT }}>
        <div style={{ fontFamily: SERIF, fontSize: 20 }}>账本</div>
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.8 }}>折扣<br />数据<br />股份</div>
      </div>
      <div style={{ position: "absolute", left: 106, top: 10, width: 90, height: 110, padding: "11px 10px", boxSizing: "border-box", backgroundColor: "#f3e5c1", color: INK, border: "1px solid rgba(74,48,26,0.55)", transform: `rotateY(${(1 - open) * -16}deg)`, transformOrigin: "left center", fontFamily: FONT }}>
        <div style={{ fontSize: 12, opacity: 0.72 }}>标准石油</div>
        <div style={{ marginTop: 11, height: 3, backgroundColor: "rgba(74,48,26,0.24)" }} />
        <div style={{ marginTop: 10, height: 3, width: "78%", backgroundColor: "rgba(74,48,26,0.18)" }} />
        <div style={{ marginTop: 10, color: GOLD, fontFamily: SERIF, fontSize: 18 }}>控制</div>
      </div>
    </div>
  );
}

function DataSlip() {
  const frame = useCurrentFrame();
  const enter = progress(frame, 132, 44);
  const x = interpolate(enter, [0, 0.45, 1], [700, 858, 1005]);
  const y = interpolate(enter, [0, 0.45, 1], [492, 478, 490]);
  return <div style={{ position: "absolute", left: x, top: y, width: 150, height: 58, zIndex: 55, opacity: enter, transform: `translate(-50%, -50%) rotate(${interpolate(enter, [0, 1], [-8, 2])}deg)`, padding: "9px 11px", boxSizing: "border-box", backgroundColor: "#f5e8c7", border: "1px solid rgba(74,48,26,0.62)", boxShadow: "0 8px 12px rgba(0,0,0,0.3)", color: INK, fontFamily: FONT }}><div style={{ fontSize: 13 }}>竞争对手数据</div><div style={{ marginTop: 7, height: 3, width: "78%", backgroundColor: "rgba(74,48,26,0.29)" }} /><div style={{ marginTop: 6, height: 3, width: "56%", backgroundColor: "rgba(74,48,26,0.18)" }} /></div>;
}

function Subtitle() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 8, durationInFrames - 12, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ position: "absolute", left: 180, right: 180, bottom: 20, zIndex: 90, opacity: fade, color: "#fff7e2", fontFamily: FONT, fontSize: 25, textAlign: "center", textShadow: "0 2px 9px rgba(0,0,0,0.9)" }}>铁路给他折扣，竞争对手的运输数据会流到他手里。</div>;
}

export const SceneFitValidation: React.FC<SceneFitValidationProps> = ({ audioUrl }) => {
  const frame = useCurrentFrame();
  const result = progress(frame, 220, 22);
  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c" }}>
      {audioUrl && <Audio src={audioUrl} volume={0.98} />}
      <ScenePlate>
        <div style={{ position: "absolute", left: 46, top: 32, zIndex: 80, color: "#f1ddb2", fontFamily: FONT, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}><div style={{ color: GOLD, fontSize: 15, letterSpacing: "0.18em" }}>场景适配验证 · 单一办公室</div><div style={{ marginTop: 6, fontFamily: SERIF, fontSize: 34 }}>一张合同，进入一本账</div></div>
        <Character src={asset.morris} left={305} height={535} delay={0} direction={-1} zIndex={50} />
        <Character src={asset.rockefellerOperator} left={910} height={420} bottom={170} delay={18} direction={1} zIndex={52} shadowY={536} />
        <DeskForeground />
        <Contract delay={34} />
        <Ledger />
        <DataSlip />
        <div style={{ position: "absolute", left: 532, top: 604, zIndex: 62, opacity: result, color: "#f0d49b", fontFamily: SERIF, fontSize: 24, textShadow: "0 2px 8px rgba(0,0,0,0.86)" }}>折扣降低成本，信息进入账本。</div>
        <Subtitle />
      </ScenePlate>
    </AbsoluteFill>
  );
};
