import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/load-config.js";

test("a demo number cannot become a live runtime identity", () => {
  assert.throws(
    () => loadConfig("./tests/fixtures/line-live-demo.yaml"),
    /cannot use a demo line number in LIVE_SERVICES/
  );
});

test("physical edge keeps a stable endpoint id without inventing a line number", () => {
  const endpoint = loadConfig("./tests/fixtures/line-physical-unverified.yaml").cellularEndpoints?.[0];
  assert.equal(endpoint?.id, "android-home-01");
  assert.equal(endpoint?.phoneNumber, undefined);
  assert.equal(endpoint?.lineNumberStatus, "unverified");
});

test("mock configuration identifies its reserved number as demo metadata", () => {
  const config = loadConfig("./src/config/config.test.yaml");
  assert.equal(config.runtimeMode, "MOCK");
  assert.equal(config.cellularEndpoints?.[0]?.lineNumberStatus, "demo");
});
