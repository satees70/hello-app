import { AccountType } from "./enums";

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  isSystem: boolean;
}

// Fixed code structure, seeded per user. Names are editable; users may add
// extra accounts within a range but cannot delete accounts that have postings.
export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // Assets (1000s, debit-normal)
  { code: "1000", name: "Cash at bank", type: "ASSET", isSystem: true },
  { code: "1010", name: "Cash on hand", type: "ASSET", isSystem: true },
  { code: "1100", name: "Accounts receivable", type: "ASSET", isSystem: true },
  { code: "1500", name: "Property (buildings, at cost)", type: "ASSET", isSystem: true },
  { code: "1510", name: "Furniture & fittings (at cost)", type: "ASSET", isSystem: true },
  { code: "1520", name: "Equipment (at cost)", type: "ASSET", isSystem: true },
  { code: "1590", name: "Accumulated depreciation", type: "ASSET", isSystem: true }, // contra-asset (credit-normal balance)

  // Liabilities (2000s, credit-normal)
  { code: "2000", name: "Tenant deposits held", type: "LIABILITY", isSystem: true },
  { code: "2100", name: "Loans / mortgage payable", type: "LIABILITY", isSystem: true },
  { code: "2200", name: "Accounts payable", type: "LIABILITY", isSystem: true },

  // Equity (3000s, credit-normal)
  { code: "3000", name: "Owner's capital", type: "EQUITY", isSystem: true },
  { code: "3100", name: "Owner's drawings", type: "EQUITY", isSystem: true }, // debit-normal contra
  { code: "3900", name: "Retained earnings", type: "EQUITY", isSystem: true }, // system-calculated, not directly postable

  // Income (4000s, credit-normal)
  { code: "4000", name: "Rental income", type: "INCOME", isSystem: true },
  { code: "4100", name: "Late fee income", type: "INCOME", isSystem: true },
  { code: "4200", name: "Parking income", type: "INCOME", isSystem: true },
  { code: "4900", name: "Other income", type: "INCOME", isSystem: true },

  // Expenses (5000s, debit-normal)
  { code: "5000", name: "Maintenance & repairs", type: "EXPENSE", isSystem: true },
  { code: "5100", name: "Utilities", type: "EXPENSE", isSystem: true },
  { code: "5200", name: "Insurance", type: "EXPENSE", isSystem: true },
  { code: "5300", name: "Property tax / assessment", type: "EXPENSE", isSystem: true },
  { code: "5400", name: "Management fees", type: "EXPENSE", isSystem: true },
  { code: "5500", name: "Loan interest", type: "EXPENSE", isSystem: true },
  { code: "5600", name: "Cleaning", type: "EXPENSE", isSystem: true },
  { code: "5700", name: "Depreciation expense", type: "EXPENSE", isSystem: true },
  { code: "5900", name: "Other expenses", type: "EXPENSE", isSystem: true },
];

// Well-known account codes used by the posting engine.
export const CODE = {
  CASH: "1000",
  CASH_ON_HAND: "1010",
  AR: "1100",
  PROPERTY: "1500",
  FURNITURE: "1510",
  EQUIPMENT: "1520",
  ACC_DEP: "1590",
  DEPOSITS: "2000",
  LOANS: "2100",
  AP: "2200",
  CAPITAL: "3000",
  DRAWINGS: "3100",
  RETAINED: "3900",
  RENTAL_INCOME: "4000",
  LATE_FEE: "4100",
  PARKING: "4200",
  OTHER_INCOME: "4900",
  DEP_EXPENSE: "5700",
  OTHER_EXPENSE: "5900",
} as const;

// Codes that represent bank cash (reconcilable).
export const CASH_CODES: string[] = [CODE.CASH, CODE.CASH_ON_HAND];

// Not directly postable through normal entry.
export const NON_POSTABLE_CODES = [CODE.RETAINED];

export function accountTypeForCode(code: string): AccountType {
  const c = code[0];
  if (c === "1") return "ASSET";
  if (c === "2") return "LIABILITY";
  if (c === "3") return "EQUITY";
  if (c === "4") return "INCOME";
  return "EXPENSE";
}
