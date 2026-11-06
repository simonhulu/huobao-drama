export interface NarrativeEventInput {
    eventKey: string;
    eventIndex?: number;
    startMs?: number | null;
    endMs?: number | null;
    text?: string | null;
}
export interface NarrativeBeatInput {
    beatKey: string;
    eventKey: string;
    kind?: string | null;
    startMs?: number | null;
    endMs?: number | null;
    anchorId?: string | null;
    anchorVerified?: boolean | null;
    description?: string | null;
}
export interface NarrativePanelInput {
    panelKey: string;
    beatKey?: string | null;
    eventKey?: string | null;
    sheetKey?: string | null;
    description?: string | null;
    cropPath?: string | null;
    finalPath?: string | null;
}
export interface NarrativeSheetInput {
    sheetKey: string;
    title?: string | null;
    imageUrl?: string | null;
    panelKeys?: string[];
}
export interface NarrativeShotInput {
    shotKey: string;
    eventKey?: string | null;
    sourceKind?: string | null;
    sourceBeatKey?: string | null;
    description?: string | null;
    startMs?: number | null;
    endMs?: number | null;
}
export interface NarrativeSoundInput {
    soundKey: string;
    type?: string | null;
    startMs?: number | null;
    endMs?: number | null;
    sourceQuery?: string | null;
    volume?: number | null;
    tags?: string[] | null;
}
export interface NarrativeSequenceInput {
    seqKey: string;
    title?: string | null;
    startMs?: number | null;
    endMs?: number | null;
    events?: NarrativeEventInput[];
    beats?: NarrativeBeatInput[];
    panels?: NarrativePanelInput[];
    sheets?: NarrativeSheetInput[];
    shots?: NarrativeShotInput[];
    sounds?: NarrativeSoundInput[];
}
export interface NarrativePanelStateInput {
    panelKey: string;
    genStatus: string;
    generationId?: number | null;
    taskId?: number | null;
    prompt?: string | null;
    finalPath?: string | null;
    referenceMode?: string | null;
    error?: string | null;
}
export interface ImportNarrativePlanInput {
    episodeId: number;
    remotionProjectId?: number | null;
    kind: string;
    styleProfile?: string | null;
    durationMs?: number | null;
    timingSource?: string | null;
    sourcePath?: string | null;
    sequences: NarrativeSequenceInput[];
    panelStates?: NarrativePanelStateInput[];
}
export declare function importNarrativePlan(input: ImportNarrativePlanInput): {
    sequences: number;
    events: number;
    beats: number;
    panels: number;
    sheets: number;
    shots: number;
    sounds: number;
    planId: number;
};
export declare function findPlanId(episodeId: number, kind?: string): number | null;
export declare function applyPanelStates(planId: number, states: NarrativePanelStateInput[]): {
    updated: number;
};
export declare function upsertSheets(planId: number, sheets: Array<{
    sheetKey: string;
    sequenceKey?: string | null;
    title?: string | null;
    imageUrl?: string | null;
    panelKeys?: string[];
}>): {
    upserted: number;
};
export declare function updatePanelStatus(opts: {
    episodeId: number;
    kind?: string;
    panelKey: string;
    genStatus: string;
    generationId?: number | null;
    taskId?: number | null;
    prompt?: string | null;
    finalPath?: string | null;
    referenceMode?: string | null;
    error?: string | null;
}): {
    updated: boolean;
    reason: string;
} | {
    updated: boolean;
    reason?: undefined;
};
export declare function storyboardPanelKey(storyboardId: number): string;
export declare function ensureNarrativePlanFromStoryboards(episodeId: number, kind?: string, options?: {
    remotionProjectId?: number | null;
    styleProfile?: string | null;
    timingSource?: string | null;
}): {
    planId: number;
    created: boolean;
    reason?: undefined;
} | {
    planId: null;
    created: boolean;
    reason: "no_storyboards";
};
export declare const FALLBACK_TIMING_SOURCE = "storyboard_grid_fallback";
export interface NarrativePlanStatus {
    exists: boolean;
    planId: number | null;
    timingSource: string | null;
    /** true = 只是分镜平铺的 UI 预览骨架，不算完成叙事设计 */
    isPlaceholder: boolean;
    /** true = 有真实 Sequence 分组 + 基于 TTS 时间轴的事件时间窗 */
    isReal: boolean;
    sequences: number;
    timedEvents: number;
}
export declare function getNarrativePlanStatus(episodeId: number, kind?: string): NarrativePlanStatus;
export declare function derivePilotFromFullPlan(episodeId: number): {
    planId: number;
    created: true;
} | null;
export declare function updatePanelStatusFromImageGeneration(imageGenerationId: number): {
    updated: boolean;
    reason: string;
} | {
    updated: boolean;
    reason?: undefined;
};
export declare function mapSoundPlanDocument(doc: {
    plan: any;
    sheetManifest?: any;
    productionState?: any;
}): Pick<ImportNarrativePlanInput, 'styleProfile' | 'durationMs' | 'timingSource' | 'sequences' | 'panelStates'>;
export declare function getNarrativeHierarchyForEpisode(episodeId: number, kind?: string): {
    plan: null;
    sequences: never[];
    shotVideos?: undefined;
} | {
    plan: {
        id: number;
        episodeId: number;
        remotionProjectId: number | null;
        kind: string;
        styleProfile: string | null;
        durationMs: number | null;
        timingSource: string | null;
        isPlaceholder: boolean;
        panelStatus: Record<string, number>;
    };
    shotVideos: {
        name: string;
        url: string;
        size_mb: number;
        mtime: string;
    }[];
    sequences: {
        id: number;
        seqKey: string;
        title: string | null;
        startMs: number | null;
        endMs: number | null;
        sheets: {
            id: number;
            sheetKey: string;
            title: string | null;
            imageUrl: string | null;
        }[];
        events: {
            id: number;
            eventKey: string;
            startMs: number | null;
            endMs: number | null;
            text: string | null;
            beats: {
                id: number;
                beatKey: string;
                kind: string | null;
                startMs: number | null;
                endMs: number | null;
                anchorId: string | null;
                anchorVerified: boolean | null;
                description: string | null;
                panels: ({
                    storyboardId: number;
                    storyboardNumber: number;
                    storyboardTitle: string | null;
                    storyboardDuration: number | null;
                    storyboardImageUrl: string | null;
                    id: number;
                    panelKey: string;
                    description: string | null;
                    cropPath: string | null;
                    finalPath: string | null;
                    genStatus: string;
                    error: string | null;
                } | {
                    storyboardId: null;
                    storyboardNumber: null;
                    storyboardTitle: null;
                    storyboardDuration: null;
                    storyboardImageUrl: null;
                    id: number;
                    panelKey: string;
                    description: string | null;
                    cropPath: string | null;
                    finalPath: string | null;
                    genStatus: string;
                    error: string | null;
                })[];
                shots: {
                    id: number;
                    shotKey: string;
                    sourceKind: string | null;
                    description: string | null;
                    startMs: number | null;
                    endMs: number | null;
                }[];
            }[];
        }[];
        sounds: {
            id: number;
            soundKey: string;
            type: string | null;
            startMs: number | null;
            endMs: number | null;
            sourceQuery: string | null;
            volume: number | null;
            tags: any;
        }[];
    }[];
};
