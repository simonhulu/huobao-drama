// Generated from contracts/. Do not edit.
// Generator version: 1

export const SCHEMA_IDS = {
  "common": "editorial://schema/common/v1",
  "inputManifest": "editorial://schema/input-manifest/v1",
  "timedTranscript": "editorial://schema/timed-transcript/v1",
  "run": "editorial://schema/run/v1",
  "semanticOutline": "editorial://schema/semantic-outline/v1",
  "agentRequest": "editorial://schema/agent-request/v1",
  "agentResponse": "editorial://schema/agent-response/v1",
  "authoringResult": "editorial://schema/authoring-result/v1",
  "corpusEvidence": "editorial://schema/corpus-evidence/v1",
  "boundarySamples": "editorial://schema/boundary-samples/v1",
  "evidence": "editorial://schema/evidence/v1",
  "techniqueAnnotations": "editorial://schema/technique-annotations/v1",
  "assetInventory": "editorial://schema/asset-inventory/v1",
  "validationReport": "editorial://schema/validation-report/v1",
  "recipeLock": "editorial://schema/recipe-lock/v1",
  "recipeV1": "https://huobao.local/schemas/magnates-media-recipe-v1.json",
  "recipeV2": "editorial://schema/magnates-remotion-recipe/v2",
  "artifactEnvelope": "editorial://schema/artifact-envelope/v1",
  "adapterConfig": "editorial://schema/adapter-config/v1",
  "adapterCapabilities": "editorial://schema/adapter-capabilities/v1",
  "adapterRequest": "editorial://schema/adapter-request/v1",
  "adapterResponse": "editorial://schema/adapter-response/v1",
  "rendererEnvironmentLock": "editorial://schema/renderer-environment-lock/v1",
  "remotionProps": "editorial://schema/remotion-props/v1",
  "renderManifest": "editorial://schema/render-manifest/v1",
  "inspectReport": "editorial://schema/inspect-report/v1",
  "layoutTelemetry": "editorial://schema/layout-telemetry/v1",
  "qaReport": "editorial://schema/qa-report/v1",
  "calibrationPolicy": "editorial://schema/calibration-policy/v1",
  "errorCodes": "editorial://schema/error-codes/v1"
} as const;
export type SchemaName = keyof typeof SCHEMA_IDS;
export type SchemaId = (typeof SCHEMA_IDS)[SchemaName];

