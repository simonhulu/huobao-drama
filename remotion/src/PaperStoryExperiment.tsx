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

const BASE_URL = "http://localhost:5679/static";
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "SimSun", serif';
const PAPER = "#f2e4c6";
const INK = "#332d25";
const GOLD = "#d6a451";
const RED = "#a84b3e";

export type PaperStoryExperimentProps = {
  durationInFrames: number;
  audioUrl?: string | null;
  sourceVoice?: { audioConfigId: number; voiceId: string };
};

type BackgroundKey = "office" | "desk" | "industrial";
type CharacterPose = "point" | "write" | "stand" | "seat";

const ASSETS = {
  office: `${BASE_URL}/images/e86bdc94-5834-4a16-9582-791375053657.png`,
  desk: `${BASE_URL}/images/9b8cdcad-8f71-4e99-8fdc-2a785f75100d.png`,
  industrial: `${BASE_URL}/images/646c87b4-7168-454a-b036-40a96fd58246.png`,
  rockefellerPoint: `${BASE_URL}/remotion/project-2/characters/shot-8-character-约翰-d-洛克菲勒.png`,
  rockefellerWrite: `${BASE_URL}/remotion/project-2/characters/shot-10-character-约翰-d-洛克菲勒.png`,
  rockefellerSeat: `${BASE_URL}/remotion/project-2/characters/shot-13-character-约翰-d-洛克菲勒.png`,
  morris: `${BASE_URL}/remotion/project-2/characters/shot-4-character-莫里斯-克拉克.png`,
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function enterProgress(frame: number, delay: number, duration = 20) {
  const { fps } = useVideoConfig();
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 22, mass: 0.62, stiffness: 145 },
    durationInFrames: duration,
  });
}

function SceneBackground({
  image,
  backgroundKey,
  children,
}: {
  image: string;
  backgroundKey: BackgroundKey;
  children: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const zoom = interpolate(progress, [0, 1], [1.035, 1.085]);
  const panX = backgroundKey === "industrial"
    ? interpolate(progress, [0, 1], [0, -16])
    : interpolate(progress, [0, 1], [0, 10]);
  const panY = backgroundKey === "desk" ? interpolate(progress, [0, 1], [0, -7]) : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#151614" }}>
      <Img
        src={image}
        style={{
          position: "absolute",
          inset: "-5%",
          width: "110%",
          height: "110%",
          objectFit: "cover",
          transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
          filter: backgroundKey === "industrial"
            ? "brightness(0.68) saturate(0.72) contrast(1.08)"
            : "brightness(0.62) saturate(0.72) contrast(1.04)",
        }}
      />
      <AbsoluteFill style={{ backgroundColor: "rgba(20, 17, 12, 0.25)" }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.2,
          backgroundImage: "repeating-linear-gradient(0deg, rgba(255,246,220,0.07) 0, rgba(255,246,220,0.07) 1px, transparent 1px, transparent 4px)",
          mixBlendMode: "screen",
          pointerEvents: "none",
        }}
      />
      {children}
    </AbsoluteFill>
  );
}

function ShotHeader({ kicker, title }: { kicker: string; title: string }) {
  const frame = useCurrentFrame();
  const intro = enterProgress(frame, 3, 18);
  return (
    <div
      style={{
        position: "absolute",
        left: 42,
        top: 54,
        zIndex: 80,
        opacity: intro,
        transform: `translateY(${(1 - intro) * 12}px)`,
        color: PAPER,
        fontFamily: FONT,
        textShadow: "0 2px 12px rgba(0,0,0,0.72)",
      }}
    >
      <div style={{ color: GOLD, fontSize: 13, letterSpacing: "0.2em" }}>{kicker}</div>
      <div style={{ marginTop: 5, fontFamily: SERIF, fontSize: 31, letterSpacing: "0.08em" }}>{title}</div>
      <div style={{ marginTop: 10, width: 76, height: 2, backgroundColor: GOLD, transformOrigin: "left", transform: `scaleX(${intro})` }} />
    </div>
  );
}

