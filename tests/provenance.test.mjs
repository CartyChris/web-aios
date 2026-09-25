import { test } from "node:test";
import assert from "node:assert/strict";
import { nextProvenance, provenanceLabel } from "../.test-build/provenance.js";

test("a model's write marks the file; a person's later write keeps the mark and says edited", () => {
  const ai = nextProvenance(undefined, { by: "AIOS Chat", model: "m", at: 1 }, 1);
  assert.deepEqual(ai, { by: "AIOS Chat", model: "m", at: 1 });
  const edited = nextProvenance(ai, undefined, 5);
  assert.equal(edited.editedAt, 5);
  assert.equal(provenanceLabel(edited), "Made by AIOS Chat (m), edited since");
  assert.equal(nextProvenance(undefined, undefined, 9), undefined, "a person's file stays unmarked");
  assert.equal(nextProvenance(edited, { by: "Agent Loop", at: 7 }, 7).editedAt, undefined, "a fresh model write is a fresh mark");
});
