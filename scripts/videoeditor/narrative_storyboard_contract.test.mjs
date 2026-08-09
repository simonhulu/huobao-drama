import assert from "node:assert/strict";
import test from "node:test";
import {
  NARRATIVE_STORYBOARD_SCHEMA_VERSION,
  NarrativeStoryboardContractError,
  validateNarrativeStoryboardContract,
} from "./narrative_storyboard_contract.mjs";

function sequenceFixture({ suffix, startMs, middleMs, endMs }) {
  return {
    id: `seq-${suffix}`,
    title: `Sequence ${suffix}`,
    startMs,
    endMs,
    events: [
      { id: `event-${suffix}-001`, index: 0, startMs, endMs: middleMs, text: "First event." },
      { id: `event-${suffix}-002`, index: 1, startMs: middleMs, endMs, text: "Second event." },
    ],
    beats: [
      {
        id: `beat-${suffix}-cut-001`,
        eventId: `event-${suffix}-001`,
        kind: "cut",
        startMs,
        endMs: middleMs,
        anchor: { id: `anchor-${suffix}-001`, verified: true },
        description: "Verified cut.",
      },
      {
        id: `beat-${suffix}-waypoint-001`,
        eventId: `event-${suffix}-002`,
        kind: "waypoint",
        waypointGroupId: `wp-${suffix}-001`,
        anchorText: "Second event",
        description: "Waypoint group member.",
      },
    ],
    panels: [
      { id: `panel-${suffix}-001`, beatId: `beat-${suffix}-cut-001`, eventId: `event-${suffix}-001` },
      { id: `panel-${suffix}-002`, beatId: `beat-${suffix}-waypoint-001`, eventId: `event-${suffix}-002` },
    ],
    shots: [
      { id: `shot-${suffix}-cut-001`, eventId: `event-${suffix}-001`, source: { kind: "cut", beatId: `beat-${suffix}-cut-001` } },
      {
        id: `shot-${suffix}-waypoint-001`,
        eventId: `event-${suffix}-002`,
        source: { kind: "waypointGroup", eventId: `event-${suffix}-002`, waypointGroupId: `wp-${suffix}-001` },
      },
    ],
  };
}

function project(overrides = {}) {
  return {
    schemaVersion: NARRATIVE_STORYBOARD_SCHEMA_VERSION,
    id: "pilot-project-001",
    durationMs: 6000,
    audioTracks: [
      { id: "narration-master", role: "narration", master: true },
      { id: "music-bed", role: "music", master: false },
    ],
    sequences: [
      sequenceFixture({ suffix: "001", startMs: 0, middleMs: 1000, endMs: 2000 }),
      sequenceFixture({ suffix: "002", startMs: 2000, middleMs: 3000, endMs: 4000 }),
      sequenceFixture({ suffix: "003", startMs: 4000, middleMs: 5000, endMs: 6000 }),
    ],
    ...overrides,
  };
}

function assertContractError(candidate, expected, label) {
  assert.throws(() => validateNarrativeStoryboardContract(candidate), (error) => {
    assert.ok(error instanceof NarrativeStoryboardContractError, label);
    assert.match(error.message, expected, label);
    return true;
  });
}

test("validates a pilot project with three globally continuous narrative sequences", () => {
  const input = project();
  const before = structuredClone(input);
  const result = validateNarrativeStoryboardContract(input);

  assert.deepEqual(input, before);
  assert.equal(result.schemaVersion, NARRATIVE_STORYBOARD_SCHEMA_VERSION);
  assert.equal(result.audioTracks.filter((track) => track.master).length, 1);
  assert.deepEqual(result.sequences.map((sequence) => [sequence.startMs, sequence.endMs]), [
    [0, 2000],
    [2000, 4000],
    [4000, 6000],
  ]);
  assert.equal(result.sequences[1].events[0].startMs, 2000);
  assert.equal(result.sequences[2].events.at(-1).endMs, result.durationMs);
  assert.equal(result.sequences[0].beats.find((beat) => beat.kind === "waypoint").startMs, undefined);
  assert.equal(result.sequences[0].beats.find((beat) => beat.kind === "waypoint").anchorText, "Second event");
});

test("rejects non-continuous global sequence time", () => {
  const candidate = project();
  candidate.sequences[1] = { ...candidate.sequences[1], startMs: 2100 };
  assertContractError(candidate, /continuous global sequence time/, "sequence gap");
});

test("rejects duration drift from the final sequence boundary", () => {
  assertContractError(project({ durationMs: 6100 }), /final sequence endMs 6000/, "duration drift");
});