export const SCHEMA_SHA256 = {
  "editorial://schema/adapter-capabilities/v1": "c609f2777421769b1d8071a4b0b6b0ca303cf4a1cc12ab9c488d8c47a6c12098",
  "editorial://schema/adapter-config/v1": "70ad647da377cbdeb5771ef992d38652025c4e3c2156575abe603f0b12808bc7",
  "editorial://schema/adapter-request/v1": "83802847ed914e296ae5d69b265fb41b0f2c2d4f8d123d461d5aca95aee0689a",
  "editorial://schema/adapter-response/v1": "0b99f542ea9581b8b67166bffd2f4c87ee139d5e42a66d673a7c0b55cfdf1736",
  "editorial://schema/agent-request/v1": "3d3d0f09c6db9e63e9fa14f9c7662149449d09e27accb8bef7263cf0d6242b73",
  "editorial://schema/agent-response/v1": "7ca58536ab0ed2f2de60036e87e8928021c62618dc0b9e0c344561083f514fa2",
  "editorial://schema/artifact-envelope/v1": "afc0cbc79da480623e9236c76fbd1d9821b3585153f5a5be92d4548cefb4a918",
  "editorial://schema/asset-inventory/v1": "8c1e3a1964d708ffef7a199c1246e2fe65746c4e02586745cd7156355ac1569d",
  "editorial://schema/authoring-result/v1": "d98ecb9025c7125b02c64438b2e34364128385c627a384277e7cefa6a306ef0f",
  "editorial://schema/boundary-samples/v1": "c622b4fea04629a9deae7722d3cbdc1c8b3ed496ce0908fb000a5deeee06b5d5",
  "editorial://schema/calibration-policy/v1": "c2ff6fbb547d10e7a7c7ae1340538b26bfba9b208efe6d42ee4be0719ec07eea",
  "editorial://schema/common/v1": "49aac104939e69ef61f637169ff4aeeefbc62202037a98b207aab268aef9cc44",
  "editorial://schema/corpus-evidence/v1": "4889fcf324f94b8148ec15194faec8a7e6623d38e17b9e9cc5d5b22a02b0332a",
  "editorial://schema/error-codes/v1": "fa32e55c9e50287957a2bbeaf47761363ecd0a8edd64fa3acd45b5d50103cb28",
  "editorial://schema/evidence/v1": "579934ec144cad0505ee84110128a7b4d72ea318776f9f7eb541b9cef767f6fb",
  "editorial://schema/input-manifest/v1": "a0f0f2dec8aeadf875a2cc69800f3308f5bda6c24ace6b1f5b55bea31107743b",
  "editorial://schema/inspect-report/v1": "cab07cf7b86b744736140e3b783b392ce9170a17e2b7b9207e054d3291f0f737",
  "editorial://schema/layout-telemetry/v1": "6022dc1975668666ddc50ac7c150274c5a80d38aceb2ade54d03f82aa0c31ea4",
  "editorial://schema/magnates-remotion-recipe/v2": "9166d9cdc384332222dae6b82538c61d6cddd7656a44cb2a168b482dbf3f59ca",
  "editorial://schema/qa-report/v1": "bb2f951ed8a10cb519e956fd01815bca8c4ea542fa2368dc7096e9297b4eae67",
  "editorial://schema/recipe-lock/v1": "0ab39173bf15ad633e946e7b8890759924ea8345281274a9b48b8f9695b38a8d",
  "editorial://schema/remotion-props/v1": "31323a537d4ab0ae274577c766f204703631810bdbc181567027600a51f5f602",
  "editorial://schema/render-manifest/v1": "9ebce8293ead1fa8712454ee21967fff9a7a4941614668926af9dceb454e941f",
  "editorial://schema/renderer-environment-lock/v1": "6f1216a8b4475629c6a784a59aa5bf7cfaa2cd835c4e9170ea6a3881ac9b770c",
  "editorial://schema/run/v1": "a35919d4277daa728ec57123b27190b8fd22643b971e4e424a614afa2bb8f20f",
  "editorial://schema/semantic-outline/v1": "0c934f27c3cbe3dce43fc277cf7e51a5b3788b1a73d3d39ef4e086b9a79b038d",
  "editorial://schema/technique-annotations/v1": "450163b24ba22867e84899df2088630e7bdd1efd599844505db8306c11f4e041",
  "editorial://schema/timed-transcript/v1": "5517679c2fadcc8654265a7fd1ac660105b2a0b5d008795bb38e95aa2ef43ab6",
  "editorial://schema/validation-report/v1": "77fdeae52a7328849ecf8b217d26eb14f4670d2efdeec764a703f84e33386916",
  "https://huobao.local/schemas/magnates-media-recipe-v1.json": "5536da349e4ace73c5f128811896b422081f7c899f775b54e0bfa48057b67786"
} as const;

export const RECIPE_SCHEMA_VERSION = "magnates-remotion-recipe-v2" as const;
export const LEGACY_RECIPE_SCHEMA_VERSION = "magnates-remotion-recipe-v1" as const;

export const ADAPTER_PROTOCOL_VERSION = 1 as const;
export const ADAPTER_OPERATIONS = [
  "capabilities",
  "build-props",
  "render",
  "inspect"
] as const;
export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];

export const ARTIFACT_TYPES = [
  "input-manifest",
  "timed-transcript",
  "run",
  "semantic-outline",
  "agent-request",
  "agent-response",
  "authoring-result",
  "corpus-evidence",
  "boundary-samples",
  "evidence",
  "technique-annotations",
  "asset-inventory",
  "validation-report",
  "recipe-lock",
  "recipe-v2",
  "adapter-config",
  "adapter-capabilities",
  "adapter-request",
  "adapter-response",
  "renderer-environment-lock",
  "remotion-props",
  "render-manifest",
  "inspect-report",
  "layout-telemetry",
  "qa-report",
  "calibration-policy",
  "error-codes"
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const TARGET_PROFILES = [
  {
    "profileId": "youtube-720p",
    "width": 1280,
    "height": 720,
    "fps": 30
  },
  {
    "profileId": "youtube-1080p",
    "width": 1920,
    "height": 1080,
    "fps": 30
  }
] as const;
export type TargetProfile = (typeof TARGET_PROFILES)[number];
export type TargetProfileId = TargetProfile["profileId"];

export const TRANSITION_CLASSES = [
  "hard_cut",
  "dissolve",
  "blur_bridge",
  "matte_transition",
  "graphic_transition",
  "distortion",
  "ambiguous",
  "no_local_delta",
  "within_setup_change"
] as const;
export type TransitionClass = (typeof TRANSITION_CLASSES)[number];
export const CAMERA_PRESETS = [
  "hold",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "whip"
] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];
export const TEXT_CUE_TYPES = [
  "text",
  "counter"
] as const;
export type TextCueType = (typeof TEXT_CUE_TYPES)[number];
export const GRAPHIC_KINDS = [
  "underline",
  "bar",
  "globe",
  "grid",
  "monitor",
  "divider",
  "badge"
] as const;
export type GraphicKind = (typeof GRAPHIC_KINDS)[number];

