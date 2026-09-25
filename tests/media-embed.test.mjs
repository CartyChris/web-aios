import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaEmbedFor } from "../.test-build/media-embed.js";

test("YouTube in every URL shape becomes the embeddable player", () => {
  const want = "https://www.youtube-nocookie.com/embed/8gOWy6FOHPo?autoplay=1";
  for (const u of ["https://www.youtube.com/shorts/8gOWy6FOHPo", "https://youtube.com/watch?v=8gOWy6FOHPo&list=x", "https://youtu.be/8gOWy6FOHPo", "https://m.youtube.com/watch?v=8gOWy6FOHPo", "https://www.youtube.com/live/8gOWy6FOHPo"]) {
    assert.equal(mediaEmbedFor(u)?.url, want, u);
  }
  assert.equal(mediaEmbedFor("https://youtu.be/8gOWy6FOHPo?t=42").url, "https://www.youtube-nocookie.com/embed/8gOWy6FOHPo?autoplay=1&start=42");
});

test("Vimeo and direct media files; ordinary pages and junk are null", () => {
  assert.equal(mediaEmbedFor("https://vimeo.com/123456789").url, "https://player.vimeo.com/video/123456789?autoplay=1");
  assert.equal(mediaEmbedFor("https://cdn.example.com/a/clip.MP4").provider, "file");
  assert.equal(mediaEmbedFor("https://www.youtube.com/"), null);
  assert.equal(mediaEmbedFor("https://www.youtube.com/watch?v=short"), null);
  assert.equal(mediaEmbedFor("https://github.com"), null);
  assert.equal(mediaEmbedFor("javascript:alert(1)"), null);
  assert.equal(mediaEmbedFor("not a url"), null);
});
