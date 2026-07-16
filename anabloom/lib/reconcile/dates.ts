const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, "dd MMM yyyy", "dd MMM". Returns ISO. */
export function parseFlexibleDate(raw: string, fallbackYear?: number): string | null {
  const s = raw.trim();
  let m: RegExpMatchArray | null;

  // yyyy-mm-dd
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // dd/mm/yyyy or dd-mm-yyyy
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    return iso(year, +m[2], +m[1]);
  }

  // dd MMM yyyy  |  dd-MMM-yyyy  |  dd MMM
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-]?(\d{2,4})?$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) {
      let year = m[3] ? +m[3] : fallbackYear;
      if (year === undefined) return null;
      if (year < 100) year += 2000;
      return iso(year, mon, +m[1]);
    }
  }

  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Parse a Malaysian-format amount: "1,234.56", "1234.56", "(123.45)" as negative. */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/rm/i, "").replace(/\s/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) sign = -1;
  if (s.startsWith("+")) sign = 1;
  if (s.endsWith("-") || /DR$/i.test(s)) sign = -1;
  if (s.endsWith("+") || /CR$/i.test(s)) sign = 1;
  s = s.replace(/^[+-]/, "").replace(/(DR|CR|\+|-)$/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * parseFloat(s);
}
