// Guards the contract between the two processes: every decimal the API
// accepts must survive the engine's fixed-point scaling unchanged.
//
// The engine's grammar and scale are duplicated below rather than imported.
// api/ and engine/ are separate packages with separate Docker build contexts,
// so importing across that boundary would break the isolated image builds.
// If engine/src/decimal.ts changes, update these two constants to match.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePositiveDecimal, MAX_DECIMAL_PLACES } from "./decimal.js";

// Mirrors engine/src/decimal.ts
const ENGINE_SCALE_DIGITS = 8;
const ENGINE_SCALE = 10n ** BigInt(ENGINE_SCALE_DIGITS);
const ENGINE_PATTERN = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

function engineToScaled(value: string): bigint {
  const match = ENGINE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid decimal value: "${value}"`);
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? match[3] ?? "")
    .padEnd(ENGINE_SCALE_DIGITS, "0")
    .slice(0, ENGINE_SCALE_DIGITS);
  return BigInt(whole + fraction);
}

function engineFromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ENGINE_SCALE;
  const fraction = (abs % ENGINE_SCALE).toString().padStart(ENGINE_SCALE_DIGITS, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

const SAMPLE_PRICES = ["0.00000001", "0.1", "0.5", "1", "1.5", "10", "12345.6789", "999999.99999999"];
const SAMPLE_QUANTITIES = ["0.00000001", "0.25", "1", "2.5", "1000", "0.00012345"];

describe("API and engine decimal parity", () => {
  it("keeps MAX_DECIMAL_PLACES aligned with the engine scale", () => {
    // If the engine scales to more places than the API accepts, the API is
    // needlessly strict. If it scales to fewer, it silently truncates orders.
    assert.equal(MAX_DECIMAL_PLACES, ENGINE_SCALE_DIGITS);
  });

  it("round-trips every accepted price through the engine unchanged", () => {
    for (const price of SAMPLE_PRICES) {
      const accepted = parsePositiveDecimal(price);
      assert.notEqual(accepted, null, `API rejected ${price}`);
      assert.equal(
        engineFromScaled(engineToScaled(accepted!)),
        accepted,
        `price ${price} changed crossing the API/engine boundary`,
      );
    }
  });

  it("round-trips every accepted quantity through the engine unchanged", () => {
    for (const quantity of SAMPLE_QUANTITIES) {
      const accepted = parsePositiveDecimal(quantity);
      assert.notEqual(accepted, null, `API rejected ${quantity}`);
      assert.equal(
        engineFromScaled(engineToScaled(accepted!)),
        accepted,
        `quantity ${quantity} changed crossing the API/engine boundary`,
      );
    }
  });

  it("would have thrown in the engine for malformed values the API now rejects", () => {
    // These reach the engine's regex as invalid and would throw, leaving the
    // caller waiting on a reply that never came.
    for (const rejected of ["1e-8", "1E-8", "-1", "1.2.3", "abc", ""]) {
      assert.equal(parsePositiveDecimal(rejected), null, `API should reject ${rejected}`);
      assert.throws(
        () => engineToScaled(rejected),
        `engine still throws on ${rejected}; API is the only guard`,
      );
    }
  });

  it("would silently truncate in the engine for values the API now rejects", () => {
    // Distinct from the case above: the engine does not throw here, it slices
    // the fraction at 8 places. The order would land for a smaller quantity
    // than the client asked for, so the API has to reject it up front.
    for (const rejected of ["0.123456789", "1.0000000001"]) {
      assert.equal(parsePositiveDecimal(rejected), null, `API should reject ${rejected}`);
      assert.notEqual(
        engineFromScaled(engineToScaled(rejected)),
        rejected,
        `${rejected} is now handled correctly by the engine; reconsider this limit`,
      );
    }
  });

  it("never produces a zero quantity from an accepted value", () => {
    for (const quantity of SAMPLE_QUANTITIES) {
      const accepted = parsePositiveDecimal(quantity);
      assert.ok(engineToScaled(accepted!) > 0n, `${quantity} scaled to zero`);
    }
  });
});
