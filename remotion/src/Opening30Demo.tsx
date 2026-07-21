import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const BASE = "http://localhost:5679/static";
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "SimSun", serif';
const PAPER = "#f2e2bd";
const INK = "#33271d";
const RED = "#a84b3e";
const GOLD = "#d0a052";

export type Opening30DemoProps = {
  durationInFrames: number;
  audioUrl?: string | null;
};

const assets = {
  background: `${BASE}/images/9b8cdcad-8f71-4e99-8fdc-2a785f75100d.png`,
  rockefeller: `${BASE}/remotion/project-8/assets/rockefeller-operator.png`,
  morris: `${BASE}/remotion/project-8/assets/morris-stand.png`,
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function enter(frame: number, delay: number, duration = 24) {
  const { fps } = useVideoConfig();
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 24, mass: 0.65, stiffness: 140 },
    durationInFrames: duration,
  });
}

function Shot({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(
    frame,
    [0, 8, Math.max(9, durationInFrames - 16), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return <AbsoluteFill style={{ opacity: fade }}>{children}</AbsoluteFill>;
}

function OfficeStage({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(progress, [0, 1], [1.015, 1.045]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#1b130e", overflow: "hidden" }}>
      <Img
        src={assets.background}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          filter: "brightness(0.68) saturate(0.74) contrast(1.05) sepia(0.1)",
        }}
      />
      <AbsoluteFill style={{ backgroundColor: "rgba(29, 21, 14, 0.15)" }} />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 16% 50%, rgba(255,224,168,0.13), transparent 38%), linear-gradient(90deg, rgba(10,7,4,0.03), rgba(10,7,4,0.22))",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.36,
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,244,213,0.05) 0, rgba(255,244,213,0.05) 1px, transparent 1px, transparent 4px)",
          pointerEvents: "none",
        }}
      />
      {children}
    </AbsoluteFill>
  );
}

function Desk() {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 90,
          right: 90,
          top: 505,
          height: 48,
          zIndex: 42,
          background: "linear-gradient(180deg, #765033 0%, #4a2e1d 58%, #2a1910 100%)",
          borderTop: "2px solid rgba(229,177,99,0.66)",
          borderBottom: "1px solid rgba(19,11,7,0.9)",
          boxShadow: "0 -10px 22px rgba(0,0,0,0.34), inset 0 -8px 14px rgba(22,12,7,0.38)",
          transform: "perspective(560px) rotateX(3deg)",
          transformOrigin: "center top",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 90,
          right: 90,
          top: 548,
          bottom: -18,
          zIndex: 60,
          background: "linear-gradient(180deg, #432918 0%, #2a1810 65%, #160d08 100%)",
          borderTop: "1px solid rgba(17,10,6,0.9)",
          boxShadow: "0 -5px 14px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ position: "absolute", left: 62, top: 0, width: 3, bottom: 0, backgroundColor: "rgba(224,170,89,0.18)" }} />
        <div style={{ position: "absolute", right: 62, top: 0, width: 3, bottom: 0, backgroundColor: "rgba(224,170,89,0.18)" }} />
      </div>
    </>
  );
}

function Actor({
  src,
  left,
  height,
  bottom,
  delay = 0,
  direction = 1,
  zIndex = 50,
}: {
  src: string;
  left: number;
  height: number;
  bottom: number;
  delay?: number;
  direction?: 1 | -1;
  zIndex?: number;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const inProgress = enter(frame, delay, 28);
  const outProgress = interpolate(frame, [Math.max(0, durationInFrames - 14), durationInFrames + 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const drift = Math.sin(frame * 0.05 + left) * 0.16;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: left - 78,
          top: bottom === 170 ? 536 : 498,
          width: 156,
          height: 16,
          zIndex: zIndex - 1,
          opacity: clamp(inProgress * 0.3),
          borderRadius: "50%",
          backgroundColor: "rgba(0,0,0,0.46)",
          filter: "blur(7px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left,
          bottom,
          height,
          zIndex,
          opacity: clamp(inProgress * outProgress),
          transform: `translate3d(calc(-50% + ${direction * (1 - inProgress) * 86}px), ${(1 - inProgress) * 18}px, 0) rotate(${drift}deg)`,
          transformOrigin: "center bottom",
          filter: "drop-shadow(0 12px 10px rgba(0,0,0,0.32))",
        }}
      >
        <Img
          src={src}
          style={{
            height: "100%",
            width: "auto",
            display: "block",
            objectFit: "contain",
            filter: "brightness(0.82) saturate(0.72) sepia(0.12) contrast(1.06)",
          }}
        />
      </div>
    </>
  );
}