export const ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "SCHEMA_VALIDATION_FAILED",
  "PROTOCOL_VERSION_MISMATCH",
  "ENVIRONMENT_LOCK_MISMATCH",
  "TARGET_UNSUPPORTED",
  "ASSET_FAILURE",
  "ASSET_HASH_MISMATCH",
  "ADAPTER_OPERATION_FAILED",
  "ADAPTER_TIMEOUT",
  "ADAPTER_INSPECTION_FAILED",
  "MALFORMED_OUTPUT",
  "PROTOCOL_VIOLATION",
  "CANCELLED"
] as const;
export type EditorialErrorCode = (typeof ERROR_CODES)[number];
export const ERROR_CATEGORIES = [
  "internal",
  "invalid_input",
  "protocol_mismatch",
  "asset_failure",
  "adapter_failure",
  "inspection_failure",
  "protocol_failure",
  "cancelled"
] as const;
export type EditorialErrorCategory = (typeof ERROR_CATEGORIES)[number];
export const ERROR_REGISTRY = [
  {
    "code": "INTERNAL_ERROR",
    "category": "internal",
    "exitCode": 1,
    "allowedStages": [
      "ANY"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "redacted"
  },
  {
    "code": "INVALID_INPUT",
    "category": "invalid_input",
    "exitCode": 2,
    "allowedStages": [
      "ANY"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "SCHEMA_VALIDATION_FAILED",
    "category": "invalid_input",
    "exitCode": 2,
    "allowedStages": [
      "ANY"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "PROTOCOL_VERSION_MISMATCH",
    "category": "protocol_mismatch",
    "exitCode": 3,
    "allowedStages": [
      "ADAPTER_READY",
      "PROPS_BUILT",
      "RENDERED",
      "INSPECTED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "ENVIRONMENT_LOCK_MISMATCH",
    "category": "protocol_mismatch",
    "exitCode": 3,
    "allowedStages": [
      "ADAPTER_READY",
      "RENDERED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "TARGET_UNSUPPORTED",
    "category": "protocol_mismatch",
    "exitCode": 3,
    "allowedStages": [
      "ADAPTER_READY"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "ASSET_FAILURE",
    "category": "asset_failure",
    "exitCode": 4,
    "allowedStages": [
      "INTAKE_LOCKED",
      "RECIPE_VALIDATED",
      "PROPS_BUILT",
      "RENDERED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "ASSET_HASH_MISMATCH",
    "category": "asset_failure",
    "exitCode": 4,
    "allowedStages": [
      "INTAKE_LOCKED",
      "PROPS_BUILT",
      "RENDERED",
      "INSPECTED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "ADAPTER_OPERATION_FAILED",
    "category": "adapter_failure",
    "exitCode": 5,
    "allowedStages": [
      "PROPS_BUILT",
      "RENDERED"
    ],
    "defaultRetryable": true,
    "detailsPolicy": "redacted"
  },
  {
    "code": "ADAPTER_TIMEOUT",
    "category": "adapter_failure",
    "exitCode": 5,
    "allowedStages": [
      "ADAPTER_READY",
      "PROPS_BUILT",
      "RENDERED",
      "INSPECTED"
    ],
    "defaultRetryable": true,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "ADAPTER_INSPECTION_FAILED",
    "category": "inspection_failure",
    "exitCode": 6,
    "allowedStages": [
      "INSPECTED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  },
  {
    "code": "MALFORMED_OUTPUT",
    "category": "protocol_failure",
    "exitCode": 7,
    "allowedStages": [
      "ADAPTER_READY",
      "PROPS_BUILT",
      "RENDERED",
      "INSPECTED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "redacted"
  },
  {
    "code": "PROTOCOL_VIOLATION",
    "category": "protocol_failure",
    "exitCode": 7,
    "allowedStages": [
      "ADAPTER_READY",
      "PROPS_BUILT",
      "RENDERED",
      "INSPECTED"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "redacted"
  },
  {
    "code": "CANCELLED",
    "category": "cancelled",
    "exitCode": 130,
    "allowedStages": [
      "ANY"
    ],
    "defaultRetryable": false,
    "detailsPolicy": "user_safe"
  }
] as const;
export const EXIT_CODE_BY_CATEGORY = {
  "internal": 1,
  "invalid_input": 2,
  "protocol_mismatch": 3,
  "asset_failure": 4,
  "adapter_failure": 5,
  "inspection_failure": 6,
  "protocol_failure": 7,
  "cancelled": 130
} as const;

export const RFC8785_VECTOR_SET_SHA256 = "f24341eae4653ab5b6bb80bf07be708025b7a4f6b6bea285abebe086ca387f7b" as const;

export interface ArtifactProducer {
  readonly name: string;
  readonly version: string;
}

export interface ArtifactEnvelope<TPayload, TType extends ArtifactType = ArtifactType> {
  readonly schemaVersion: typeof SCHEMA_IDS.artifactEnvelope;
  readonly runId: string;
  readonly artifactType: TType;
  readonly createdAt: string;
  readonly producer: ArtifactProducer;
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly payload: TPayload;
  readonly contentHash: string;
}

export interface RecipeAssetV2 {
  readonly assetId: string;
  readonly fit?: "cover" | "contain";
  readonly position?: "center" | "top" | "bottom" | "left" | "right" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
  readonly filter?: "none" | "monochrome" | "warm" | "cool" | "high_contrast" | "soft_blur";
}

export interface RecipeTransitionV2 {
  readonly class: TransitionClass;
  readonly frames?: number;
  readonly accent?: string;
}

export interface RecipeFocusV2 {
  readonly x: number;
  readonly y: number;
}

export interface RecipeCameraV2 {
  readonly preset: CameraPreset;
  readonly intensity?: number;
  readonly focus?: RecipeFocusV2;
  readonly startScale?: number;
  readonly endScale?: number;
}

export interface RecipeTextCueV2 {
  readonly id: string;
  readonly type: TextCueType;
  readonly subject: string;
  readonly subjectId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly text?: string;
  readonly entry?: "none" | "fade" | "slide_up" | "slide_left" | "wipe" | "type_on" | "counter";
  readonly exit?: "none" | "fade" | "slide_down";
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly align?: "left" | "center" | "right";
  readonly fontSize?: number;
  readonly weight?: number;
  readonly color?: string;
  readonly accent?: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly metricId?: string;
  readonly unit?: string;
  readonly period?: string;
  readonly from?: number;
  readonly to?: number;
  readonly decimals?: number;
  readonly label?: string;
}

export interface RecipeGraphicCueV2 {
  readonly id: string;
  readonly kind: GraphicKind;
  readonly subject: string;
  readonly subjectId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
  readonly secondaryColor?: string;
  readonly label?: string;
}

export interface RecipeShotV2 {
  readonly id: string;
  readonly durationInFrames: number;
  readonly background: RecipeAssetV2;
  readonly semanticRole: "hook" | "establishing" | "mechanism" | "comparison" | "reversal" | "crisis" | "resolution";
  readonly camera?: RecipeCameraV2;
  readonly transitionIn?: RecipeTransitionV2;
  readonly transitionOut?: RecipeTransitionV2;
  readonly texts?: readonly RecipeTextCueV2[];
  readonly graphics?: readonly RecipeGraphicCueV2[];
  readonly tint?: string;
  readonly grain?: number;
  readonly sourceLabel?: string;
}

export interface MagnatesRemotionRecipeV2 {
  readonly schemaVersion: typeof RECIPE_SCHEMA_VERSION;
  readonly durationInFrames: number;
  readonly fps: number;
  readonly title?: string;
  readonly shots: readonly RecipeShotV2[];
}

export interface EditorialErrorShape {
  readonly code: EditorialErrorCode;
  readonly category: EditorialErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly stage: string;
  readonly details?: Readonly<Record<string, string>>;
}
