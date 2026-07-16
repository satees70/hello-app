import { formatMoney } from "@/lib/money";

export function Money({
  value,
  symbol = "RM",
  className = "",
  colorNegative = true,
}: {
  value: string | number;
  symbol?: string;
  className?: string;
  colorNegative?: boolean;
}) {
  const n = Number(value);
  const neg = n < 0;
  return (
    <span className={`num ${colorNegative && neg ? "text-expense" : ""} ${className}`}>
      {formatMoney(value, symbol)}
    </span>
  );
}
