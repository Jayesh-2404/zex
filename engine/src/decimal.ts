const SCALE_DIGITS = 8;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const DECIMAL_PATTERN = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

export function toScaled(value: string): bigint {
  const match = DECIMAL_PATTERN.exec(value);

  if (!match) {
    throw new Error(`Invalid decimal value: "${value}"`);
  }

  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? match[3] ?? "").padEnd(SCALE_DIGITS, "0").slice(0, SCALE_DIGITS);
  return BigInt(whole + fraction);
}

export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export function minScaled(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