function ShotTitle({ kicker, title }: { kicker: string; title: string }) {
  const frame = useCurrentFrame();
  const show = enter(frame, 2, 18);
  return (
    <div
      style={{
        position: "absolute",
        left: 46,
        top: 30,
        zIndex: 85,
        opacity: show,
        transform: `translateY(${(1 - show) * 12}px)`,
        color: "#f1ddb2",
        fontFamily: FONT,
        textShadow: "0 2px 8px rgba(0,0,0,0.82)",
      }}
    >
      <div style={{ color: GOLD, fontSize: 14, letterSpacing: "0.18em" }}>{kicker}</div>
      <div style={{ marginTop: 5, fontFamily: SERIF, fontSize: 32 }}>{title}</div>
    </div>
  );
}

function Subtitle({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const show = interpolate(frame, [0, 8, Math.max(9, durationInFrames - 12), durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 160,
        right: 160,
        bottom: 20,
        zIndex: 90,
        opacity: show,
        color: "#fff7e2",
        fontFamily: FONT,
        fontSize: 24,
        textAlign: "center",
        textShadow: "0 2px 9px rgba(0,0,0,0.9)",
      }}
    >
      {text}
    </div>
  );
}

function PaperCard({
  label,
  detail,
  x,
  y,
  width = 220,
  height = 108,
  delay = 0,
  rotate = 0,
  zIndex = 50,
  stamp,
  accent = false,
}: {
  label: string;
  detail?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  delay?: number;
  rotate?: number;
  zIndex?: number;
  stamp?: string;
  accent?: boolean;
}) {
  const frame = useCurrentFrame();
  const show = enter(frame, delay, 24);
  const stampShow = stamp ? enter(frame, delay + 28, 12) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        zIndex,
        opacity: show,
        transform: `translate(-50%, ${(1 - show) * 34}px) rotate(${rotate}deg)`,
        padding: "13px 15px",
        boxSizing: "border-box",
        color: INK,
        backgroundColor: PAPER,
        border: accent ? `2px solid ${GOLD}` : "1px solid rgba(66,44,25,0.7)",
        boxShadow: "0 12px 17px rgba(0,0,0,0.34)",
        fontFamily: FONT,
      }}
    >
      <div style={{ fontFamily: SERIF, fontSize: 22 }}>{label}</div>
      <div style={{ width: "70%", height: 2, marginTop: 8, backgroundColor: "rgba(55,38,24,0.46)" }} />
      <div style={{ marginTop: 9, fontSize: 13, lineHeight: 1.5, opacity: 0.78 }}>{detail || "────────────"}</div>
      {stamp && (
        <div
          style={{
            position: "absolute",
            right: 9,
            bottom: 9,
            padding: "3px 7px",
            border: `2px solid ${RED}`,
            color: RED,
            fontSize: 14,
            opacity: stampShow,
            transform: `rotate(-8deg) scale(${0.78 + stampShow * 0.22})`,
          }}
        >
          {stamp}
        </div>
      )}
    </div>
  );
}

function Ledger({ delay = 0, x = 1015, y = 500 }: { delay?: number; x?: number; y?: number }) {
  const frame = useCurrentFrame();
  const show = enter(frame, delay, 24);
  const open = enter(frame, delay + 24, 18);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 190,
        height: 120,
        zIndex: 48,
        opacity: show,
        transform: `translate(-50%, ${(1 - show) * 22}px) rotate(3deg)`,
        filter: "drop-shadow(0 12px 15px rgba(0,0,0,0.35))",
      }}
    >
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

