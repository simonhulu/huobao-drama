/**
 * Pure data-contract validation for the Narrative Storyboard pilot.
 *
 * The module has no repository, filesystem, network, or renderer dependency.
 * It only validates the authored Project -> Sequence -> NarrationEvent ->
 * VisualBeat -> StoryboardPanel -> RenderShot graph and returns a normalized
 * clone.
 */

export const NARRATIVE_STORYBOARD_SCHEMA_VERSION = "narrative-storyboard-pilot-v1";

const PROJECT_KEYS = new Set(["schemaVersion", "id", "durationMs", "audioTracks", "sequences"]);
const SEQUENCE_KEYS = new Set(["id", "title", "startMs", "endMs", "events", "beats", "panels", "shots"]);
const AUDIO_TRACK_KEYS = new Set(["id", "role", "master"]);
const EVENT_KEYS = new Set(["id", "index", "startMs", "endMs", "text"]);
const BEAT_KEYS = new Set(["id", "eventId", "kind", "startMs", "endMs", "anchor", "anchorText", "waypointGroupId", "description"]);
const ANCHOR_KEYS = new Set(["id", "verified"]);
const PANEL_KEYS = new Set(["id", "beatId", "eventId", "description"]);
const SHOT_KEYS = new Set(["id", "eventId", "source", "description"]);
const SHOT_SOURCE_KEYS = new Set(["kind", "beatId", "eventId", "waypointGroupId"]);

export class NarrativeStoryboardContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NarrativeStoryboardContractError";
    this.code = "INVALID_NARRATIVE_STORYBOARD_CONTRACT";
    this.category = "invalid-input";
    this.details = details;
  }
}

function fail(message, pointer = "$") {
  throw new NarrativeStoryboardContractError(`${pointer}: ${message}`, { pointer });
}

function record(value, pointer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object", pointer);
  return value;
}

