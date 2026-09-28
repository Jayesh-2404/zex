// Mirrors the grammar in engine/src/decimal.ts. The API validates first so a
// malformed price or quantity is rejected with a 400 instead of throwing
// inside the engine, where the failure cannot be attributed to a request.
//
// Keep both sides in sync: the engine scales to 8 decimal places, so anything
// finer is silently truncated there. Rejecting it here is stricter on purpose.
const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const ALL_ZERO = /^0*(?:\.0*)?$/;

export const MAX_DECIMAL_PLACES = 8;

/**
 * Returns a canonical decimal string, or null if the value is not a positive
 * plain decimal that survives a round trip through the engine's fixed-point
 * scaling. Rejects exponent notation ("1e-8"), signs, and NaN/Infinity.
 */
export function parsePositiveDecimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const raw = String(value).trim();

  if (!PLAIN_DECIMAL.test(raw) || ALL_ZERO.test(raw)) {
    return null;
  }

  const fraction = raw.split(".")[1] ?? "";
  if (fraction.length > MAX_DECIMAL_PLACES) {
    return null;
  }

  return raw;
}
