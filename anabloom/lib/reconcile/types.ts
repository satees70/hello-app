export interface ParsedLine {
  date: string; // ISO yyyy-mm-dd
  description: string;
  amount: string; // signed decimal string, + in / - out
  runningBalance?: string;
}

export interface ParsedStatement {
  bankName?: string;
  accountLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: string;
  closingBalance?: string;
  lines: ParsedLine[];
  profile: string; // parser profile used
  warnings: string[];
}
