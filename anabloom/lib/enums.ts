// Enum-like constants. Modelled as strings in Prisma so one schema targets both
// SQLite (dev) and Postgres (prod). Validated in TS.

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Normal balance per account type (debit-normal vs credit-normal).
export const NORMAL_BALANCE: Record<AccountType, "DEBIT" | "CREDIT"> = {
  ASSET: "DEBIT",
  EXPENSE: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  INCOME: "CREDIT",
};

export const SOURCE_TYPES = [
  "RENT_RECEIVED",
  "OTHER_INCOME_RECEIVED",
  "RENT_INVOICED",
  "RENT_PAYMENT",
  "EXPENSE_PAID",
  "EXPENSE_ON_CREDIT",
  "PAY_BILL",
  "DEPOSIT_RECEIVED",
  "DEPOSIT_REFUNDED",
  "DEPOSIT_APPLIED",
  "OWNER_CAPITAL",
  "OWNER_DRAWINGS",
  "LOAN_RECEIVED",
  "LOAN_REPAYMENT",
  "ASSET_PURCHASED",
  "DEPRECIATION",
  "ASSET_DISPOSAL",
  "DEPOSIT_FORFEIT",
  "MANUAL",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  RENT_RECEIVED: "Rent received",
  OTHER_INCOME_RECEIVED: "Other income received",
  RENT_INVOICED: "Rent invoiced (owed)",
  RENT_PAYMENT: "Rent payment against receivable",
  EXPENSE_PAID: "Expense paid",
  EXPENSE_ON_CREDIT: "Expense on credit (bill)",
  PAY_BILL: "Pay a bill",
  DEPOSIT_RECEIVED: "Tenant deposit received",
  DEPOSIT_REFUNDED: "Tenant deposit refunded",
  DEPOSIT_APPLIED: "Deposit applied to arrears",
  OWNER_CAPITAL: "Owner puts money in",
  OWNER_DRAWINGS: "Owner takes money out",
  LOAN_RECEIVED: "Loan received",
  LOAN_REPAYMENT: "Loan repayment",
  ASSET_PURCHASED: "Asset purchased",
  DEPRECIATION: "Depreciation",
  ASSET_DISPOSAL: "Asset disposal",
  DEPOSIT_FORFEIT: "Deposit forfeited to income",
  MANUAL: "Manual journal",
};

export const LEASE_STATUS = ["ACTIVE", "ENDED"] as const;
export const STATEMENT_STATUS = ["DRAFT", "REVIEWED", "RECONCILED"] as const;
export const MATCH_STATUS = [
  "UNMATCHED",
  "AUTO_MATCHED",
  "CONFIRMED",
  "ENTRY_CREATED",
  "IGNORED",
] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];
