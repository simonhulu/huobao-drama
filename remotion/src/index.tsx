import {
  Composition,
  registerRoot,
  CalculateMetadataFunction,
  staticFile,
} from "remotion";
import { BlackTitleIntro } from "./BlackTitleIntro";
import { DynastyYearFlash } from "./DynastyYearFlash";
import { VintageKenBurns } from "./VintageKenBurns";
import { RecapCarousel } from "./RecapCarousel";
import { WarMapParallaxDemo } from "./WarMapParallaxDemo";
import { CutoutParallaxDemo } from "./CutoutParallaxDemo";
import { EpisodeShowcase } from "./EpisodeShowcase";
import { PaperStoryExperiment, PAPER_STORY_DURATION } from "./PaperStoryExperiment";
import { SceneFitValidation } from "./SceneFitValidation";
import { Opening30Demo, OPENING_30_DURATION } from "./Opening30Demo";
import { Opening30GridDemo, OPENING_30_GRID_DURATION } from "./Opening30GridDemo";
import { TemporalGridEpisode } from "./TemporalGridEpisode";
import { NarrativeEpisode } from "./NarrativeEpisode";
import {
  NarrativeStoryboardPilot,
  calculateNarrativeStoryboardPilotMetadata,
} from "./NarrativeStoryboardPilot";
import { GridStoryPreview } from "./GridStoryPreview";
import { DharmaEpisode } from "./DharmaEpisode";
import { DharmaComicEpisode } from "./DharmaComicPrototype";
import { DharmaTextOverlay } from "./DharmaTextOverlay";
import {
  MagnatesEditorial,
  MagnatesEditorialPreview,
  MAGNATES_EDITORIAL_DURATION,
  defaultMagnatesEditorialShots,
} from "./MagnatesEditorial";

const BASE_URL = "http://localhost:5679";

function dimensionsForAspectRatio(aspectRatio?: string) {
  switch (aspectRatio) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "4:3":
      return { width: 1440, height: 1080 };
    case "16:9":
    default:
      return { width: 1280, height: 720 };
  }
}

function calculateMetadata<
  Props extends { aspectRatio?: string; durationInFrames?: number; fps?: number; width?: number; height?: number }
>({
  props,
}: Parameters<CalculateMetadataFunction<Props>>[0]): ReturnType<
  CalculateMetadataFunction<Props>
> {
  const explicitWidth = props.width;
  const explicitHeight = props.height;
  const hasExplicitDimensions = typeof explicitWidth === "number"
    && typeof explicitHeight === "number"
    && Number.isInteger(explicitWidth)
    && Number.isInteger(explicitHeight)
    && explicitWidth > 0
    && explicitHeight > 0;
  const result: any = hasExplicitDimensions
    ? { width: explicitWidth, height: explicitHeight }
    : dimensionsForAspectRatio(props.aspectRatio);
  if (typeof props.durationInFrames === "number" && props.durationInFrames > 0) {
    result.durationInFrames = props.durationInFrames;
  }
  if (typeof props.fps === "number" && props.fps > 0) {
    result.fps = props.fps;
  }
  return result;
}

