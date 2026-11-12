import assert from "node:assert/strict";
import { test } from "node:test";
import { messages, translate } from "../src/i18n/messages.ts";

test("every translation has both languages and matching substitutions", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
  for (const [key, [ko, en]] of Object.entries(messages)) {
    assert.match(ko, /[가-힣]/, key);
    assert.doesNotMatch(en, /[가-힣]/, key);
    assert.ok(en.trim(), key);
    assert.deepEqual(placeholders(ko), placeholders(en), key);
  }
  assert.equal(translate("ko", "failure.reference", { id: "1234" }), "오류 번호 1234");
  assert.equal(translate("en", "failure.reference", { id: "1234" }), "Reference: 1234");
});