function Line({ from, to, delay = 0, color = GOLD, width = 4, zIndex = 26 }: { from: [number, number]; to: [number, number]; delay?: number; color?: string; width?: number; zIndex?: number }) {
  const frame = useCurrentFrame();
  const draw = enter(frame, delay, 28);
  const [x1, y1] = from;
  const [x2, y2] = to;
  return (
    <svg viewBox="0 0 1280 720" width="100%" height="100%" style={{ position: "absolute", inset: 0, zIndex, overflow: "visible", pointerEvents: "none" }}>
      <path d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - 32} ${x2} ${y2}`} fill="none" stroke="rgba(0,0,0,0.38)" strokeWidth={width + 6} strokeLinecap="round" opacity={draw * 0.35} />
      <path d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - 32} ${x2} ${y2}`} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - draw} opacity={draw} />
    </svg>
  );
}

function HookShot() {
  const frame = useCurrentFrame();
  const contrast = enter(frame, 48, 22);
  const pushAway = interpolate(frame, [105, 155], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Shot>
      <ShotTitle kicker="宿命与败局 · 洛克菲勒" title="有些人的败局，输给了对手" />
      <Actor src={assets.rockefeller} left={900} height={420} bottom={170} delay={8} direction={1} />
      <Ledger delay={32} />
      <PaperCard label="对手" detail="价格 · 路线 · 运费" x={360 - pushAway * 150} y={470 + pushAway * 24} width={210} height={104} rotate={-7} delay={18} stamp="败局" zIndex={50} />
      <PaperCard label="标准石油" detail="炼油 · 运输 · 信息" x={760} y={365} width={250} height={120} delay={62} accent zIndex={49} />
      <Line from={[455, 470]} to={[700, 425]} delay={78} color={RED} zIndex={28} />
      <div style={{ position: "absolute", left: 720, top: 290, zIndex: 82, opacity: contrast, color: "#f5d99b", fontFamily: SERIF, fontSize: 42, textShadow: "0 3px 12px rgba(0,0,0,0.9)" }}>洛克菲勒不是。</div>
      <Subtitle text="有些人的败局，是因为输给了对手。洛克菲勒不是。" />
    </Shot>
  );
}

function RailShot() {
  const frame = useCurrentFrame();
  const contract = enter(frame, 18, 28);
  const contractX = interpolate(contract, [0, 0.48, 1], [460, 600, 735]);
  const contractY = interpolate(contract, [0, 1], [478, 502]);
  const data = enter(frame, 112, 38);
  const dataX = interpolate(data, [0, 0.45, 1], [690, 850, 1005]);
  const dataY = interpolate(data, [0, 0.45, 1], [490, 475, 490]);
  return (
    <Shot>
      <ShotTitle kicker="铁路协议" title="折扣与信息，一起进账" />
      <Actor src={assets.morris} left={305} height={535} bottom={57} delay={0} direction={-1} zIndex={50} />
      <Actor src={assets.rockefeller} left={910} height={420} bottom={170} delay={12} direction={1} zIndex={52} />
      <Ledger delay={8} />
      <PaperCard label="铁路运价表" detail="标准石油 · 每桶运费" x={contractX} y={contractY} width={232} height={116} rotate={-2} delay={0} stamp="折扣 -20%" zIndex={55} />
      <div style={{ position: "absolute", left: dataX, top: dataY, width: 150, height: 58, zIndex: 56, opacity: data, transform: `translate(-50%, -50%) rotate(${interpolate(data, [0, 1], [-8, 2])}deg)`, padding: "9px 11px", boxSizing: "border-box", backgroundColor: "#f5e8c7", border: "1px solid rgba(74,48,26,0.62)", boxShadow: "0 8px 12px rgba(0,0,0,0.3)", color: INK, fontFamily: FONT }}>
        <div style={{ fontSize: 13 }}>竞争对手数据</div>
        <div style={{ marginTop: 7, height: 3, width: "78%", backgroundColor: "rgba(74,48,26,0.29)" }} />
        <div style={{ marginTop: 6, height: 3, width: "56%", backgroundColor: "rgba(74,48,26,0.18)" }} />
      </div>
      <Line from={[440, 490]} to={[720, 492]} delay={40} color={GOLD} zIndex={27} />
      <Line from={[760, 488]} to={[1000, 490]} delay={128} color={RED} zIndex={27} />
      <Subtitle text="铁路给他折扣，竞争对手的运输数据会流到他手里。" />
    </Shot>
  );
}

