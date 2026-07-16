import Decimal from "decimal.js";

// Decimal-safe money. Never use JS floats for money.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;

export function money(x: Decimal.Value): Money {
  return new Decimal(x ?? 0);
}

export const ZERO = money(0);

export function add(...xs: Decimal.Value[]): Money {
  return xs.reduce<Money>((acc, x) => acc.plus(money(x)), ZERO);
}

export function sub(a: Decimal.Value, b: Decimal.Value): Money {
  return money(a).minus(money(b));
}

export function mul(a: Decimal.Value, b: Decimal.Value): Money {
  return money(a).times(money(b));
}

export function div(a: Decimal.Value, b: Decimal.Value): Money {
  return money(a).dividedBy(money(b));
}

export function round2(a: Decimal.Value): Money {
  return money(a).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function isZero(a: Decimal.Value): boolean {
  return money(a).isZero();
}

export function eq(a: Decimal.Value, b: Decimal.Value): boolean {
  return money(a).equals(money(b));
}

export function gt(a: Decimal.Value, b: Decimal.Value): boolean {
  return money(a).greaterThan(money(b));
}

export function abs(a: Decimal.Value): Money {
  return money(a).abs();
}

// Format money for display: 2dp, thousands separators, optional symbol.
export function formatMoney(a: Decimal.Value, symbol = "RM"): string {
  const n = round2(a);
  const neg = n.isNegative();
  const parts = n.abs().toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = parts.join(".");
  return `${neg ? "-" : ""}${symbol ? symbol + " " : ""}${body}`;
}
