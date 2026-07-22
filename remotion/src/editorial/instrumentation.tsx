import { createContext, useContext, useRef, type CSSProperties, type ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { isFrameVisible } from "./timing";

export const TELEMETRY_NAMESPACE = "huobao.editorial.telemetry/v1";

export type LayerInterval = {
  startFrame: number;
  endFrame: number;
};

export type LayerGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayerTransform = {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};

export type InstrumentedLayerSample = {
  layerId: string;
  interval: LayerInterval;
  geometry: LayerGeometry;
  transform: LayerTransform;
  transformOrigin: { x: number; y: number };
  opacity: number;
  mask?: LayerGeometry;
  assetId?: string;
  decodeStatus: "decoded" | "pending" | "failed" | "not_applicable";
};

export type FramePacket = {
  namespace: typeof TELEMETRY_NAMESPACE;
  operationId: string;
  frame: number;
  layers: InstrumentedLayerSample[];
};

export type InstrumentedLayerProps = {
  layerId: string;
  startFrame: number;
  endFrame: number;
  /** Offset from a Sequence-local frame to the composition-global frame. */
  frameOffset?: number;
  geometry?: LayerGeometry;
  transform?: LayerTransform;
  transformOrigin?: { x: number; y: number };
  opacity?: number;
  mask?: LayerGeometry;
  assetId?: string;
  decodeStatus?: InstrumentedLayerSample["decodeStatus"];
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
};

const finite = (value: number, label: string) => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
};

export function assertLayerInterval(interval: LayerInterval) {
  if (!Number.isInteger(interval.startFrame) || !Number.isInteger(interval.endFrame)) throw new Error("layer interval must use integer frames");
  if (interval.startFrame < 0 || interval.startFrame >= interval.endFrame) throw new Error("layer interval must be positive and half-open");
  return interval;
}

export function InstrumentedLayer({
  layerId,
  startFrame,
  endFrame,
  frameOffset = 0,
  geometry = { x: 0, y: 0, width: 1, height: 1 },
  transform = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  transformOrigin = { x: 0.5, y: 0.5 },
  opacity = 1,
  mask,
  assetId,
  decodeStatus = "not_applicable",
  style,
  className,
  children,
}: InstrumentedLayerProps) {
  assertLayerInterval({ startFrame, endFrame });
  const frame = useCurrentFrame();
  const active = isFrameVisible(frame, startFrame, endFrame);
  const telemetry = useContext(telemetryContext);
  if (telemetry && active) {
    telemetry.layers.push(sampleLayer({
      layerId,
      interval: {
        startFrame: startFrame + frameOffset,
        endFrame: endFrame + frameOffset,
      },
      geometry,
      transform,
      transformOrigin,
      opacity,
      mask,
      assetId,
      decodeStatus,
    }));
  }
  return (
    <div
      className={className}
      style={style}
      data-editorial-layer-id={layerId}
      data-editorial-start-frame={startFrame}
      data-editorial-end-frame={endFrame}
      data-editorial-asset-id={assetId}
      data-editorial-decode-status={decodeStatus}
      data-editorial-visible={active ? "true" : "false"}
    >
      {children}
    </div>
  );
}

export function sampleLayer({
  layerId,
  interval,
  geometry,
  transform = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  transformOrigin = { x: 0.5, y: 0.5 },
  opacity = 1,
  mask,
  assetId,
  decodeStatus = "not_applicable",
}: InstrumentedLayerSample): InstrumentedLayerSample {
  assertLayerInterval(interval);
  const boundedOpacity = finite(opacity, "opacity");
  if (boundedOpacity < 0 || boundedOpacity > 1) throw new Error("opacity must be in [0, 1]");
  for (const [key, value] of Object.entries(geometry)) finite(value, `geometry.${key}`);
  for (const [key, value] of Object.entries(transform)) finite(value, `transform.${key}`);
  for (const [key, value] of Object.entries(transformOrigin)) finite(value, `transformOrigin.${key}`);
  return {
    layerId,
    interval: { ...interval },
    geometry: { ...geometry },
    transform: { ...transform },
    transformOrigin: { ...transformOrigin },
    opacity: boundedOpacity,
    ...(mask ? { mask: { ...mask } } : {}),
    ...(assetId ? { assetId } : {}),
    decodeStatus,
  };
}

/** Build the sole bounded packet for one rendered frame. */
export function buildFramePacket(operationId: string, frame: number, layers: InstrumentedLayerSample[]): FramePacket {
  if (!operationId.trim()) throw new Error("operationId must not be empty");
  if (!Number.isInteger(frame) || frame < 0) throw new Error("frame must be a non-negative integer");
  const seen = new Set<string>();
  const visible = layers.filter((layer) => isFrameVisible(frame, layer.interval.startFrame, layer.interval.endFrame));
  const sorted = visible.map((layer) => sampleLayer(layer)).sort((left, right) => left.layerId.localeCompare(right.layerId));
  for (const layer of sorted) {
    if (seen.has(layer.layerId)) throw new Error(`duplicate layer id ${layer.layerId}`);
    seen.add(layer.layerId);
  }
  return { namespace: TELEMETRY_NAMESPACE, operationId, frame, layers: sorted };
}

export const framePacketForFrame = buildFramePacket;

type TelemetryRegistry = {
  operationId: string;
  frame: number;
  layers: InstrumentedLayerSample[];
};

const telemetryContext = createContext<TelemetryRegistry | null>(null);

function operationIdFromBrowser() {
  if (typeof window === "undefined") return "";
  const raw = (window as Window & { remotion_envVariables?: Record<string, string> | string }).remotion_envVariables;
  const env = typeof raw === "string" ? (() => {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return undefined;
    }
  })() : raw;
  return typeof env?.EDITORIAL_OPERATION_ID === "string" ? env.EDITORIAL_OPERATION_ID : "";
}

/**
 * Collects samples produced while the current frame renders and emits one
 * bounded browser console packet for the adapter's onBrowserLog hook.
 */
export function EditorialTelemetryProvider({ children, operationId = operationIdFromBrowser() }: { children: ReactNode; operationId?: string }) {
  const frame = useCurrentFrame();
  const registry = useRef<InstrumentedLayerSample[]>([]);
  registry.current = [];
  const context: TelemetryRegistry = { operationId, frame, layers: registry.current };
  return (
    <telemetryContext.Provider value={context}>
      {children}
      <EditorialTelemetryEmitter registry={registry.current} operationId={operationId} frame={frame} />
    </telemetryContext.Provider>
  );
}

function EditorialTelemetryEmitter({ registry, operationId, frame }: { registry: InstrumentedLayerSample[]; operationId: string; frame: number }) {
  if (operationId.trim()) {
    const packet = buildFramePacket(operationId, frame, registry);
    // Remotion forwards browser console messages to renderMedia's onBrowserLog.
    // Console errors are forwarded through Remotion's browser-log hook without
    // contaminating the adapter's stdout JSON protocol with renderer progress.
    console.error(`${TELEMETRY_NAMESPACE} ${JSON.stringify(packet)}`);
  }
  return null;
}