function NetworkBoard() {
  const frame = useCurrentFrame();
  const board = enter(frame, 6, 24);
  const center = enter(frame, 18, 20);
  const nodes = [
    { label: "管线", detail: "输送", x: 300, y: 190, delay: 34, to: [480, 280] as [number, number] },
    { label: "炼油厂", detail: "加工", x: 660, y: 190, delay: 52, to: [480, 280] as [number, number] },
    { label: "仓储", detail: "库存", x: 300, y: 350, delay: 70, to: [480, 280] as [number, number] },
    { label: "销售网络", detail: "出货", x: 660, y: 350, delay: 88, to: [480, 280] as [number, number] },
  ];
  return (
    <>
      <div style={{ position: "absolute", left: 225, top: 130, width: 510, height: 290, zIndex: 22, opacity: board, transform: `translateY(${(1 - board) * -24}px)`, background: "linear-gradient(180deg, rgba(82,56,35,0.96), rgba(46,31,20,0.98))", border: "8px solid #2a1a11", boxShadow: "0 15px 26px rgba(0,0,0,0.42)" }}>
        <div style={{ position: "absolute", left: 16, right: 16, top: 16, bottom: 16, backgroundColor: "#e9d7aa", border: "1px solid rgba(91,62,33,0.65)" }} />
        <div style={{ position: "absolute", left: 24, top: 28, color: INK, fontFamily: SERIF, fontSize: 21 }}>标准石油 · 体系图</div>
        <div style={{ position: "absolute", right: 24, top: 30, color: RED, fontFamily: FONT, fontSize: 12 }}>成本与信息</div>
      </div>
      <Line from={[300, 190]} to={[480, 280]} delay={34} color={GOLD} zIndex={27} />
      <Line from={[660, 190]} to={[480, 280]} delay={52} color={GOLD} zIndex={27} />
      <Line from={[300, 350]} to={[480, 280]} delay={70} color={GOLD} zIndex={27} />
      <Line from={[660, 350]} to={[480, 280]} delay={88} color={GOLD} zIndex={27} />
      <div style={{ position: "absolute", left: 480, top: 280, width: 160, height: 86, zIndex: 36, opacity: center, transform: `translate(-50%, -50%) scale(${0.9 + center * 0.1})`, padding: "20px 12px", boxSizing: "border-box", textAlign: "center", color: PAPER, backgroundColor: "#4b2f1d", border: `2px solid ${GOLD}`, boxShadow: "0 10px 18px rgba(0,0,0,0.38)", fontFamily: SERIF, fontSize: 23 }}>标准石油</div>
      {nodes.map((node) => {
        const show = enter(frame, node.delay, 18);
        return <div key={node.label} style={{ position: "absolute", left: node.x, top: node.y, width: 128, height: 66, zIndex: 35, opacity: show, transform: `translate(-50%, -50%) translateY(${(1 - show) * 24}px) rotate(${node.x < 480 ? -4 : 4}deg)`, padding: "12px 10px", boxSizing: "border-box", color: INK, backgroundColor: PAPER, border: "1px solid rgba(74,48,26,0.62)", boxShadow: "0 8px 14px rgba(0,0,0,0.3)", fontFamily: FONT }}><div style={{ fontFamily: SERIF, fontSize: 18 }}>{node.label}</div><div style={{ marginTop: 5, fontSize: 11, opacity: 0.7 }}>{node.detail}</div></div>;
      })}
      <Line from={[560, 305]} to={[900, 480]} delay={112} color={RED} zIndex={28} />
    </>
  );
}