function Caption({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 8, Math.max(9, durationInFrames - 12), durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 34,
        right: 34,
        bottom: 44,
        zIndex: 90,
        opacity: fade,
        fontFamily: FONT,
        color: "#fff8e9",
        fontSize: 22,
        lineHeight: 1.45,
        textAlign: "center",
        textShadow: "0 2px 10px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8)",
      }}
    >
      <span style={{ borderBottom: "2px solid rgba(214,164,81,0.72)", paddingBottom: 5 }}>{text}</span>
    </div>
  );
}

function Character({
  src,
  x,
  width = 1,
  zoom = 2.05,
  bottom = 0.02,
  delay = 0,
  pose = "stand",
  direction = 1,
  zIndex = 30,
}: {
  src: string;
  x: number;
  width?: number;
  zoom?: number;
  bottom?: number;
  delay?: number;
  pose?: CharacterPose;
  direction?: 1 | -1;
  zIndex?: number;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = enterProgress(frame, delay, 25);
  const exit = interpolate(frame, [durationInFrames - 12, durationInFrames + 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sway = pose === "write"
    ? Math.sin(frame * 0.1) * 1.2
    : pose === "point"
      ? Math.sin(frame * 0.075) * 1.5
      : Math.sin(frame * 0.045) * 0.6;
  const slide = direction * (1 - enter) * 76;
  const lift = (1 - enter) * 38;
  const breathe = 1 + Math.sin(frame * 0.055) * (pose === "seat" ? 0.004 : 0.008);
  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        bottom: `${bottom * 100}%`,
        width: `${width * 100}%`,
        height: "94%",
        zIndex,
        opacity: clamp(enter * exit),
        transform: `translate3d(calc(-50% + ${slide}px), ${lift}px, 0) rotate(${sway}deg) scale(${breathe})`,
        transformOrigin: "center bottom",
        pointerEvents: "none",
      }}
    >
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "center bottom",
          transform: `scale(${zoom})`,
          transformOrigin: "center bottom",
          filter: "drop-shadow(0 22px 18px rgba(0,0,0,0.46)) contrast(1.04) saturate(0.9)",
        }}
      />
    </div>
  );
}

function DeskEdge() {
  return (
    <div
      style={{
        position: "absolute",
        left: "-8%",
        right: "-8%",
        bottom: "17%",
        height: 18,
        zIndex: 18,
        background: "linear-gradient(90deg, rgba(42,26,17,0.3), rgba(170,111,54,0.7), rgba(38,24,16,0.42))",
        boxShadow: "0 11px 20px rgba(0,0,0,0.35)",
        transform: "perspective(240px) rotateX(8deg)",
      }}
    />
  );
}

function PaperSheet({
  x,
  y,
  width,
  height,
  rotate = 0,
  delay = 0,
  label,
  detail,
  stamp,
  color = INK,
  zIndex = 40,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
  delay?: number;
  label: string;
  detail?: string;
  stamp?: string;
  color?: string;
  zIndex?: number;
}) {
  const frame = useCurrentFrame();
  const enter = enterProgress(frame, delay, 20);
  const rise = (1 - enter) * 50;
  const stampProgress = stamp ? enterProgress(frame, delay + 18, 12) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width,
        height,
        zIndex,
        opacity: enter,
        transform: `translate3d(-50%, ${rise}px, 0) rotate(${rotate}deg)`,
        transformOrigin: "center center",
        padding: "13px 14px",
        boxSizing: "border-box",
        color,
        backgroundColor: PAPER,
        border: "1px solid rgba(80,55,31,0.54)",
        boxShadow: "0 13px 20px rgba(0,0,0,0.34)",
        fontFamily: FONT,
      }}
    >
      <div style={{ fontFamily: SERIF, fontSize: 22, letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ width: "70%", marginTop: 9, height: 2, background: "rgba(62,45,31,0.48)" }} />
      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.55, opacity: 0.78 }}>{detail || "────────────"}</div>
      <div style={{ marginTop: 6, height: 2, width: "82%", background: "rgba(62,45,31,0.22)" }} />
      {stamp && (
        <div
          style={{
            position: "absolute",
            right: 9,
            bottom: 10,
            padding: "3px 7px",
            border: `2px solid ${RED}`,
            color: RED,
            fontSize: 14,
            opacity: stampProgress,
            transform: `rotate(-9deg) scale(${0.78 + stampProgress * 0.22})`,
          }}
        >
          {stamp}
        </div>
      )}
    </div>
  );
}

