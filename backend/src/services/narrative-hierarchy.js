import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { listProjectShotVideos } from './render-artifacts.js';
/* ===== 导入（事务：整体替换该 episode+kind 的旧层级） ===== */
export function importNarrativePlan(input) {
    const now = new Date().toISOString();
    return db.transaction((tx) => {
        // 1. upsert plan
        const existing = tx.select().from(schema.narrativePlans)
            .where(and(eq(schema.narrativePlans.episodeId, input.episodeId), eq(schema.narrativePlans.kind, input.kind))).get();
        let planId;
        if (existing) {
            planId = existing.id;
            tx.update(schema.narrativePlans).set({
                remotionProjectId: input.remotionProjectId ?? existing.remotionProjectId,
                styleProfile: input.styleProfile ?? existing.styleProfile,
                durationMs: input.durationMs ?? existing.durationMs,
                timingSource: input.timingSource ?? existing.timingSource,
                sourcePath: input.sourcePath ?? existing.sourcePath,
                updatedAt: now,
            }).where(eq(schema.narrativePlans.id, planId)).run();
            // 清空旧子级（外键未启用，手动逐层删）
            const seqIds = tx.select({ id: schema.narrativeSequences.id }).from(schema.narrativeSequences)
                .where(eq(schema.narrativeSequences.planId, planId)).all().map(r => r.id);
            if (seqIds.length) {
                const eventIds = tx.select({ id: schema.narrationEvents.id }).from(schema.narrationEvents)
                    .where(inArray(schema.narrationEvents.sequenceId, seqIds)).all().map(r => r.id);
                if (eventIds.length) {
                    tx.delete(schema.visualBeats).where(inArray(schema.visualBeats.eventId, eventIds)).run();
                }
                tx.delete(schema.narrationEvents).where(inArray(schema.narrationEvents.sequenceId, seqIds)).run();
            }
            tx.delete(schema.narrativeSequences).where(eq(schema.narrativeSequences.planId, planId)).run();
            tx.delete(schema.storyboardSheets).where(eq(schema.storyboardSheets.planId, planId)).run();
            tx.delete(schema.storyboardPanels).where(eq(schema.storyboardPanels.planId, planId)).run();
            tx.delete(schema.renderShots).where(eq(schema.renderShots.planId, planId)).run();
            tx.delete(schema.soundBeats).where(eq(schema.soundBeats.planId, planId)).run();
        }
        else {
            const row = tx.insert(schema.narrativePlans).values({
                episodeId: input.episodeId,
                remotionProjectId: input.remotionProjectId ?? null,
                kind: input.kind,
                styleProfile: input.styleProfile ?? null,
                durationMs: input.durationMs ?? null,
                timingSource: input.timingSource ?? null,
                sourcePath: input.sourcePath ?? null,
                createdAt: now,
                updatedAt: now,
            }).returning({ id: schema.narrativePlans.id }).get();
            planId = row.id;
        }
        const stats = { sequences: 0, events: 0, beats: 0, panels: 0, sheets: 0, shots: 0, sounds: 0 };
        const seenSounds = new Set();
        for (const [seqIdx, seq] of input.sequences.entries()) {
            const seqRow = tx.insert(schema.narrativeSequences).values({
                planId,
                seqKey: seq.seqKey,
                seqIndex: seqIdx,
                title: seq.title ?? null,
                startMs: seq.startMs ?? null,
                endMs: seq.endMs ?? null,
            }).returning({ id: schema.narrativeSequences.id }).get();
            stats.sequences += 1;
            const eventIdByKey = new Map();
            for (const [evtIdx, evt] of (seq.events ?? []).entries()) {
                const evtRow = tx.insert(schema.narrationEvents).values({
                    sequenceId: seqRow.id,
                    eventKey: evt.eventKey,
                    eventIndex: evt.eventIndex ?? evtIdx,
                    startMs: evt.startMs ?? null,
                    endMs: evt.endMs ?? null,
                    text: evt.text ?? null,
                }).returning({ id: schema.narrationEvents.id }).get();
                eventIdByKey.set(evt.eventKey, evtRow.id);
                stats.events += 1;
            }
            const beatIdByKey = new Map();
            for (const beat of seq.beats ?? []) {
                const eventRowId = eventIdByKey.get(beat.eventKey);
                if (!eventRowId)
                    continue;
                const beatRow = tx.insert(schema.visualBeats).values({
                    eventId: eventRowId,
                    beatKey: beat.beatKey,
                    kind: beat.kind ?? null,
                    startMs: beat.startMs ?? null,
                    endMs: beat.endMs ?? null,
                    anchorId: beat.anchorId ?? null,
                    anchorVerified: beat.anchorVerified ?? null,
                    description: beat.description ?? null,
                }).returning({ id: schema.visualBeats.id }).get();
                beatIdByKey.set(beat.beatKey, beatRow.id);
                stats.beats += 1;
            }
            const sheetIdByKey = new Map();
            for (const sheet of seq.sheets ?? []) {
                const sheetRow = tx.insert(schema.storyboardSheets).values({
                    planId,
                    sequenceId: seqRow.id,
                    sheetKey: sheet.sheetKey,
                    title: sheet.title ?? null,
                    imageUrl: sheet.imageUrl ?? null,
                }).returning({ id: schema.storyboardSheets.id }).get();
                sheetIdByKey.set(sheet.sheetKey, sheetRow.id);
                stats.sheets += 1;
            }
            // panel 的 sheetKey 可能来自 sheet 的 panelKeys 反查
            const sheetKeyByPanel = new Map();
            for (const sheet of seq.sheets ?? []) {
                for (const pk of sheet.panelKeys ?? [])
                    sheetKeyByPanel.set(pk, sheet.sheetKey);
            }
            for (const panel of seq.panels ?? []) {
                const sheetKey = panel.sheetKey ?? sheetKeyByPanel.get(panel.panelKey) ?? null;
                tx.insert(schema.storyboardPanels).values({
                    planId,
                    beatId: panel.beatKey ? (beatIdByKey.get(panel.beatKey) ?? null) : null,
                    eventId: panel.eventKey ? (eventIdByKey.get(panel.eventKey) ?? null) : null,
                    sheetId: sheetKey ? (sheetIdByKey.get(sheetKey) ?? null) : null,
                    panelKey: panel.panelKey,
                    description: panel.description ?? null,
                    cropPath: panel.cropPath ?? null,
                    finalPath: panel.finalPath ?? null,
                    genStatus: 'pending',
                    updatedAt: now,
                }).run();
                stats.panels += 1;
            }
            for (const shot of seq.shots ?? []) {
                tx.insert(schema.renderShots).values({
                    planId,
                    eventId: shot.eventKey ? (eventIdByKey.get(shot.eventKey) ?? null) : null,
                    shotKey: shot.shotKey,
                    sourceKind: shot.sourceKind ?? null,
                    sourceBeatKey: shot.sourceBeatKey ?? null,
                    description: shot.description ?? null,
                    startMs: shot.startMs ?? null,
                    endMs: shot.endMs ?? null,
                }).run();
                stats.shots += 1;
            }
            for (const sound of seq.sounds ?? []) {
                if (seenSounds.has(sound.soundKey))
                    continue;
                seenSounds.add(sound.soundKey);
                tx.insert(schema.soundBeats).values({
                    planId,
                    sequenceId: seqRow.id,
                    soundKey: sound.soundKey,
                    type: sound.type ?? null,
                    startMs: sound.startMs ?? null,
                    endMs: sound.endMs ?? null,
                    sourceQuery: sound.sourceQuery ?? null,
                    volume: sound.volume ?? null,
                    tagsJson: sound.tags ? JSON.stringify(sound.tags) : null,
                }).run();
                stats.sounds += 1;
            }
        }
        // 2. 应用 panel 生产状态
        if (input.panelStates?.length) {
            for (const st of input.panelStates) {
                tx.update(schema.storyboardPanels).set({
                    genStatus: st.genStatus,
                    generationId: st.generationId ?? null,
                    taskId: st.taskId ?? null,
                    prompt: st.prompt ?? null,
                    referenceMode: st.referenceMode ?? null,
                    error: st.error ?? null,
                    ...(st.finalPath ? { finalPath: st.finalPath } : {}),
                    updatedAt: now,
                }).where(and(eq(schema.storyboardPanels.planId, planId), eq(schema.storyboardPanels.panelKey, st.panelKey))).run();
            }
        }
        return { planId, ...stats };
    });
}
/* ===== 单 panel 状态更新（producer 汇报路径） ===== */
export function findPlanId(episodeId, kind = 'full') {
    const plan = db.select({ id: schema.narrativePlans.id }).from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, kind))).get();
    return plan?.id ?? null;
}
export function applyPanelStates(planId, states) {
    const now = new Date().toISOString();
    let updated = 0;
    for (const st of states) {
        const res = db.update(schema.storyboardPanels).set({
            genStatus: st.genStatus,
            generationId: st.generationId ?? null,
            taskId: st.taskId ?? null,
            prompt: st.prompt ?? null,
            referenceMode: st.referenceMode ?? null,
            error: st.error ?? null,
            ...(st.finalPath ? { finalPath: st.finalPath } : {}),
            updatedAt: now,
        }).where(and(eq(schema.storyboardPanels.planId, planId), eq(schema.storyboardPanels.panelKey, st.panelKey))).run();
        updated += res.changes;
    }
    return { updated };
}
export function upsertSheets(planId, sheets) {
    const now = new Date().toISOString();
    let upserted = 0;
    const seqIdByKey = new Map(db.select().from(schema.narrativeSequences).where(eq(schema.narrativeSequences.planId, planId)).all()
        .map(s => [s.seqKey, s.id]));
    for (const sheet of sheets) {
        const sequenceId = sheet.sequenceKey ? (seqIdByKey.get(sheet.sequenceKey) ?? null) : null;
        const existing = db.select().from(schema.storyboardSheets)
            .where(and(eq(schema.storyboardSheets.planId, planId), eq(schema.storyboardSheets.sheetKey, sheet.sheetKey))).get();
        if (existing) {
            db.update(schema.storyboardSheets).set({
                sequenceId: sequenceId ?? existing.sequenceId,
                title: sheet.title ?? existing.title,
                imageUrl: sheet.imageUrl ?? existing.imageUrl,
            }).where(eq(schema.storyboardSheets.id, existing.id)).run();
        }
        else {
            db.insert(schema.storyboardSheets).values({
                planId, sequenceId, sheetKey: sheet.sheetKey,
                title: sheet.title ?? null, imageUrl: sheet.imageUrl ?? null,
            }).run();
        }
        upserted += 1;
    }
    return { upserted };
}
export function updatePanelStatus(opts) {
    const now = new Date().toISOString();
    const plan = db.select().from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, opts.episodeId), eq(schema.narrativePlans.kind, opts.kind ?? 'full'))).get();
    if (!plan)
        return { updated: false, reason: 'plan_not_found' };
    const res = db.update(schema.storyboardPanels).set({
        genStatus: opts.genStatus,
        generationId: opts.generationId ?? null,
        taskId: opts.taskId ?? null,
        prompt: opts.prompt ?? null,
        referenceMode: opts.referenceMode ?? null,
        error: opts.error ?? null,
        ...(opts.finalPath ? { finalPath: opts.finalPath } : {}),
        updatedAt: now,
    }).where(and(eq(schema.storyboardPanels.planId, plan.id), eq(schema.storyboardPanels.panelKey, opts.panelKey))).run();
    return { updated: res.changes > 0 };
}
/* ===== 从 storyboards 自动同步轻量 narrative hierarchy（v8 grid pipeline 兼容） ===== */
const STORYBOARD_PANEL_KEY_PREFIX = 'sb';
export function storyboardPanelKey(storyboardId) {
    return `${STORYBOARD_PANEL_KEY_PREFIX}-${storyboardId}`;
}
const PILOT_MAX_DURATION_MS = 60_000;
function buildStoryboardPlanInputs(storyboards) {
    const events = storyboards.map((sb, idx) => ({
        eventKey: storyboardPanelKey(sb.id),
        eventIndex: idx,
        text: sb.narration || sb.description || sb.title || '',
    }));
    const beats = storyboards.map((sb) => ({
        beatKey: storyboardPanelKey(sb.id),
        eventKey: storyboardPanelKey(sb.id),
        description: sb.title || sb.description || '',
    }));
    const panels = storyboards.map((sb) => ({
        panelKey: storyboardPanelKey(sb.id),
        eventKey: storyboardPanelKey(sb.id),
        beatKey: storyboardPanelKey(sb.id),
        description: sb.description || sb.title || '',
    }));
    return { events, beats, panels };
}
function buildPilotStoryboards(storyboards) {
    // Pilot = 前 60 秒以内的分镜，用于快速验证开场面和 2s/5s 留存门
    const selected = [];
    let accumulatedMs = 0;
    for (const sb of storyboards) {
        const durationMs = (sb.duration || 0) * 1000;
        if (accumulatedMs >= PILOT_MAX_DURATION_MS)
            break;
        selected.push(sb);
        accumulatedMs += durationMs;
    }
    return selected;
}
export function ensureNarrativePlanFromStoryboards(episodeId, kind = 'full', options) {
    const existingPlans = db.select().from(schema.narrativePlans)
        .where(eq(schema.narrativePlans.episodeId, episodeId)).all();
    const planByKind = new Map(existingPlans.map(p => [p.kind, p]));
    // importNarrativePlan 是「整体替换」语义：对已有 kind 调用会清空全部子级并重置
    // panel 的生产状态（finalPath/genStatus）。所以已存在的 plan 绝不动，只补缺失的。
    if (planByKind.has('full') && planByKind.has('pilot')) {
        const target = planByKind.get(kind) ?? planByKind.get('full');
        return { planId: target.id, created: false };
    }
    const storyboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(schema.storyboards.storyboardNumber).all();
    if (!storyboards.length) {
        const target = planByKind.get(kind) ?? planByKind.get('full');
        return target
            ? { planId: target.id, created: false }
            : { planId: null, created: false, reason: 'no_storyboards' };
    }
    const buildPlan = (targetKind, selectedStoryboards) => {
        const { events, beats, panels } = buildStoryboardPlanInputs(selectedStoryboards);
        return importNarrativePlan({
            episodeId,
            kind: targetKind,
            remotionProjectId: options?.remotionProjectId ?? null,
            styleProfile: options?.styleProfile ?? null,
            timingSource: options?.timingSource ?? 'storyboard_grid_fallback',
            sequences: [{
                    seqKey: 'main',
                    title: '主序列',
                    events,
                    beats,
                    panels,
                }],
        });
    };
    let created = false;
    let fullPlanId = planByKind.get('full')?.id ?? null;
    if (!fullPlanId) {
        fullPlanId = buildPlan('full', storyboards).planId;
        created = true;
    }
    if (!planByKind.has('pilot')) {
        // full 是真实计划时，pilot 必须从 full 派生（同一时间轴）；只有 full 也是
        // 兜底 shim 时才允许从 storyboards 平铺一个 shim pilot。
        let pilotDerived = false;
        try {
            pilotDerived = Boolean(derivePilotFromFullPlan(episodeId));
        }
        catch (deriveErr) {
            console.error(`[ensureNarrativePlanFromStoryboards] derive pilot from full failed for episode ${episodeId}:`, deriveErr.message);
        }
        if (!pilotDerived) {
            const pilotStoryboards = buildPilotStoryboards(storyboards);
            if (pilotStoryboards.length) {
                try {
                    buildPlan('pilot', pilotStoryboards);
                }
                catch (pilotErr) {
                    console.error(`[ensureNarrativePlanFromStoryboards] pilot plan failed for episode ${episodeId}:`, pilotErr.message);
                }
            }
        }
    }
    if (kind === 'full') {
        return { planId: fullPlanId, created };
    }
    const targetPlan = db.select().from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, kind))).get();
    return { planId: targetPlan?.id ?? fullPlanId, created };
}
/* ===== 计划状态：区分「真实叙事设计」与「分镜平铺兜底」 ===== */
export const FALLBACK_TIMING_SOURCE = 'storyboard_grid_fallback';
export function getNarrativePlanStatus(episodeId, kind = 'full') {
    const plan = db.select().from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, kind))).get();
    if (!plan) {
        return { exists: false, planId: null, timingSource: null, isPlaceholder: false, isReal: false, sequences: 0, timedEvents: 0 };
    }
    const seqs = db.select({ id: schema.narrativeSequences.id }).from(schema.narrativeSequences)
        .where(eq(schema.narrativeSequences.planId, plan.id)).all();
    const seqIds = seqs.map(s => s.id);
    const events = seqIds.length
        ? db.select({ id: schema.narrationEvents.id, startMs: schema.narrationEvents.startMs, endMs: schema.narrationEvents.endMs })
            .from(schema.narrationEvents).where(inArray(schema.narrationEvents.sequenceId, seqIds)).all()
        : [];
    const timedEvents = events.filter(e => e.startMs !== null && e.endMs !== null).length;
    const isPlaceholder = plan.timingSource === FALLBACK_TIMING_SOURCE
        || (events.length > 0 && timedEvents === 0)
        || events.length === 0;
    return {
        exists: true,
        planId: plan.id,
        timingSource: plan.timingSource ?? null,
        isPlaceholder,
        isReal: !isPlaceholder && seqs.length > 0 && timedEvents > 0,
        sequences: seqs.length,
        timedEvents,
    };
}
/* ===== 从真实 full 计划派生 pilot（前 60 秒，同一时间轴裁剪） ===== */
export function derivePilotFromFullPlan(episodeId) {
    const full = db.select().from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, 'full'))).get();
    if (!full || full.timingSource === FALLBACK_TIMING_SOURCE)
        return null;
    const clip = (v) => (v === null ? null : Math.min(v, PILOT_MAX_DURATION_MS));
    const seqs = db.select().from(schema.narrativeSequences)
        .where(eq(schema.narrativeSequences.planId, full.id))
        .orderBy(asc(schema.narrativeSequences.seqIndex)).all();
    const sequences = [];
    const panelStates = [];
    for (const seq of seqs) {
        if (seq.startMs !== null && seq.startMs >= PILOT_MAX_DURATION_MS)
            break;
        const events = db.select().from(schema.narrationEvents)
            .where(eq(schema.narrationEvents.sequenceId, seq.id))
            .orderBy(asc(schema.narrationEvents.eventIndex)).all()
            .filter(e => (e.startMs ?? 0) < PILOT_MAX_DURATION_MS);
        if (!events.length)
            continue;
        const eventIds = events.map(e => e.id);
        const eventKeyById = new Map(events.map(e => [e.id, e.eventKey]));
        const beats = db.select().from(schema.visualBeats)
            .where(inArray(schema.visualBeats.eventId, eventIds)).all();
        const beatIds = beats.map(b => b.id);
        const beatKeyById = new Map(beats.map(b => [b.id, b.beatKey]));
        const panels = beatIds.length
            ? db.select().from(schema.storyboardPanels)
                .where(and(eq(schema.storyboardPanels.planId, full.id), inArray(schema.storyboardPanels.beatId, beatIds))).all()
            : [];
        const shots = db.select().from(schema.renderShots)
            .where(and(eq(schema.renderShots.planId, full.id), inArray(schema.renderShots.eventId, eventIds))).all();
        const sounds = db.select().from(schema.soundBeats)
            .where(and(eq(schema.soundBeats.planId, full.id), eq(schema.soundBeats.sequenceId, seq.id))).all()
            .filter(s => (s.startMs ?? 0) < PILOT_MAX_DURATION_MS);
        sequences.push({
            seqKey: seq.seqKey,
            title: seq.title,
            startMs: seq.startMs,
            endMs: clip(seq.endMs),
            events: events.map(e => ({
                eventKey: e.eventKey,
                eventIndex: e.eventIndex,
                startMs: e.startMs,
                endMs: clip(e.endMs),
                text: e.text,
            })),
            beats: beats.map(b => ({
                beatKey: b.beatKey,
                eventKey: eventKeyById.get(b.eventId),
                kind: b.kind,
                startMs: b.startMs,
                endMs: clip(b.endMs),
                anchorId: b.anchorId,
                anchorVerified: b.anchorVerified,
                description: b.description,
            })),
            panels: panels.map(p => ({
                panelKey: p.panelKey,
                beatKey: p.beatId ? (beatKeyById.get(p.beatId) ?? null) : null,
                eventKey: p.eventId ? (eventKeyById.get(p.eventId) ?? null) : null,
                description: p.description,
                cropPath: p.cropPath,
            })),
            shots: shots.map(sh => ({
                shotKey: sh.shotKey,
                eventKey: sh.eventId ? (eventKeyById.get(sh.eventId) ?? null) : null,
                sourceKind: sh.sourceKind,
                sourceBeatKey: sh.sourceBeatKey,
                description: sh.description,
                startMs: sh.startMs,
                endMs: clip(sh.endMs),
            })),
            sounds: sounds.map(s => ({
                soundKey: s.soundKey,
                type: s.type,
                startMs: s.startMs,
                endMs: clip(s.endMs),
                sourceQuery: s.sourceQuery,
                volume: s.volume,
                tags: s.tagsJson ? JSON.parse(s.tagsJson) : null,
            })),
        });
        for (const p of panels) {
            panelStates.push({
                panelKey: p.panelKey,
                genStatus: p.genStatus,
                generationId: p.generationId,
                taskId: p.taskId,
                prompt: p.prompt,
                finalPath: p.finalPath,
                referenceMode: p.referenceMode,
                error: p.error,
            });
        }
    }
    if (!sequences.length)
        return null;
    const result = importNarrativePlan({
        episodeId,
        remotionProjectId: full.remotionProjectId,
        kind: 'pilot',
        styleProfile: full.styleProfile,
        durationMs: Math.min(full.durationMs ?? PILOT_MAX_DURATION_MS, PILOT_MAX_DURATION_MS),
        timingSource: full.timingSource,
        sourcePath: full.sourcePath,
        sequences,
        panelStates,
    });
    return { planId: result.planId, created: true };
}
export function updatePanelStatusFromImageGeneration(imageGenerationId) {
    const [record] = db.select().from(schema.imageGenerations)
        .where(eq(schema.imageGenerations.id, imageGenerationId)).all();
    if (!record?.storyboardId) {
        return { updated: false, reason: 'no_storyboard' };
    }
    const storyboardId = record.storyboardId;
    const [sb] = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.id, storyboardId)).all();
    if (!sb?.episodeId) {
        return { updated: false, reason: 'no_episode' };
    }
    const genStatus = record.status === 'completed'
        ? 'completed'
        : record.status === 'failed'
            ? 'failed'
            : record.status === 'canceled'
                ? 'canceled'
                : 'processing';
    return updatePanelStatus({
        episodeId: sb.episodeId,
        panelKey: storyboardPanelKey(storyboardId),
        genStatus,
        generationId: record.id,
        finalPath: genStatus === 'completed' ? record.localPath ?? null : null,
        error: record.errorMsg,
    });
}
/* ===== 原始 sound-plan 文档映射（producer 直接 POST 原始 JSON 时用） ===== */
export function mapSoundPlanDocument(doc) {
    const { plan, sheetManifest, productionState } = doc;
    const sheetsBySeq = new Map();
    for (const sheet of sheetManifest?.sheets ?? []) {
        const arr = sheetsBySeq.get(sheet.sequenceId) ?? [];
        arr.push(sheet);
        sheetsBySeq.set(sheet.sequenceId, arr);
    }
    const sequences = (plan.sequences ?? []).map((seq) => ({
        seqKey: seq.id,
        title: seq.title ?? null,
        startMs: seq.startMs ?? null,
        endMs: seq.endMs ?? null,
        events: (seq.events ?? []).map((evt) => ({
            eventKey: evt.id,
            eventIndex: evt.index ?? null,
            startMs: evt.startMs ?? null,
            endMs: evt.endMs ?? null,
            text: evt.text ?? null,
        })),
        beats: (seq.beats ?? []).map((b) => ({
            beatKey: b.id,
            eventKey: b.eventId,
            kind: b.kind ?? null,
            startMs: b.startMs ?? null,
            endMs: b.endMs ?? null,
            anchorId: b.anchor?.id ?? null,
            anchorVerified: b.anchor?.verified ?? null,
            description: b.description ?? null,
        })),
        panels: (seq.panels ?? []).map((p) => ({
            panelKey: p.id,
            beatKey: p.beatId ?? null,
            eventKey: p.eventId ?? null,
            description: p.description ?? null,
        })),
        sheets: (sheetsBySeq.get(seq.id) ?? []).map((sh) => ({
            sheetKey: sh.id,
            title: sh.sequenceTitle ?? null,
            imageUrl: typeof sh.imageUrl === 'string' ? sh.imageUrl.replace(/^\//, '') : null,
            panelKeys: sh.panelIds ?? [],
        })),
        shots: (seq.shots ?? []).map((sh) => ({
            shotKey: sh.id,
            eventKey: sh.eventId ?? null,
            sourceKind: sh.source?.kind ?? null,
            sourceBeatKey: sh.source?.beatId ?? null,
            description: sh.description ?? null,
            startMs: sh.startMs ?? null,
            endMs: sh.endMs ?? null,
        })),
        sounds: (seq.soundBeats ?? []).map((s) => ({
            soundKey: s.id,
            type: s.type ?? null,
            startMs: s.startMs ?? null,
            endMs: s.endMs ?? null,
            sourceQuery: s.sourceQuery ?? null,
            volume: s.volume ?? null,
            tags: s.tags ?? null,
        })),
    }));
    const panelStates = Object.entries(productionState?.finals ?? {}).map(([panelKey, st]) => ({
        panelKey,
        genStatus: st.status ?? 'pending',
        generationId: st.generationId ?? null,
        taskId: st.taskId ?? null,
        prompt: st.prompt ?? null,
        finalPath: typeof st.localPath === 'string' ? st.localPath.replace(/^\//, '') : null,
        referenceMode: st.referenceMode ?? null,
        error: st.error ?? null,
    }));
    return {
        styleProfile: plan.styleProfile ?? null,
        durationMs: plan.durationMs ?? null,
        timingSource: plan.timingSource ?? null,
        sequences,
        panelStates,
    };
}
/* ===== 查询：episode 的完整层级树 ===== */
export function getNarrativeHierarchyForEpisode(episodeId, kind = 'full') {
    const plan = db.select().from(schema.narrativePlans)
        .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, kind))).get();
    if (!plan)
        return { plan: null, sequences: [] };
    const seqs = db.select().from(schema.narrativeSequences)
        .where(eq(schema.narrativeSequences.planId, plan.id))
        .orderBy(asc(schema.narrativeSequences.seqIndex)).all();
    const seqIds = seqs.map(s => s.id);
    const events = seqIds.length
        ? db.select().from(schema.narrationEvents)
            .where(inArray(schema.narrationEvents.sequenceId, seqIds))
            .orderBy(asc(schema.narrationEvents.eventIndex)).all()
        : [];
    const eventIds = events.map(e => e.id);
    const beats = eventIds.length
        ? db.select().from(schema.visualBeats).where(inArray(schema.visualBeats.eventId, eventIds)).all()
        : [];
    const panels = db.select().from(schema.storyboardPanels)
        .where(eq(schema.storyboardPanels.planId, plan.id)).all();
    const sheets = db.select().from(schema.storyboardSheets)
        .where(eq(schema.storyboardSheets.planId, plan.id)).all();
    const shots = db.select().from(schema.renderShots)
        .where(eq(schema.renderShots.planId, plan.id)).all();
    const sounds = db.select().from(schema.soundBeats)
        .where(eq(schema.soundBeats.planId, plan.id)).all();
    const shotsByBeat = new Map();
    for (const sh of shots) {
        if (!sh.sourceBeatKey)
            continue;
        const arr = shotsByBeat.get(sh.sourceBeatKey) ?? [];
        arr.push(sh);
        shotsByBeat.set(sh.sourceBeatKey, arr);
    }
    const panelsByBeat = new Map();
    for (const p of panels) {
        if (!p.beatId)
            continue;
        const arr = panelsByBeat.get(p.beatId) ?? [];
        arr.push(p);
        panelsByBeat.set(p.beatId, arr);
    }
    const beatsByEvent = new Map();
    for (const b of beats) {
        const arr = beatsByEvent.get(b.eventId) ?? [];
        arr.push(b);
        beatsByEvent.set(b.eventId, arr);
    }
    const eventsBySeq = new Map();
    for (const e of events) {
        const arr = eventsBySeq.get(e.sequenceId) ?? [];
        arr.push(e);
        eventsBySeq.set(e.sequenceId, arr);
    }
    const sheetsBySeq = new Map();
    for (const s of sheets) {
        if (!s.sequenceId)
            continue;
        const arr = sheetsBySeq.get(s.sequenceId) ?? [];
        arr.push(s);
        sheetsBySeq.set(s.sequenceId, arr);
    }
    const soundsBySeq = new Map();
    for (const s of sounds) {
        if (!s.sequenceId)
            continue;
        const arr = soundsBySeq.get(s.sequenceId) ?? [];
        arr.push(s);
        soundsBySeq.set(s.sequenceId, arr);
    }
    const statusCount = {};
    for (const p of panels)
        statusCount[p.genStatus] = (statusCount[p.genStatus] ?? 0) + 1;
    const shotVideos = plan.remotionProjectId ? listProjectShotVideos(plan.remotionProjectId) : [];
    // 为每个 panel 补齐对应 storyboard 的元数据，让 UI 能把画格和原始分镜关联起来。
    const storyboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all();
    const storyboardById = new Map(storyboards.map(sb => [sb.id, sb]));
    const storyboardImageCache = new Map();
    const storyboardImageUrl = (sb) => {
        if (storyboardImageCache.has(sb.id))
            return storyboardImageCache.get(sb.id);
        let url = null;
        try {
            const gc = sb.gridCells ? JSON.parse(sb.gridCells) : null;
            const src = gc?.cells?.find((c) => typeof c?.src === 'string' && c.src)?.src;
            url = typeof src === 'string' ? src.replace(/^\//, '') : null;
        }
        catch {
            url = null;
        }
        storyboardImageCache.set(sb.id, url);
        return url;
    };
    const panelStoryboardMeta = (p) => {
        const match = /^sb-(\d+)$/.exec(p.panelKey || '');
        const sbId = match ? Number(match[1]) : null;
        const sb = sbId ? storyboardById.get(sbId) : undefined;
        return sb
            ? {
                storyboardId: sb.id,
                storyboardNumber: sb.storyboardNumber,
                storyboardTitle: sb.title,
                storyboardDuration: sb.duration,
                // 分镜生产图（gridCells 权威记录）。panel 状态与 gridCells 可能短暂不同步，
                // UI 用 p.finalPath || p.storyboardImageUrl 兜底，保证「生成一张显示一张」。
                storyboardImageUrl: storyboardImageUrl(sb),
            }
            : {
                storyboardId: null,
                storyboardNumber: null,
                storyboardTitle: null,
                storyboardDuration: null,
                storyboardImageUrl: null,
            };
    };
    return {
        plan: {
            id: plan.id,
            episodeId: plan.episodeId,
            remotionProjectId: plan.remotionProjectId,
            kind: plan.kind,
            styleProfile: plan.styleProfile,
            durationMs: plan.durationMs,
            timingSource: plan.timingSource ?? null,
            // true = 分镜平铺的兜底骨架，只用于早期 UI 预览；生图/渲染门禁会拒绝它
            isPlaceholder: plan.timingSource === FALLBACK_TIMING_SOURCE,
            panelStatus: statusCount,
        },
        shotVideos,
        sequences: seqs.map(seq => ({
            id: seq.id,
            seqKey: seq.seqKey,
            title: seq.title,
            startMs: seq.startMs,
            endMs: seq.endMs,
            sheets: (sheetsBySeq.get(seq.id) ?? []).map(sh => ({
                id: sh.id, sheetKey: sh.sheetKey, title: sh.title, imageUrl: sh.imageUrl,
            })),
            events: (eventsBySeq.get(seq.id) ?? []).map(evt => ({
                id: evt.id,
                eventKey: evt.eventKey,
                startMs: evt.startMs,
                endMs: evt.endMs,
                text: evt.text,
                beats: (beatsByEvent.get(evt.id) ?? []).map(b => ({
                    id: b.id,
                    beatKey: b.beatKey,
                    kind: b.kind,
                    startMs: b.startMs,
                    endMs: b.endMs,
                    anchorId: b.anchorId,
                    anchorVerified: b.anchorVerified,
                    description: b.description,
                    panels: (panelsByBeat.get(b.id) ?? []).map(p => ({
                        id: p.id,
                        panelKey: p.panelKey,
                        description: p.description,
                        cropPath: p.cropPath,
                        finalPath: p.finalPath,
                        genStatus: p.genStatus,
                        error: p.error,
                        ...panelStoryboardMeta(p),
                    })),
                    shots: (shotsByBeat.get(b.beatKey) ?? []).map(sh => ({
                        id: sh.id,
                        shotKey: sh.shotKey,
                        sourceKind: sh.sourceKind,
                        description: sh.description,
                        startMs: sh.startMs,
                        endMs: sh.endMs,
                    })),
                })),
            })),
            sounds: (soundsBySeq.get(seq.id) ?? []).map(s => ({
                id: s.id,
                soundKey: s.soundKey,
                type: s.type,
                startMs: s.startMs,
                endMs: s.endMs,
                sourceQuery: s.sourceQuery,
                volume: s.volume,
                tags: s.tagsJson ? JSON.parse(s.tagsJson) : [],
            })),
        })),
    };
}
