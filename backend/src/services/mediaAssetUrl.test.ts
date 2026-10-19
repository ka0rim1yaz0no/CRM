import assert from "node:assert/strict";
import test from "node:test";
import { mediaAssetUrl } from "../../../src/lib/mediaAssetUrl";

test("media previews and downloads keep the selected business without bypassing the local proxy", () => {
  assert.equal(mediaAssetUrl("/api/media/file/fake.png", "", "business-b"), "/api/media/file/fake.png?businessId=business-b");
  assert.equal(mediaAssetUrl("/uploads/media/old.png", "", "business-c"), "/api/media/file/old.png?businessId=business-c");
  assert.equal(mediaAssetUrl("/api/media/file/fake.png?businessId=old", "", "new"), "/api/media/file/fake.png?businessId=new");
  assert.equal(mediaAssetUrl("/api/media/file/fake.png", "http://127.0.0.1:4102", "fixture-b"), "http://127.0.0.1:4102/api/media/file/fake.png?businessId=fixture-b");
  assert.equal(mediaAssetUrl("https://example.invalid/image.png", "", "new"), "https://example.invalid/image.png");
  assert.equal(mediaAssetUrl("", "", "new"), "");
});