test("rejects sequence-local event gaps despite global absolute event times", () => {
  const candidate = project();
  candidate.sequences[1].events[0] = { ...candidate.sequences[1].events[0], startMs: 2100 };
  assertContractError(candidate, /continuous sequence event time/, "event gap");
});

test("rejects events that do not fill their sequence", () => {
  const candidate = project();
  candidate.sequences[1].events[1] = { ...candidate.sequences[1].events[1], endMs: 3900 };
  assertContractError(candidate, /sequence endMs 4000/, "event end drift");
});

test("rejects waypoint beats with independent time", () => {
  const candidate = project();
  candidate.sequences[0].beats[1] = { ...candidate.sequences[0].beats[1], startMs: 1500 };
  assertContractError(candidate, /waypoint must not own independent time/, "waypoint time");
});

test("rejects waypoint anchor text on cut beats", () => {
  const candidate = project();
  candidate.sequences[0].beats[0] = { ...candidate.sequences[0].beats[0], anchorText: "First event" };
  assertContractError(candidate, /cut must not own waypoint anchor text/, "cut waypoint anchor text");
});

test("rejects cut beats without a verified anchor", () => {
  const candidate = project();
  candidate.sequences[0].beats[0] = { ...candidate.sequences[0].beats[0], anchor: { id: "anchor-unverified", verified: false } };
  assertContractError(candidate, /verified anchor/, "cut anchor");
});

test("rejects panels that are not one-to-one with sequence-local visual beats", () => {
  const missing = project();
  missing.sequences[0] = { ...missing.sequences[0], panels: missing.sequences[0].panels.slice(0, 1) };
  assertContractError(missing, /missing panel for beat beat-001-waypoint-001/, "missing panel");

  const duplicate = project();
  duplicate.sequences[0].panels[1] = { ...duplicate.sequences[0].panels[1], beatId: "beat-001-cut-001", eventId: "event-001-001" };
  assertContractError(duplicate, /duplicate id beat-001-cut-001/, "duplicate beat panel");
});

test("rejects cross-sequence panel-to-beat references", () => {
  const candidate = project();
  candidate.sequences[1].panels[0] = { ...candidate.sequences[1].panels[0], beatId: "beat-001-cut-001", eventId: "event-001-001" };
  assertContractError(candidate, /unknown beatId beat-001-cut-001/, "cross-sequence panel beat");
});

test("rejects cross-sequence shot-to-cut references", () => {
  const candidate = project();
  candidate.sequences[1].shots[0] = {
    id: "shot-cross-sequence-cut",
    eventId: "event-002-001",
    source: { kind: "cut", beatId: "beat-001-cut-001" },
  };
  assertContractError(candidate, /same sequence/, "cross-sequence cut shot");
});

test("rejects cross-sequence shot-to-waypoint group references", () => {
  const candidate = project();
  candidate.sequences[1].shots[1] = {
    id: "shot-cross-sequence-waypoint",
    eventId: "event-002-002",
    source: { kind: "waypointGroup", eventId: "event-002-002", waypointGroupId: "wp-001-001" },
  };
  assertContractError(candidate, /same-sequence same-event waypoint group/, "cross-sequence waypoint shot");
});

test("rejects render shots from waypoint groups outside the same event", () => {
  const candidate = project();
  candidate.sequences[0].shots[1] = {
    id: "shot-cross-event-waypoint",
    eventId: "event-001-001",
    source: { kind: "waypointGroup", eventId: "event-001-002", waypointGroupId: "wp-001-001" },
  };
  assertContractError(candidate, /same event/, "cross-event waypoint group");
});

test("rejects render shots from non-cut beats", () => {
  const candidate = project();
  candidate.sequences[0].shots[0] = {
    id: "shot-waypoint-as-cut",
    eventId: "event-001-002",
    source: { kind: "cut", beatId: "beat-001-waypoint-001" },
  };
  assertContractError(candidate, /must reference a cut beat/, "waypoint as cut shot");
});

test("rejects missing, duplicate, or ambiguous master audio markers", () => {
  assertContractError(
    project({ audioTracks: [{ id: "narration-master", role: "narration", master: false }] }),
    /exactly one master audio track/,
    "missing master",
  );
  assertContractError(
    project({
      audioTracks: [
        { id: "narration-master", role: "narration", master: true },
        { id: "duplicate-master", role: "music", master: true },
      ],
    }),
    /exactly one master audio track/,
    "duplicate master",
  );
});