function Ledger({ x = 0.52, y = 0.66, delay = 0, open = 1, zIndex = 45 }: { x?: number; y?: number; delay?: number; open?: number; zIndex?: number }) {
  const frame = useCurrentFrame();
  const enter = enterProgress(frame, delay, 22);
  const openProgress = interpolate(frame, [delay + 12, delay + 30], [0.2, open], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: 248,
        height: 150,
        zIndex,
        opacity: enter,
        transform: `translate3d(-50%, ${(1 - enter) * 30}px, 0) rotate(-3deg)`,
        transformOrigin: "center center",
        perspective: 600,
        filter: "drop-shadow(0 14px 15px rgba(0,0,0,0.35))",
      }}
    >
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#4d2f1e", border: "2px solid #2a1b12", borderRadius: 4, transform: "rotateY(-4deg)" }} />
      <div
        style={{
          position: "absolute",
          left: 13,
          top: 9,
          width: 106 + openProgress * 3,
          height: 125,
          padding: "13px 12px",
          boxSizing: "border-box",
          backgroundColor: "#ead9b4",
          color: INK,
          border: "1px solid rgba(75,48,26,0.55)",
          transform: `rotateY(${(1 - openProgress) * 10}deg)`,
          transformOrigin: "right center",
        }}
      >
        <div style={{ fontFamily: SERIF, fontSize: 22 }}>账本</div>
        <div style={{ marginTop: 9, fontSize: 13, lineHeight: 1.8 }}>铁路折扣<br />运输数据<br />股份</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 122,
          top: 9,
          width: 108,
          height: 125,
          padding: "13px 12px",
          boxSizing: "border-box",
          backgroundColor: "#f4e8c9",
          color: INK,
          border: "1px solid rgba(75,48,26,0.55)",
          transform: `rotateY(${(1 - openProgress) * -18}deg)`,
          transformOrigin: "left center",
        }}
      >
        <div style={{ fontSize: 13, opacity: 0.72 }}>标准石油</div>
        <div style={{ marginTop: 13, height: 4, background: "rgba(69,48,30,0.28)" }} />
        <div style={{ marginTop: 12, height: 4, width: "72%", background: "rgba(69,48,30,0.2)" }} />
        <div style={{ marginTop: 12, height: 4, width: "88%", background: "rgba(69,48,30,0.2)" }} />
        <div style={{ marginTop: 16, color: GOLD, fontFamily: SERIF, fontSize: 18 }}>控制</div>
      </div>
    </div>
  );
}

