import assert from "node:assert/strict";
import test from "node:test";
import { mergeMessageStatus } from "../src/core/session-manager.js";

test("message delivery status never regresses when webhooks arrive out of order", () => {
  assert.equal(mergeMessageStatus("queued", "sent"), "sent");
  assert.equal(mergeMessageStatus("sent", "queued"), "sent");
  assert.equal(mergeMessageStatus("delivered", "sent"), "delivered");
  assert.equal(mergeMessageStatus("delivered", "failed"), "delivered");
});

test("a delivery receipt can correct a premature failure", () => {
  assert.equal(mergeMessageStatus("failed", "delivered"), "delivered");
  assert.equal(mergeMessageStatus("failed", "sent"), "failed");
});
