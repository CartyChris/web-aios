/**
 * Multimodal message translation.
 *
 * One image, three completely different wire shapes. Getting one wrong does
 * not throw — the provider simply ignores the picture and answers from the
 * text, which looks exactly like a model that is bad at looking at things.
 * These assert the actual bytes that go on the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, splitDataUrl, requiresVision, messageText } from "../.test-build/ai-transport.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const visionMsg = {
  role: "user",
  content: [{ type: "text", text: "what is wrong with this scene?" }, { type: "image", dataUrl: PNG }],
};
const body = (req) => JSON.parse(buildRequest(req).init.body);
const base = { baseUrl: "https://example.test/v1", apiKey: "k", model: "m", messages: [visionMsg] };

test("splitDataUrl separates the media type from the payload", () => {
  assert.deepEqual(splitDataUrl(PNG), { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" });
  assert.equal(splitDataUrl("https://example.com/a.png"), null);
  assert.equal(splitDataUrl("not a url at all"), null);
});

test("requiresVision detects an image anywhere in the conversation", () => {
  assert.equal(requiresVision([{ role: "user", content: "plain text" }]), false);
  assert.equal(requiresVision([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
  assert.equal(requiresVision([visionMsg]), true);
});

test("messageText flattens a multimodal message for token estimates", () => {
  assert.equal(messageText(visionMsg), "what is wrong with this scene? [image]");
  assert.equal(messageText({ role: "user", content: "just text" }), "just text");
});

test("OpenAI gets image_url parts carrying the data URL verbatim", () => {
  const parts = body({ ...base, dialect: "openai" }).messages[0].content;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, PNG);
});

test("Anthropic gets a base64 source block with a separate media_type", () => {
  const parts = body({ ...base, dialect: "anthropic" }).messages[0].content;
  assert.equal(parts[1].type, "image");
  assert.equal(parts[1].source.type, "base64");
  assert.equal(parts[1].source.media_type, "image/png");
  // Critically NOT the whole data: URL — Anthropic rejects the prefix.
  assert.equal(parts[1].source.data, "iVBORw0KGgoAAAANSUhEUg==");
});

test("Google gets inlineData with mimeType, not a data URL", () => {
  const parts = body({ ...base, dialect: "google" }).contents[0].parts;
  assert.equal(parts[0].text, "what is wrong with this scene?");
  assert.equal(parts[1].inlineData.mimeType, "image/png");
  assert.equal(parts[1].inlineData.data, "iVBORw0KGgoAAAANSUhEUg==");
});

test("a plain string message is unchanged in all three dialects", () => {
  const msgs = [{ role: "user", content: "hello" }];
  assert.equal(body({ ...base, messages: msgs, dialect: "openai" }).messages[0].content, "hello");
  assert.equal(body({ ...base, messages: msgs, dialect: "anthropic" }).messages[0].content, "hello");
  assert.deepEqual(body({ ...base, messages: msgs, dialect: "google" }).contents[0].parts, [{ text: "hello" }]);
});

test("a remote image URL degrades per dialect instead of producing a bad request", () => {
  const remote = { role: "user", content: [{ type: "image", dataUrl: "https://example.com/a.png" }] };
  // OpenAI takes URLs natively.
  assert.equal(body({ ...base, messages: [remote], dialect: "openai" }).messages[0].content[0].image_url.url, "https://example.com/a.png");
  // Anthropic has a url source form.
  assert.equal(body({ ...base, messages: [remote], dialect: "anthropic" }).messages[0].content[0].source.type, "url");
  // Google has neither, so it becomes a note the model can at least read.
  assert.match(body({ ...base, messages: [remote], dialect: "google" }).contents[0].parts[0].text, /^\[image at /);
});