const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DharmaTextOverlay"
        component={DharmaTextOverlay}
        durationInFrames={450}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 450,
          fps: 30,
          width: 1280,
          height: 720,
          subtitles: [],
          quotes: [],
        }}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="BlackTitleIntro"
        component={BlackTitleIntro}
        durationInFrames={90}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          mainText: "功臣的尸骨未寒",
          subText: "皇帝就抄了他的家",
          images: [
            `${BASE_URL}/static/images/53bc2d21-1976-4215-9eb9-a491da1aa189.png`,
            `${BASE_URL}/static/images/9fcfc877-8bc8-42b2-a63f-6d6c1e7f829d.png`,
            `${BASE_URL}/static/images/b4783a49-b43a-4587-b745-b950ac57816a.png`,
            `${BASE_URL}/static/images/a4859028-8875-4e1e-b37b-400c3bc7ae30.png`,
          ],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="DynastyYearFlash"
        component={DynastyYearFlash}
        durationInFrames={120}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          cards: [
            { text: "大明", sub: "Ming Dynasty" },
            { text: "万历十年", sub: "Year of Wanli 10" },
            { text: "1582", sub: "June" },
            { text: "张居正卒", sub: "Zhang Juzheng died" },
          ],
          bellUrl: `${BASE_URL}/static/intros/bell_sfx.m4a`,
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="VintageKenBurns"
        component={VintageKenBurns}
        durationInFrames={180}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          image: `${BASE_URL}/static/images/b4783a49-b43a-4587-b745-b950ac57816a.png`,
          title: "抄家灭门",
          subtitle: "一个王朝的清算",
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="RecapCarousel"
        component={RecapCarousel as any}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          dramaTitle: "张居正改革",
          recapScript: "上一集，张居正被抄家，长子自杀。改革功臣沦为罪臣。",
          imageUrls: [
            `${BASE_URL}/static/images/b4783a49-b43a-4587-b745-b950ac57816a.png`,
            `${BASE_URL}/static/images/9fcfc877-8bc8-42b2-a63f-6d6c1e7f829d.png`,
            `${BASE_URL}/static/images/a4859028-8875-4e1e-b37b-400c3bc7ae30.png`,
          ],
          audioUrl: `${BASE_URL}/static/intros/bell_sfx.m4a`,
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="WarMapParallaxDemo"
        component={WarMapParallaxDemo as any}
        durationInFrames={360}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          image: staticFile("war-map/portrait.png"),
          backgroundLayer: staticFile("war-map/background.png"),
          foregroundLayer: staticFile("war-map/foreground.png"),
          title: "大明风云 · 静态图动态化实验",
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="CutoutParallaxDemo"
        component={CutoutParallaxDemo}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          aspectRatio: "16:9",
          background: staticFile("war-map/background.png"),
          subject: staticFile("cutout-poc/subject.png"),
          foreground: staticFile("war-map/foreground.png"),
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="EpisodeShowcase"
        component={EpisodeShowcase as any}
        durationInFrames={30}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          episodeId: 500,
          episodeNumber: 1,
          title: "第一集：170年前的谜题",
          fps: 30,
          durationInFrames: 30,
          shots: [],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="PaperStoryExperiment"
        component={PaperStoryExperiment}
        durationInFrames={PAPER_STORY_DURATION}
        fps={30}
        width={720}
        height={1280}
        defaultProps={{
          durationInFrames: PAPER_STORY_DURATION,
          audioUrl: `${BASE_URL}/audio/bfec9d8c-9d71-42c3-ac75-d227f7b8ef14_pre_episode563.mp3`,
          sourceVoice: { audioConfigId: 4, voiceId: "DaniangzhuVoice01" },
        }}
      />

      <Composition
        id="SceneFitValidation"
        component={SceneFitValidation}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 240,
          audioUrl: `${BASE_URL}/audio/bfec9d8c-9d71-42c3-ac75-d227f7b8ef14_pre_episode563.mp3`,
        }}
      />

      <Composition
        id="Opening30Demo"
        component={Opening30Demo}
        durationInFrames={OPENING_30_DURATION}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: OPENING_30_DURATION,
          audioUrl: `${BASE_URL}/audio/bfec9d8c-9d71-42c3-ac75-d227f7b8ef14_pre_episode563.mp3`,
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="Opening30GridDemo"
        component={Opening30GridDemo}
        durationInFrames={OPENING_30_GRID_DURATION}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: OPENING_30_GRID_DURATION,
          audioUrl: `${BASE_URL}/audio/bfec9d8c-9d71-42c3-ac75-d227f7b8ef14_pre_episode563.mp3`,
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="TemporalGridEpisode"
        component={TemporalGridEpisode}
        durationInFrames={900}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 900,
          audioUrl: `${BASE_URL}/static/audio/bfec9d8c-9d71-42c3-ac75-d227f7b8ef14_pre_episode563.mp3`,
          shots: [],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="NarrativeEpisode"
        component={NarrativeEpisode}
        durationInFrames={900}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 900,
          fps: 30,
          aspectRatio: "16:9",
          shots: [],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="NarrativeStoryboardPilot"
        component={NarrativeStoryboardPilot}
        durationInFrames={30}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationMs: 1000,
          audioSrc: null,
          captions: [],
          sequences: [],
          shots: [],
        }}
        calculateMetadata={calculateNarrativeStoryboardPilotMetadata}
      />

      <Composition
        id="GridStoryPreview"
        component={GridStoryPreview}
        durationInFrames={1917}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 1917,
          shots: [],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="DharmaEpisode"
        component={DharmaEpisode}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: 300,
          audio: "",
          segments: [],
          quotes: [],
          subtitles: [],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="DharmaComicEpisode"
        component={DharmaComicEpisode}
        durationInFrames={465}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          variant: "progressive_five",
          durationInFrames: 465,
          audio: "dharma-assets/ce1674d59583bc92dbc9.mp3",
          narrationEndFrame: 463,
          narrationWindows: [{ startFrame: 0, endFrame: 463 }],
          bgm: {
            src: "dharma-assets/46a08e047f7553417871.mp3",
            volume: 0.0374,
            narrationVolume: 0.0187,
            fadeInSec: 3,
            fadeOutSec: 5,
            loopCrossfadeSec: 4,
            sourceDurationSec: 542.772245,
          },
          segments: [{
            kind: "image",
            src: "dharma-assets/a5d8724ec958a61760ee.png",
            startFrame: 0,
            durationInFrames: 465,
            move: "push",
            treatment: "surreal_dream",
            shotFunction: "narrative_illustration",
          }],
          quotes: [],
          subtitles: [
            { text: "活得最通透的人，", startSec: 0, endSec: 1.6168421052631576 },
            { text: "在亲情关系里往往最冷。", startSec: 1.6168421052631576, endSec: 3.94 },
            { text: "不是冷暴力的冷，", startSec: 3.94, endSec: 5.483529411764706 },
            { text: "不是不管不问的冷。", startSec: 5.483529411764706, endSec: 7.32 },
            { text: "是父母一句抱怨不会让他失眠，", startSec: 7.32, endSec: 9.865454545454545 },
            { text: "孩子一次考试不会让他崩溃，", startSec: 9.865454545454545, endSec: 12.22909090909091 },
            { text: "兄弟的不理解不会让他心如刀割的冷。", startSec: 12.22909090909091, endSec: 15.42 },
          ],
          panels: [
            {
              src: "dharma-assets/35ceb7380792bd615aef.png",
              focusX: 49,
              focusY: 50,
              emphasisStartFrame: 0,
            },
            {
              src: "dharma-assets/8b1e1e3e68d6b6cd0ebd.png",
              focusX: 35,
              focusY: 48,
              emphasisStartFrame: 118,
              bubble: {
                kind: "caption",
                text: "仍然回应，也仍然照顾",
                x: 58,
                y: 7,
              },
            },
            {
              src: "dharma-assets/5e274874203892acbf4d.png",
              focusX: 38,
              focusY: 48,
              emphasisStartFrame: 220,
              bubble: {
                kind: "speech",
                text: "你就不能替家里想想？",
                x: 4,
                y: 7,
                tail: "left",
              },
            },
            {
              src: "dharma-assets/015505356e176c9ad03c.png",
              focusX: 50,
              focusY: 48,
              emphasisStartFrame: 296,
              bubble: {
                kind: "speech",
                text: "我没考好……",
                x: 56,
                y: 7,
                tail: "right",
              },
            },
            {
              src: "dharma-assets/985166e6a5bd79240504.png",
              focusX: 50,
              focusY: 48,
              emphasisStartFrame: 367,
              bubble: {
                kind: "speech",
                text: "你根本不懂我。",
                x: 55,
                y: 7,
                tail: "right",
              },
            },
          ],
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="MagnatesEditorial"
        component={MagnatesEditorial}
        durationInFrames={1}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{} as any}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="MagnatesEditorialPreview"
        component={MagnatesEditorialPreview}
        durationInFrames={MAGNATES_EDITORIAL_DURATION}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          durationInFrames: MAGNATES_EDITORIAL_DURATION,
          fps: 30,
          title: "Magnates editorial grammar demo",
          shots: defaultMagnatesEditorialShots,
        }}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};

registerRoot(RemotionRoot);
