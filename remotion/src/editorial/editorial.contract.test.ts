import assert from "node:assert/strict";
import test from "node:test";
import { cameraTransform } from "./camera";
import type { EditorialShot } from "./types";
import {
  buildTimeline,
  isConcreteSubject,
  totalDurationInFrames,
  validateTimeline,
} from "./timing";
import {
  incomingTransitionStyle,
  isBridgeTransition,
  outgoingTransitionStyle,
  transitionFrames,
} from "./transitions";

function shot(id: string, durationInFrames = 30, backgroundSrc = "plate-a.png"): EditorialShot {
  return {
    id,
    durationInFrames,
    background: { src: backgroundSrc, kind: "image" as const, fit: "cover" as const, position: "center", filter: "none" },
  };
}

function scaleFromTransform(transform: string) {
  const match = transform.match(/scale\(([-\d.]+)/);
  assert.ok(match, `camera transform should contain a scale: ${transform}`);
  return Number(match[1]);
}

test("timeline conserves shot durations and rejects duplicate ids", () => {
  const shots = [shot("one", 40), shot("two", 35)];
  assert.equal(totalDurationInFrames(shots), 75);
  assert.deepEqual(buildTimeline(shots).map((item) => item.startFrame), [0, 40]);
  assert.deepEqual(validateTimeline(shots, 75), []);
  assert.match(validateTimeline(shots, 73).join("\n"), /does not match shot total 75/);

  const hardCut = shot("hard-cut", 20);
  hardCut.transitionIn = { class: "hard_cut", frames: 18 };
  assert.equal(buildTimeline([shot("prior", 20), hardCut])[1].incomingOffsetFrames, 0);

  const duplicate = [shot("same"), shot("same")];
  assert.match(validateTimeline(duplicate, 60).join("\n"), /shot id must be unique/);
});

test("cue subjects must identify a concrete visible subject", () => {
  assert.equal(isConcreteSubject("Yahoo logo"), true);
  assert.equal(isConcreteSubject(" text "), false);
  assert.equal(isConcreteSubject("shape"), false);
  assert.equal(isConcreteSubject(""), false);

  const invalid = shot("subjects", 30);
  invalid.texts = [
    { subject: "text", text: "A readable phrase", startFrame: 0, endFrame: 10 },
    { subject: "", text: "Another phrase", startFrame: 10, endFrame: 20 },
  ];
  invalid.graphics = [
    { kind: "grid", subject: "shape", startFrame: 0, endFrame: 10 },
  ];
  const errors = validateTimeline([invalid], 30).join("\n");
  assert.match(errors, /text cue subject must be concrete/);
  assert.match(errors, /graphic cue subject must be concrete/);
});

test("counter cues require an auditable unit and period", () => {
  const counter = shot("counter", 30);
  counter.texts = [{ subject: "view count", type: "counter", entry: "counter", startFrame: 0, endFrame: 20, from: 111, to: 133 }];
  const missing = validateTimeline([counter], 30).join("\n");
  assert.match(missing, /counter cue unit must not be empty/);
  assert.match(missing, /counter cue period must not be empty/);

  counter.texts[0].unit = "views";
  counter.texts[0].period = "sample window";
  assert.deepEqual(validateTimeline([counter], 30), []);
});

test("text and graphic cue ranges stay inside their shot", () => {
  const invalid = shot("ranges", 30);
  invalid.texts = [
    { subject: "headline", startFrame: -1, endFrame: 10 },
    { subject: "caption", startFrame: 10, endFrame: 31 },
    { subject: "metric", startFrame: 18, endFrame: 18 },
  ];
  invalid.graphics = [
    { kind: "underline", subject: "purple underline", startFrame: 0, endFrame: 0 },
  ];
  const errors = validateTimeline([invalid], 30).join("\n");
  assert.equal((errors.match(/frame range must be within/g) || []).length, 4);
});

test("within-setup transition requires the previous background setup", () => {
  const first = shot("first", 30, "same.png");
  const second = shot("second", 30, "same.png");
  second.transitionIn = { class: "within_setup_change", frames: 20 };
  assert.deepEqual(validateTimeline([first, second], 60), []);

  const changed = shot("changed", 30, "different.png");
  changed.transitionIn = { class: "within_setup_change" };
  assert.match(validateTimeline([first, changed], 60).join("\n"), /within_setup_change requires the previous shot background setup/);

  const firstOnly = shot("first-only", 30);
  firstOnly.transitionIn = { class: "within_setup_change" };
  assert.match(validateTimeline([firstOnly], 30).join("\n"), /within_setup_change requires the previous shot background setup/);
});

test("transition classes map to explicit bridge primitives", () => {
  for (const className of ["hard_cut", "ambiguous", "no_local_delta", "within_setup_change"] as const) {
    assert.equal(transitionFrames({ class: className, frames: 20 }), 0, `${className} must preserve a direct boundary`);
    assert.deepEqual(incomingTransitionStyle({ class: className, frames: 20 }, 0, 20), { opacity: 1 });
  }
  assert.equal(transitionFrames({ class: "dissolve", frames: 8 }), 8);
  assert.equal(transitionFrames({ class: "blur_bridge", frames: 8 }), 8);
  assert.equal(transitionFrames({ class: "graphic_transition", frames: 8 }), 8);
  assert.equal(transitionFrames({ class: "matte_transition", frames: 8 }), 8);
  assert.equal(transitionFrames({ class: "distortion", frames: 8 }), 8);
  assert.equal(isBridgeTransition("blur_bridge"), true);
  assert.equal(isBridgeTransition("graphic_transition"), true);
  assert.equal(isBridgeTransition("distortion"), true);
  assert.equal(isBridgeTransition("ambiguous"), false);

  assert.equal(incomingTransitionStyle({ class: "dissolve", frames: 8 }, 0, 8).opacity, 0);
  assert.match(String(incomingTransitionStyle({ class: "blur_bridge", frames: 8 }, 0, 8).filter), /blur/);
  assert.match(String(incomingTransitionStyle({ class: "matte_transition", frames: 8 }, 4, 8).clipPath), /polygon/);
  assert.match(String(incomingTransitionStyle({ class: "distortion", frames: 8 }, 0, 8).transform), /skewX/);
  assert.ok(Number(outgoingTransitionStyle({ class: "graphic_transition", frames: 8 }, 29, 30).opacity) < 1);
  assert.match(String(outgoingTransitionStyle({ class: "matte_transition", frames: 8 }, 29, 30).clipPath), /polygon/);
});

test("camera hold is stable and pan/tilt stays inside crop headroom", () => {
  const holdStartTransform = cameraTransform(0, 120, { preset: "hold", intensity: 1 });
  const holdEndTransform = cameraTransform(119, 120, { preset: "hold", intensity: 1 });
  const holdStart = scaleFromTransform(holdStartTransform);
  const holdEnd = scaleFromTransform(holdEndTransform);
  assert.equal(holdStart, holdEnd, "hold must not hide a push-in");
  assert.equal(holdStartTransform, holdEndTransform, "hold must not hide a drift");

  for (const preset of ["pan_left", "pan_right", "tilt_up", "tilt_down"] as const) {
    for (const frame of [0, 59, 119]) {
      const scale = scaleFromTransform(cameraTransform(frame, 120, { preset, intensity: 1 }));
      assert.ok(scale <= 1.06, `${preset} scale ${scale} exceeds crop headroom`);
      assert.ok(scale >= 1.045, `${preset} scale ${scale} may reveal an edge`);
    }
  }
});