function MovingSlip({ delay, endX, endY, label = "运输数据", startX = 0.18, startY = 0.46, zIndex = 52 }: { delay: number; endX: number; endY: number; label?: string; startX?: number; startY?: number; zIndex?: number }) {
  const frame = useCurrentFrame();
  const progress = enterProgress(frame, delay, 38);
  const eased = clamp(progress);
  const x = interpolate(eased, [0, 0.5, 1], [startX, (startX + endX) / 2 + 0.06, endX]);
  const y = interpolate(eased, [0, 0.5, 1], [startY, startY - 0.1, endY]);
  const rotation = interpolate(eased, [0, 1], [-8, 3]);
  return (
    <div style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: 132, height: 62, zIndex, opacity: eased, transform: `translate(-50%, -50%) rotate(${rotation}deg)`, transformOrigin: "center center", padding: "9px 10px", boxSizing: "border-box", backgroundColor: "#f5e8c7", border: "1px solid rgba(80,55,31,0.6)", boxShadow: "0 8px 14px rgba(0,0,0,0.34)", color: INK, fontFamily: FONT }}>
      <div style={{ fontSize: 13 }}>{label}</div>
      <div style={{ marginTop: 8, height: 3, width: "78%", background: "rgba(63,45,29,0.34)" }} />
      <div style={{ marginTop: 7, height: 3, width: "56%", background: "rgba(63,45,29,0.2)" }} />
    </div>
  );
}