function NetworkShot() {
  return (
    <Shot>
      <ShotTitle kicker="体系成形" title="一层层收进自己的规则" />
      <Actor src={assets.rockefeller} left={910} height={420} bottom={170} delay={0} direction={1} zIndex={52} />
      <Ledger delay={0} />
      <NetworkBoard />
      <div style={{ position: "absolute", left: 760, top: 155, zIndex: 80, color: "#f0d49b", fontFamily: SERIF, fontSize: 24, textShadow: "0 2px 8px rgba(0,0,0,0.86)" }}>资源分散，控制集中</div>
      <Subtitle text="管线、炼油厂、仓储和销售网络，被他一层层收进自己的体系。" />
    </Shot>
  );
}

function CourtShot() {
  const frame = useCurrentFrame();
  const order = enter(frame, 8, 28);
  const slash = interpolate(frame, [62, 86], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const split = enter(frame, 78, 34);
  const pieces = [
    { label: "炼油", x: 305, y: 200, r: -8 },
    { label: "铁路", x: 660, y: 200, r: 7 },
    { label: "管线", x: 305, y: 355, r: 5 },
    { label: "销售", x: 660, y: 355, r: -6 },
  ];
  return (
    <Shot>
      <ShotTitle kicker="1911 · 美国最高法院" title="法律伸进这张网络" />
      <Actor src={assets.rockefeller} left={910} height={420} bottom={170} delay={0} direction={1} zIndex={52} />
      <Ledger delay={0} />
      <NetworkBoard />
      <PaperCard label="美国最高法院" detail="命令拆解标准石油" x={480} y={150 + order * 92} width={290} height={136} rotate={-3} delay={0} stamp="拆 解" zIndex={58} />
      <div style={{ position: "absolute", left: 270, top: 278, width: 420, height: 8, zIndex: 59, opacity: slash, backgroundColor: RED, boxShadow: "0 0 16px rgba(168,75,62,0.75)", transform: `rotate(-8deg) scaleX(${slash})`, transformOrigin: "left center" }} />
      {pieces.map((piece, index) => <div key={piece.label} style={{ position: "absolute", left: piece.x + (piece.x < 480 ? -45 : 45) * split, top: piece.y + (piece.y < 280 ? -22 : 22) * split, width: 120, height: 64, zIndex: 57, opacity: clamp(split * 1.3), transform: `translate(-50%, -50%) rotate(${piece.r}deg)`, padding: "20px 8px", boxSizing: "border-box", textAlign: "center", color: INK, backgroundColor: PAPER, border: "1px solid rgba(74,48,26,0.62)", boxShadow: "0 8px 14px rgba(0,0,0,0.3)", fontFamily: SERIF, fontSize: 18 }}>{piece.label}公司</div>)}
      <Line from={[520, 320]} to={[900, 480]} delay={102} color={GOLD} width={5} zIndex={31} />
      <div style={{ position: "absolute", left: 760, top: 170, zIndex: 82, opacity: split, color: "#f4d79c", fontFamily: SERIF, fontSize: 25, textShadow: "0 2px 10px rgba(0,0,0,0.88)" }}>公司被拆，所有权线还在。</div>
      <Subtitle text="1911年，美国最高法院命令拆解标准石油。看起来，帝国终于被法律击碎了。" />
    </Shot>
  );
}

export const OPENING_30_DURATION = 900;

export const Opening30Demo: React.FC<Opening30DemoProps> = ({ audioUrl }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#14100c" }}>
      {audioUrl && <Audio src={audioUrl} volume={0.98} />}
      <OfficeStage>
        <Desk />
        <div style={{ position: "absolute", inset: 0, zIndex: 10 }}>
          <div style={{ position: "absolute", inset: 0, opacity: 0.2, background: "linear-gradient(180deg, rgba(255,242,207,0.05), transparent 42%, rgba(0,0,0,0.2))" }} />
        </div>
        <OpeningShots />
      </OfficeStage>
    </AbsoluteFill>
  );
};

function OpeningShots() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 70 }}>
      <Sequence from={0} durationInFrames={258} premountFor={0}><HookShot /></Sequence>
      <Sequence from={258} durationInFrames={207} premountFor={0}><RailShot /></Sequence>
      <Sequence from={465} durationInFrames={256} premountFor={0}><NetworkShot /></Sequence>
      <Sequence from={721} durationInFrames={179} premountFor={0}><CourtShot /></Sequence>
    </div>
  );
}
