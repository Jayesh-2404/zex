import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePositiveDecimal, MAX_DECIMAL_PLACES } from "./decimal.js";

describe("parsePositiveDecimal", () => {
  it("accepts plain positive decimals", () => {
    for (const value of ["1", "10", "0.5", "1.25", "12345.6789", ".5", "5."]) {
      assert.equal(parsePositiveDecimal(value), value.trim(), `expected ${value} to be accepted`);
    }
  });

  it("accepts numeric input by stringifying it", () => {
    assert.equal(parsePositiveDecimal(1.5), "1.5");
    assert.equal(parsePositiveDecimal(10), "10");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parsePositiveDecimal("  1.5  "), "1.5");
  });

  it("rejects exponent notation that the engine cannot parse", () => {
    // The bug this guards: "1e-8" passed Number()-based validation, then threw
    // inside the engine, which swallowed the error and never replied.
    for (const value of ["1e-8", "1E-8", "1e8", "-1e-8"]) {
      assert.equal(parsePositiveDecimal(value), null, `expected ${value} to be rejected`);
    }
  });

  it("rejects negative, zero, and signed values", () => {
    for (const value of ["-1", "-0.5", "0", "0.0", "0.000", "00.000", "+1"]) {
      assert.equal(parsePositiveDecimal(value), null, `expected ${value} to be rejected`);
    }
  });

  it("rejects non-numeric and non-finite input", () => {
    for (const value of ["", " ", "abc", "1,5", "NaN", "Infinity", "1.2.3", null, undefined, {}, []]) {
      assert.equal(parsePositiveDecimal(value), null, `expected ${String(value)} to be rejected`);
    }
  });

  it("rejects non-finite numbers", () => {
    assert.equal(parsePositiveDecimal(Number.NaN), null);
    assert.equal(parsePositiveDecimal(Number.POSITIVE_INFINITY), null);
    assert.equal(parsePositiveDecimal(Number.NEGATIVE_INFINITY), null);
  });

  it(`accepts up to ${MAX_DECIMAL_PLACES} decimal places`, () => {
    assert.equal(parsePositiveDecimal("0.12345678"), "0.12345678");
  });

  it("rejects more decimal places than the engine can scale", () => {
    // The engine truncates beyond 8 places rather than rounding, so accepting
    // these would place an order for a different quantity than requested.
    assert.equal(parsePositiveDecimal("0.123456789"), null);
    assert.equal(parsePositiveDecimal("1.0000000001"), null);
  });
});
