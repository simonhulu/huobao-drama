import assert from "node:assert/strict";
import test from "node:test";
import { buildMagnatesProps, MagnatesPropsError } from "./magnates_props_core.mjs";

function recipe() {
  return {
    schemaVersion: "magnates-remotion-recipe-v2",
    durationInFrames: 30,
    fps: 30,
    title: "Yahoo",
    shots: [{
      id: "shot-001",
      durationInFrames: 30,
      background: { assetId: "asset-yahoo" },
      semanticRole: "reversal",
      texts: [
        {
          id: "text-yahoo",
          type: "text",
          subject: "Yahoo wordmark",
          subjectId: "entity-yahoo",
          text: "Yahoo",
          startFrame: 0,
          endFrame: 30,
          entry: "fade",
        },
        {
          id: "counter-market-cap",
          subject: "market capitalization",
          subjectId: "claim-market-cap",
          type: "counter",
          entry: "counter",
          metricId: "metric-market-cap",
          unit: "USD billions",
          period: "peak valuation",
          from: 0,
          to: 128,
          startFrame: 10,
          endFrame: 25,
        },
      ],
      graphics: [{
        id: "graphic-underline",
        kind: "underline",
        subject: "Yahoo underline",
        subjectId: "entity-yahoo",
        startFrame: 4,
        endFrame: 28,
      }],
    }],
  };
}

const inventory = {
  assets: [{ assetId: "asset-yahoo", stagedPath: "static/yahoo.png", verified: true }],
};
const metadata = {
  entities: [{ id: "entity-yahoo" }],
  claims: [{ id: "claim-market-cap" }],
  metrics: [{ id: "metric-market-cap", sourceNote: "Yahoo historical valuation", claimId: "claim-market-cap" }],
};

test("pure core converts canonical v2 identities without mutating inputs", () => {
  const input = recipe();
  const before = structuredClone(input);
  const props = buildMagnatesProps({ recipe: input, assetInventory: inventory, metadata, target: { profileId: "youtube-1080p", width: 1920, height: 1080, fps: 30 } });
  assert.deepEqual(input, before);
  assert.equal(props.recipeSchemaVersion, "magnates-remotion-recipe-v2");
  assert.equal(props.targetProfileId, "youtube-1080p");
  assert.equal(props.width, 1920);
  assert.equal(props.shots[0].background.assetId, "asset-yahoo");
  assert.equal(props.shots[0].background.src, "static/yahoo.png");
});

test("pure core resolves an injected narration identity from metadata", () => {
  const props = buildMagnatesProps({
    recipe: recipe(),
    assetInventory: {
      assets: [
        ...inventory.assets,
        { assetId: "narration-conformed", kind: "audio", stagedPath: "/run/audio/narration.wav", sha256: "a".repeat(64) },
      ],
    },
    metadata: { ...metadata, audioAssetId: "narration-conformed" },
  });
  assert.equal(props.audioAssetId, "narration-conformed");
  assert.equal(props.audioUrl, "/run/audio/narration.wav");
});

test("pure core rejects legacy, paths, unknown fields, unresolved identities, and duration drift", () => {
  const cases = [
    ["legacy", { ...recipe(), schemaVersion: "magnates-remotion-recipe-v1" }, /schemaVersion/],
    ["path", { ...recipe(), shots: [{ ...recipe().shots[0], background: { src: "/tmp/yahoo.png" } }] }, /unknown property|assetId/],
    ["unknown", { ...recipe(), surprise: true }, /unknown property/],
    ["asset", { ...recipe(), shots: [{ ...recipe().shots[0], background: { assetId: "missing" } }] }, /unresolved assetId/],
    ["subject", { ...recipe(), shots: [{ ...recipe().shots[0], texts: [{ ...recipe().shots[0].texts[0], subjectId: "missing" }] }] }, /unresolved subjectId/],
    ["duration", { ...recipe(), durationInFrames: 31 }, /exact shot total/],
  ];
  for (const [name, candidate, expected] of cases) {
    assert.throws(() => buildMagnatesProps({ recipe: candidate, assetInventory: inventory, metadata }), (error) => {
      assert.ok(error instanceof MagnatesPropsError, name);
      assert.match(error.message, expected, name);
      return true;
    });
  }
});

test("pure core rejects remote and data inventory paths", () => {
  for (const stagedPath of ["https://example.test/yahoo.png", "data:image/png;base64,AAAA"]) {
    assert.throws(() => buildMagnatesProps({ recipe: recipe(), assetInventory: { assets: [{ assetId: "asset-yahoo", stagedPath }] }, metadata }), /stagedPath/);
  }
});