function keys(value, allowed, pointer) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown property ${key}`, `${pointer}.${key}`);
  }
}

function array(value, pointer, { min = 0 } = {}) {
  if (!Array.isArray(value)) fail("must be an array", pointer);
  if (value.length < min) fail(`must contain at least ${min} item(s)`, pointer);
  return value;
}

function string(value, pointer) {
  if (typeof value !== "string" || !value.trim()) fail("must be a non-empty string", pointer);
  return value;
}

function optionalString(value, pointer) {
  if (value === undefined) return undefined;
  return string(value, pointer);
}

function id(value, pointer) {
  const result = string(value, pointer);
  if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail("must be a stable id", pointer);
  return result;
}

function integer(value, pointer, { minimum = undefined } = {}) {
  if (!Number.isInteger(value)) fail("must be an integer", pointer);
  if (minimum !== undefined && value < minimum) fail(`must be >= ${minimum}`, pointer);
  return value;
}

function boolean(value, pointer) {
  if (typeof value !== "boolean") fail("must be a boolean", pointer);
  return value;
}

function expectUnique(value, seen, pointer) {
  if (seen.has(value)) fail(`duplicate id ${value}`, pointer);
  seen.add(value);
}

function validateAudioTracks(rawTracks, pointer = "$.audioTracks") {
  const tracks = array(rawTracks, pointer, { min: 1 }).map((raw, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const track = record(raw, itemPointer);
    keys(track, AUDIO_TRACK_KEYS, itemPointer);
    return {
      id: id(track.id, `${itemPointer}.id`),
      role: optionalString(track.role, `${itemPointer}.role`),
      master: boolean(track.master, `${itemPointer}.master`),
    };
  });
  const masters = tracks.filter((track) => track.master);
  if (masters.length !== 1) fail("must mark exactly one master audio track", pointer);
  return tracks;
}

function validateEvents(rawEvents, sequenceStartMs, sequenceEndMs, pointer) {
  const seen = new Set();
  let expectedStart = sequenceStartMs;
  const events = array(rawEvents, pointer, { min: 1 }).map((raw, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const event = record(raw, itemPointer);
    keys(event, EVENT_KEYS, itemPointer);
    const eventId = id(event.id, `${itemPointer}.id`);
    expectUnique(eventId, seen, `${itemPointer}.id`);
    const startMs = integer(event.startMs, `${itemPointer}.startMs`, { minimum: sequenceStartMs });
    const endMs = integer(event.endMs, `${itemPointer}.endMs`, { minimum: sequenceStartMs + 1 });
    if (startMs !== expectedStart) fail(`must start at ${expectedStart} for continuous sequence event time`, `${itemPointer}.startMs`);
    if (endMs <= startMs) fail("must be greater than startMs", `${itemPointer}.endMs`);
    if (endMs > sequenceEndMs) fail(`must be <= sequence endMs ${sequenceEndMs}`, `${itemPointer}.endMs`);
    expectedStart = endMs;
    return {
      id: eventId,
      index: event.index === undefined ? index : integer(event.index, `${itemPointer}.index`, { minimum: 0 }),
      startMs,
      endMs,
      text: optionalString(event.text, `${itemPointer}.text`),
    };
  });
  if (expectedStart !== sequenceEndMs) fail(`must end at sequence endMs ${sequenceEndMs}`, pointer);
  return events;
}

function validateCutBeat(beat, pointer, event) {
  if (beat.anchorText !== undefined) fail("cut must not own waypoint anchor text", `${pointer}.anchorText`);
  const startMs = integer(beat.startMs, `${pointer}.startMs`, { minimum: event.startMs });
  const endMs = integer(beat.endMs, `${pointer}.endMs`, { minimum: event.startMs + 1 });
  if (startMs < event.startMs || endMs > event.endMs || startMs >= endMs) fail(`cut time must stay within event ${event.id}`, pointer);
  const anchor = record(beat.anchor, `${pointer}.anchor`);
  keys(anchor, ANCHOR_KEYS, `${pointer}.anchor`);
  if (boolean(anchor.verified, `${pointer}.anchor.verified`) !== true) fail("cut must have a verified anchor", `${pointer}.anchor.verified`);
  return {
    startMs,
    endMs,
    anchor: { id: id(anchor.id, `${pointer}.anchor.id`), verified: true },
  };
}

function validateWaypointBeat(beat, pointer) {
  for (const timeKey of ["startMs", "endMs"]) {
    if (beat[timeKey] !== undefined) fail("waypoint must not own independent time", `${pointer}.${timeKey}`);
  }
  if (beat.anchor !== undefined) fail("waypoint must not own a cut anchor", `${pointer}.anchor`);
  return {
    waypointGroupId: id(beat.waypointGroupId, `${pointer}.waypointGroupId`),
    anchorText: optionalString(beat.anchorText, `${pointer}.anchorText`),
  };
}

function validateBeats(rawBeats, eventsById, pointer) {
  const seen = new Set();
  const cutBeatIds = new Set();
  const waypointGroups = new Map();
  const beatsById = new Map();
  const beats = array(rawBeats, pointer, { min: 1 }).map((raw, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const beat = record(raw, itemPointer);
    keys(beat, BEAT_KEYS, itemPointer);
    const beatId = id(beat.id, `${itemPointer}.id`);
    expectUnique(beatId, seen, `${itemPointer}.id`);
    const eventId = id(beat.eventId, `${itemPointer}.eventId`);
    const event = eventsById.get(eventId);
    if (!event) fail(`unknown eventId ${eventId}`, `${itemPointer}.eventId`);
    const kind = string(beat.kind, `${itemPointer}.kind`);
    if (kind !== "cut" && kind !== "waypoint") fail("must be cut or waypoint", `${itemPointer}.kind`);
    const normalized = {
      id: beatId,
      eventId,
      kind,
      description: optionalString(beat.description, `${itemPointer}.description`),
    };
    if (kind === "cut") {
      Object.assign(normalized, validateCutBeat(beat, itemPointer, event));
      cutBeatIds.add(beatId);
    } else {
      Object.assign(normalized, validateWaypointBeat(beat, itemPointer));
      const groupKey = `${eventId}:${normalized.waypointGroupId}`;
      if (!waypointGroups.has(groupKey)) waypointGroups.set(groupKey, { eventId, waypointGroupId: normalized.waypointGroupId, beatIds: [] });
      waypointGroups.get(groupKey).beatIds.push(beatId);
    }
    beatsById.set(beatId, normalized);
    return normalized;
  });
  return { beats, beatsById, cutBeatIds, waypointGroups };
}

function validatePanels(rawPanels, beatsById, pointer) {
  const seenPanelIds = new Set();
  const seenBeatIds = new Set();
  const panels = array(rawPanels, pointer, { min: 1 }).map((raw, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const panel = record(raw, itemPointer);
    keys(panel, PANEL_KEYS, itemPointer);
    const panelId = id(panel.id, `${itemPointer}.id`);
    expectUnique(panelId, seenPanelIds, `${itemPointer}.id`);
    const beatId = id(panel.beatId, `${itemPointer}.beatId`);
    const beat = beatsById.get(beatId);
    if (!beat) fail(`unknown beatId ${beatId}`, `${itemPointer}.beatId`);
    expectUnique(beatId, seenBeatIds, `${itemPointer}.beatId`);
    const eventId = panel.eventId === undefined ? beat.eventId : id(panel.eventId, `${itemPointer}.eventId`);
    if (eventId !== beat.eventId) fail("panel eventId must match its beat eventId", `${itemPointer}.eventId`);
    return {
      id: panelId,
      beatId,
      eventId,
      description: optionalString(panel.description, `${itemPointer}.description`),
    };
  });
  for (const beatId of beatsById.keys()) {
    if (!seenBeatIds.has(beatId)) fail(`missing panel for beat ${beatId}`, pointer);
  }
  return panels;
}

function validateShotSource(source, pointer, shotEventId, cutBeatIds, waypointGroups) {
  const raw = record(source, pointer);
  keys(raw, SHOT_SOURCE_KEYS, pointer);
  const kind = string(raw.kind, `${pointer}.kind`);
  if (kind === "cut") {
    const beatId = id(raw.beatId, `${pointer}.beatId`);
    if (!cutBeatIds.has(beatId)) fail("shot cut source must reference a cut beat in the same sequence", `${pointer}.beatId`);
    if (raw.eventId !== undefined) {
      const eventId = id(raw.eventId, `${pointer}.eventId`);
      if (eventId !== shotEventId) fail("shot source eventId must match shot eventId", `${pointer}.eventId`);
    }
    if (raw.waypointGroupId !== undefined) fail("cut source must not include waypointGroupId", `${pointer}.waypointGroupId`);
    return { kind, beatId };
  }
  if (kind === "waypointGroup") {
    const eventId = id(raw.eventId, `${pointer}.eventId`);
    if (eventId !== shotEventId) fail("waypoint group shot must stay inside the same event", `${pointer}.eventId`);
    const waypointGroupId = id(raw.waypointGroupId, `${pointer}.waypointGroupId`);
    const groupKey = `${eventId}:${waypointGroupId}`;
    if (!waypointGroups.has(groupKey)) fail("shot waypoint source must reference an existing same-sequence same-event waypoint group", pointer);
    if (raw.beatId !== undefined) fail("waypoint group source must not include beatId", `${pointer}.beatId`);
    return { kind, eventId, waypointGroupId };
  }
  fail("must be cut or waypointGroup", `${pointer}.kind`);
}

function validateShots(rawShots, eventsById, cutBeatIds, waypointGroups, pointer) {
  const seen = new Set();
  return array(rawShots, pointer, { min: 1 }).map((raw, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const shot = record(raw, itemPointer);
    keys(shot, SHOT_KEYS, itemPointer);
    const shotId = id(shot.id, `${itemPointer}.id`);
    expectUnique(shotId, seen, `${itemPointer}.id`);
    const eventId = id(shot.eventId, `${itemPointer}.eventId`);
    if (!eventsById.has(eventId)) fail(`unknown eventId ${eventId}`, `${itemPointer}.eventId`);
    return {
      id: shotId,
      eventId,
      source: validateShotSource(shot.source, `${itemPointer}.source`, eventId, cutBeatIds, waypointGroups),
      description: optionalString(shot.description, `${itemPointer}.description`),
    };
  });
}

function validateSequence(rawSequence, expectedStartMs, pointer) {
  const sequence = record(rawSequence, pointer);
  keys(sequence, SEQUENCE_KEYS, pointer);
  const startMs = integer(sequence.startMs, `${pointer}.startMs`, { minimum: 0 });
  const endMs = integer(sequence.endMs, `${pointer}.endMs`, { minimum: 1 });
  if (startMs !== expectedStartMs) fail(`must start at ${expectedStartMs} for continuous global sequence time`, `${pointer}.startMs`);
  if (endMs <= startMs) fail("must be greater than startMs", `${pointer}.endMs`);
  const events = validateEvents(sequence.events, startMs, endMs, `${pointer}.events`);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const { beats, beatsById, cutBeatIds, waypointGroups } = validateBeats(sequence.beats, eventsById, `${pointer}.beats`);
  return {
    id: id(sequence.id, `${pointer}.id`),
    title: optionalString(sequence.title, `${pointer}.title`),
    startMs,
    endMs,
    events,
    beats,
    panels: validatePanels(sequence.panels, beatsById, `${pointer}.panels`),
    shots: validateShots(sequence.shots, eventsById, cutBeatIds, waypointGroups, `${pointer}.shots`),
  };
}

export function validateNarrativeStoryboardContract(rawProject) {
  const project = record(rawProject, "$");
  keys(project, PROJECT_KEYS, "$");
  if (project.schemaVersion !== NARRATIVE_STORYBOARD_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${NARRATIVE_STORYBOARD_SCHEMA_VERSION}`, "$.schemaVersion");
  }
  const durationMs = integer(project.durationMs, "$.durationMs", { minimum: 1 });
  let expectedStartMs = 0;
  const seenSequenceIds = new Set();
  const sequences = array(project.sequences, "$.sequences", { min: 1 }).map((rawSequence, index) => {
    const sequence = validateSequence(rawSequence, expectedStartMs, `$.sequences[${index}]`);
    expectUnique(sequence.id, seenSequenceIds, `$.sequences[${index}].id`);
    expectedStartMs = sequence.endMs;
    return sequence;
  });
  if (expectedStartMs !== durationMs) fail(`must equal final sequence endMs ${expectedStartMs}`, "$.durationMs");
  return {
    schemaVersion: NARRATIVE_STORYBOARD_SCHEMA_VERSION,
    id: id(project.id, "$.id"),
    durationMs,
    audioTracks: validateAudioTracks(project.audioTracks),
    sequences,
  };
}
