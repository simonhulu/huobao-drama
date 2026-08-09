#!/usr/bin/env node

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {buildNarrativeStoryboardDirectorInputs} from './narrative_storyboard_director_core.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const propsPath = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const props = JSON.parse(readFileSync(propsPath, 'utf8'));
const fps = 30;
const secondsIndex = process.argv.indexOf('--seconds');
const requestedSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : null;
const previewSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : null;
const limitMs = Math.min(props.durationMs, previewSeconds ? Math.round(previewSeconds * 1000) : props.durationMs);
const runLabel = previewSeconds ? `-${previewSeconds}s` : '';
const work = path.join(root, `.tmp/project8-editorial-director${runLabel}`);
const outputRoot = path.join(root, '.remotion-editorial-runs', `project8${runLabel}`);

const editorialHints = [
  {role: 'hook', visualIntent: '以皇家围猎的运动规模建立危险现场', emphasis: 0.94, focus: {x: 0.5, y: 0.46}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '先揭示李敢突然死亡，再让环境压住人物', emphasis: 0.95, focus: {x: 0.56, y: 0.62}, typographyVariant: 'impact', transitionEnergy: 'low', soundIntent: 'none'},
  {role: 'reversal', visualIntent: '把官方鹿撞说法与尸体现场形成视觉冲突', emphasis: 0.9, focus: {x: 0.58, y: 0.62}, typographyVariant: 'stamp', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'reversal', visualIntent: '从史书记载切入真正的射杀者', emphasis: 0.93, focus: {x: 0.7, y: 0.45}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'mechanism', visualIntent: '用皇帝制止和遮掩的动作表现权力压案', emphasis: 0.82, focus: {x: 0.54, y: 0.42}, typographyVariant: 'whisper', transitionEnergy: 'medium', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '以兵器和对峙回答杀人动机的前因', emphasis: 0.9, focus: {x: 0.54, y: 0.49}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'mechanism', visualIntent: '李敢带着父亲之死逼近卫青', emphasis: 0.76, focus: {x: 0.52, y: 0.5}, typographyVariant: 'whisper', transitionEnergy: 'low', soundIntent: 'none'},
  {role: 'reversal', visualIntent: '以指控动作明确李敢把责任指向卫青', emphasis: 0.86, focus: {x: 0.52, y: 0.46}, typographyVariant: 'stamp', transitionEnergy: 'medium', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '冲突距离骤然缩短，愤怒转为行动', emphasis: 0.9, focus: {x: 0.5, y: 0.46}, typographyVariant: 'impact', transitionEnergy: 'low', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '武器接触成为这一叙事段的动作落点', emphasis: 0.96, focus: {x: 0.48, y: 0.42}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'reversal', visualIntent: '卫青受伤却抬手压下追责，动作与结果相反', emphasis: 0.91, focus: {x: 0.34, y: 0.42}, typographyVariant: 'stamp', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'mechanism', visualIntent: '霍去病得知消息后立即进入追击状态', emphasis: 0.78, focus: {x: 0.35, y: 0.46}, typographyVariant: 'whisper', transitionEnergy: 'low', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '以坠马后的静止结果完成死亡信息', emphasis: 0.97, focus: {x: 0.58, y: 0.58}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'comparison', visualIntent: '同框呈现卫青、霍去病与汉武帝的共同权力位置', emphasis: 0.72, focus: {x: 0.5, y: 0.46}, typographyVariant: 'stamp', transitionEnergy: 'medium', soundIntent: 'none'},
  {role: 'comparison', visualIntent: '用两人背向而立表现面对同一冲突的不同选择', emphasis: 0.84, focus: {x: 0.5, y: 0.48}, typographyVariant: 'stamp', transitionEnergy: 'medium', soundIntent: 'none'},
  {role: 'reversal', visualIntent: '从成年权力冲突拉回卫青童年的性格来源', emphasis: 0.88, focus: {x: 0.52, y: 0.62}, typographyVariant: 'impact', transitionEnergy: 'high', soundIntent: 'none'},
  {role: 'establishing', visualIntent: '以母亲、父亲和年幼卫青建立卑微出身', emphasis: 0.64, focus: {x: 0.5, y: 0.65}, typographyVariant: 'whisper', transitionEnergy: 'low', soundIntent: 'none'},
  {role: 'crisis', visualIntent: '让卫青与郑家兄弟的空间隔离直接可见', emphasis: 0.88, focus: {x: 0.34, y: 0.6}, typographyVariant: 'impact', transitionEnergy: 'medium', soundIntent: 'none'},
  {role: 'resolution', visualIntent: '用孤身放羊的远景结束前九十秒并引向苦难成长', emphasis: 0.66, focus: {x: 0.49, y: 0.56}, typographyVariant: 'whisper', transitionEnergy: 'low', soundIntent: 'none'},
];

function localStaticPath(src) {
  const url = new URL(src);
  if (!url.pathname.startsWith('/static/')) {
    throw new Error(`Project 8 Director assets must resolve below /static/: ${src}`);
  }
  return path.join(root, 'data', url.pathname);
}

if (editorialHints.length !== 19) throw new Error(`Project 8 requires 19 editorial hints, got ${editorialHints.length}`);

const result = buildNarrativeStoryboardDirectorInputs({
  root,
  propsPath,
  work,
  outputRoot,
  limitMs,
  fps,
  staticPathForSource: localStaticPath,
  hintForInterval: (_interval, index) => editorialHints[index],
  projectLabel: 'huobao-drama project 8',
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
