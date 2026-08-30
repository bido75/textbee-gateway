import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneNumber } from "../src/core/phone-normalization.js";

test("normalizes NANP variants to one E.164 identity", () => {
  assert.equal(normalizePhoneNumber("(302) 555-1234"), "+13025551234");
  assert.equal(normalizePhoneNumber("13025551234"), "+13025551234");
  assert.equal(normalizePhoneNumber("+1 302 555 1234"), "+13025551234");
});

test("rejects invalid phone identities", () => {
  assert.throws(() => normalizePhoneNumber("123"), /Invalid phone number/);
});