function FlowPath({ delay = 0, from, to, color = GOLD, zIndex = 20 }: { delay?: number; from: [number, number]; to: [number, number]; color?: string; zIndex?: number }) {
  const frame = useCurrentFrame();
  const progress = enterProgress(frame, delay, 32);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const controlX = (x1 + x2) / 2;
  const controlY = Math.min(y1, y2) - 120;
  const path = `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
  return (
    <svg viewBox="0 0 720 1280" width="100%" height="100%" style={{ position: "absolute", inset: 0, zIndex, overflow: "visible", pointerEvents: "none" }}>
      <path d={path} fill="none" stroke="rgba(26,20,15,0.38)" strokeWidth="10" strokeLinecap="round" opacity={progress * 0.32} />
      <path d={path} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress} opacity={progress} />
      {progress > 0.92 && <circle cx={x2} cy={y2} r="7" fill="#fff2c9" stroke={color} strokeWidth="3" />}
    </svg>
  );
}

function NodeTag({ label, detail, x, y, delay, rotate = 0 }: { label: string; detail: string; x: number; y: number; delay: number; rotate?: number }) {
  const frame = useCurrentFrame();
  const enter = enterProgress(frame, delay, 18);
  return (
    <div style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: 148, height: 82, zIndex: 46, opacity: enter, transform: `translate(-50%, ${(1 - enter) * 34}px) rotate(${rotate}deg)`, transformOrigin: "center center", padding: "11px 12px", boxSizing: "border-box", backgroundColor: "#e9d6a9", border: "1px solid rgba(76,51,29,0.62)", boxShadow: "0 10px 17px rgba(0,0,0,0.34)", fontFamily: FONT, color: INK }}>
      <div style={{ fontFamily: SERIF, fontSize: 19 }}>{label}</div>
      <div style={{ marginTop: 7, fontSize: 12, opacity: 0.7 }}>{detail}</div>
      <div style={{ position: "absolute", left: 12, right: 12, bottom: 10, height: 3, background: "rgba(63,45,29,0.2)" }} />
    </div>
  );
}

function RopeNetwork() {
  return (
    <>
      <FlowPath delay={18} from={[360, 780]} to={[156, 390]} />
      <FlowPath delay={38} from={[360, 780]} to={[564, 390]} />
      <FlowPath delay={58} from={[360, 780]} to={[156, 845]} />
      <FlowPath delay={78} from={[360, 780]} to={[564, 845]} />
    </>
  );
}

function HookScene() {
  return (
    <SceneBackground image={ASSETS.office} backgroundKey="office">
      <ShotHeader kicker="标准石油 · 第一笔控制" title="控制先于竞争" />
      <DeskEdge />
      <Character src={ASSETS.rockefellerPoint} x={0.58} width={1.02} zoom={2.18} bottom={0.06} pose="point" direction={-1} />
      <Ledger x={0.54} y={0.63} delay={22} />
      <PaperSheet x={0.2} y={0.49} width={178} height={118} rotate={-8} delay={46} label="对手" detail="运输成本\n路线与价格" color="#5b3828" />
      <FlowPath delay={72} from={[180, 630]} to={[382, 900]} color={RED} zIndex={24} />
      <div style={{ position: "absolute", left: 42, bottom: 210, zIndex: 82, color: "#f3d59d", fontFamily: SERIF, fontSize: 25, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>先拿到对手的成本，才有资格谈“赢”。</div>
      <Caption text="有些人的败局，是因为输给了对手。洛克菲勒不是。" />
    </SceneBackground>
  );
}

function RailScene() {
  return (
    <SceneBackground image={ASSETS.desk} backgroundKey="desk">
      <ShotHeader kicker="铁路协议" title="折扣与信息一起进账" />
      <DeskEdge />
      <Character src={ASSETS.morris} x={0.18} width={0.82} zoom={2.12} bottom={0.08} pose="stand" direction={-1} zIndex={31} />
      <Character src={ASSETS.rockefellerWrite} x={0.68} width={0.9} zoom={2.15} bottom={0.07} delay={24} pose="write" direction={1} zIndex={34} />
      <PaperSheet x={0.42} y={0.25} width={192} height={142} rotate={-5} delay={34} label="铁路运价表" detail="标准石油\n每桶运费" stamp="折扣 -20%" zIndex={44} />
      <Ledger x={0.68} y={0.68} delay={45} zIndex={43} />
      <FlowPath delay={64} from={[300, 410]} to={[485, 850]} color={GOLD} zIndex={25} />
      <MovingSlip delay={72} endX={0.66} endY={0.72} label="竞争对手数据" startX={0.42} startY={0.38} />
      <div style={{ position: "absolute", left: 40, bottom: 205, zIndex: 82, color: "#f3d59d", fontFamily: SERIF, fontSize: 24, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>他拿到的不是一张优惠券，而是一条信息通道。</div>
      <Caption text="铁路给他折扣，竞争对手的运输数据会流到他手里。" />
    </SceneBackground>
  );
}

function NetworkScene() {
  return (
    <SceneBackground image={ASSETS.industrial} backgroundKey="industrial">
      <ShotHeader kicker="体系成形" title="一层层收进自己的规则" />
      <Character src={ASSETS.rockefellerPoint} x={0.5} width={0.9} zoom={2.02} bottom={0.06} delay={4} pose="point" zIndex={35} />
      <RopeNetwork />
      <div style={{ position: "absolute", left: "50%", top: "60%", width: 166, height: 108, zIndex: 47, transform: "translate(-50%, -50%) rotate(-2deg)", backgroundColor: "#4a2f1e", border: "2px solid #251910", boxShadow: "0 13px 18px rgba(0,0,0,0.4)", color: PAPER, fontFamily: SERIF, textAlign: "center", paddingTop: 25, boxSizing: "border-box" }}>
        <div style={{ fontSize: 24 }}>标准石油</div>
        <div style={{ marginTop: 13, fontFamily: FONT, fontSize: 13, color: GOLD }}>同一套账本</div>
      </div>
      <NodeTag label="管线" detail="输送" x={0.22} y={0.3} delay={18} rotate={-5} />
      <NodeTag label="炼油厂" detail="加工" x={0.78} y={0.3} delay={38} rotate={4} />
      <NodeTag label="仓储" detail="库存" x={0.22} y={0.66} delay={58} rotate={3} />
      <NodeTag label="销售网络" detail="出货" x={0.78} y={0.66} delay={78} rotate={-4} />
      <Caption text="管线、炼油厂、仓储和销售网络，被他一层层收进自己的体系。" />
    </SceneBackground>
  );
}

function CourtScene() {
  const frame = useCurrentFrame();
  const cut = interpolate(frame, [68, 88], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <SceneBackground image={ASSETS.office} backgroundKey="office">
      <ShotHeader kicker="1911 · 最高法院" title="法律伸进这张网络" />
      <DeskEdge />
      <Character src={ASSETS.rockefellerSeat} x={0.56} width={1.06} zoom={2.18} bottom={0.07} delay={5} pose="seat" zIndex={33} />
      <Ledger x={0.53} y={0.66} delay={18} zIndex={44} />
      <FlowPath delay={10} from={[126, 485]} to={[500, 878]} color={GOLD} zIndex={23} />
      <PaperSheet x={0.24} y={0.27} width={236} height={170} rotate={-5} delay={26} label="美国最高法院" detail="命令拆解\n标准石油" stamp="拆 解" zIndex={55} />
      <div style={{ position: "absolute", left: 104, right: 104, top: 645, height: 7, zIndex: 57, backgroundColor: RED, opacity: cut, transform: `scaleX(${cut}) rotate(-7deg)`, transformOrigin: "left center", boxShadow: "0 0 14px rgba(168,75,62,0.7)" }} />
      <div style={{ position: "absolute", left: 46, bottom: 206, zIndex: 82, color: "#f3d59d", fontFamily: SERIF, fontSize: 24, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>判决切断了统一的外壳。</div>
      <Caption text="1911年，美国最高法院命令拆解标准石油。" />
    </SceneBackground>
  );
}

function SplitScene() {
  const frame = useCurrentFrame();
  const split = enterProgress(frame, 40, 30);
  const pull = enterProgress(frame, 78, 24);
  const slips = [
    { label: "炼油公司", x: 0.18, y: 0.31, dx: -72, dy: -24, r: -8 },
    { label: "铁路公司", x: 0.78, y: 0.31, dx: 72, dy: -16, r: 7 },
    { label: "管线公司", x: 0.2, y: 0.57, dx: -76, dy: 35, r: -5 },
    { label: "销售公司", x: 0.78, y: 0.57, dx: 76, dy: 32, r: 6 },
  ];
  return (
    <SceneBackground image={ASSETS.industrial} backgroundKey="industrial">
      <ShotHeader kicker="拆解之后" title="公司散开，所有权留下" />
      <Character src={ASSETS.rockefellerSeat} x={0.51} width={1.02} zoom={2.1} bottom={0.05} delay={5} pose="seat" zIndex={32} />
      <div style={{ position: "absolute", left: "50%", top: "30%", width: 202, height: 112, zIndex: 50, transform: `translate(-50%, -50%) scale(${1 - split * 0.34})`, opacity: 1 - split * 0.8, padding: "28px 16px", boxSizing: "border-box", textAlign: "center", fontFamily: SERIF, fontSize: 25, color: PAPER, backgroundColor: "#4b2f1d", border: "2px solid #261910", boxShadow: "0 13px 18px rgba(0,0,0,0.4)" }}>标准石油</div>
      {slips.map((slip, index) => {
        const local = clamp((split * 1.25) - index * 0.12);
        const x = slip.x * 720 + slip.dx * local;
        const y = slip.y * 1280 + slip.dy * local;
        const opacity = clamp(local * 1.5);
        return (
          <div key={slip.label} style={{ position: "absolute", left: x, top: y, width: 142, height: 78, zIndex: 52, opacity, transform: `translate(-50%, -50%) rotate(${slip.r * local}deg)`, padding: "21px 8px", boxSizing: "border-box", textAlign: "center", fontFamily: SERIF, fontSize: 18, color: INK, backgroundColor: "#ead6a7", border: "1px solid rgba(77,51,28,0.65)", boxShadow: "0 9px 15px rgba(0,0,0,0.35)" }}>{slip.label}</div>
        );
      })}
      {slips.map((slip, index) => <FlowPath key={slip.label} delay={82 + index * 6} from={[slip.x * 720 + slip.dx, slip.y * 1280 + slip.dy]} to={[360, 900]} color={GOLD} zIndex={24} />)}
      <div style={{ position: "absolute", left: 46, bottom: 206, zIndex: 82, color: "#f3d59d", fontFamily: SERIF, fontSize: 24, textShadow: "0 2px 8px rgba(0,0,0,0.8)", opacity: pull }}>法律拆掉的是公司外壳，不是他手里的股份。</div>
      <Caption text="看起来，帝国终于被法律击碎了。" />
    </SceneBackground>
  );
}

function EndingScene() {
  const frame = useCurrentFrame();
  const settle = enterProgress(frame, 18, 26);
  const ownership = enterProgress(frame, 48, 30);
  return (
    <SceneBackground image={ASSETS.office} backgroundKey="office">
      <ShotHeader kicker="真正的反转" title="拆的是公司，不是所有权" />
      <Character src={ASSETS.rockefellerSeat} x={0.5} width={1.04} zoom={2.14} bottom={0.06} delay={4} pose="seat" zIndex={38} />
      <Ledger x={0.5} y={0.65} delay={20} zIndex={43} />
      <div style={{ position: "absolute", left: "50%", top: "28%", zIndex: 53, opacity: settle, transform: `translate(-50%, -50%) scale(${0.92 + settle * 0.08})`, padding: "14px 18px", color: PAPER, backgroundColor: "rgba(46,30,20,0.92)", border: "1px solid rgba(230,190,110,0.7)", fontFamily: SERIF, fontSize: 23, letterSpacing: "0.05em", boxShadow: "0 11px 20px rgba(0,0,0,0.38)" }}>三十多家公司</div>
      <FlowPath delay={48} from={[145, 348]} to={[352, 842]} color={GOLD} zIndex={25} />
      <FlowPath delay={60} from={[575, 348]} to={[385, 842]} color={GOLD} zIndex={25} />
      <FlowPath delay={72} from={[145, 425]} to={[330, 885]} color={GOLD} zIndex={25} />
      <FlowPath delay={84} from={[575, 425]} to={[400, 890]} color={GOLD} zIndex={25} />
      {["炼油", "铁路", "管线", "销售"].map((label, index) => <div key={label} style={{ position: "absolute", left: `${index % 2 === 0 ? 20 : 80}%`, top: `${index < 2 ? 24 : 31}%`, zIndex: 56, opacity: clamp((ownership * 1.35) - index * 0.08), transform: `translate(-50%, -50%) rotate(${index % 2 === 0 ? -5 : 5}deg)`, padding: "8px 12px", color: INK, backgroundColor: "#ead6a7", border: "1px solid rgba(77,51,28,0.6)", fontFamily: FONT, fontSize: 15, boxShadow: "0 7px 13px rgba(0,0,0,0.3)" }}>{label}</div>)}
      <div style={{ position: "absolute", left: 45, right: 45, bottom: 190, zIndex: 82, color: "#f6d89d", fontFamily: SERIF, fontSize: 27, lineHeight: 1.35, textAlign: "center", opacity: ownership, textShadow: "0 2px 10px rgba(0,0,0,0.84)" }}>洛克菲勒却因为持有这些公司的股份，变得更富。</div>
      <Caption text="可接下来发生的事，才是整个故事最讽刺的地方。" />
    </SceneBackground>
  );
}

const SCENES = [
  { id: "hook", duration: 150, component: HookScene },
  { id: "rail", duration: 150, component: RailScene },
  { id: "network", duration: 156, component: NetworkScene },
  { id: "court", duration: 150, component: CourtScene },
  { id: "split", duration: 150, component: SplitScene },
  { id: "ending", duration: 144, component: EndingScene },
] as const;

export const PAPER_STORY_DURATION = SCENES.reduce((total, scene) => total + scene.duration, 0);

export const PaperStoryExperiment: React.FC<PaperStoryExperimentProps> = ({ audioUrl }) => {
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#11100d" }}>
      {audioUrl && <Audio src={audioUrl} volume={0.98} />}
      {SCENES.map(({ id, duration, component: Scene }) => {
        const from = cursor;
        cursor += duration;
        return (
          <Sequence key={id} from={from} durationInFrames={duration} premountFor={12}>
            <Scene />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
