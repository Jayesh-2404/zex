import test from "node:test";
import assert from "node:assert/strict";
import { fromScaled, toScaled } from "./decimal.js";

test("parses plain decimal strings into scaled integers", () => {
  assert.equal(toScaled("0"), 0n);
  assert.equal(toScaled("10"), 1000000000n);
  assert.equal(toScaled("0.1"), 10000000n);
  assert.equal(toScaled("0.33333333"), 33333333n);
  assert.equal(toScaled("12.5"), 1250000000n);
  assert.equal(toScaled(".5"), 50000000n);
  assert.equal(toScaled("5."), 500000000n);
});

test("throws a clear error for values that are not plain decimals", () => {
  assert.throws(() => toScaled(""), /Invalid decimal value/);
  assert.throws(() => toScaled("abc"), /Invalid decimal value/);
  assert.throws(() => toScaled("-1"), /Invalid decimal value/);
  assert.throws(() => toScaled("1e-7"), /Invalid decimal value/);
});

test("formats scaled integers back to trimmed plain strings", () => {
  assert.equal(fromScaled(0n), "0");
  assert.equal(fromScaled(1000000000n), "10");
  assert.equal(fromScaled(10000000n), "0.1");
  assert.equal(fromScaled(30000000n), "0.3");
  assert.equal(fromScaled(10000001n), "0.10000001");
  assert.equal(fromScaled(12000000000n), "120");
});

test("round trips decimal strings without float artifacts", () => {
  for (const value of ["0", "0.1", "0.2", "0.3", "10", "0.00000001", "1234.56789012"]) {
    assert.equal(fromScaled(toScaled(value)), value);
  }
});
