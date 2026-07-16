import Decimal from "decimal.js";
import { CODE } from "./accounts";
import { SourceType } from "./enums";
import { add, gt, isZero, money, round2, ZERO } from "./money";

export interface PostingLine {
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
}

export interface PostingInput {
  sourceType: SourceType;
  amount?: Decimal.Value; // primary amount for most transaction types
  cashAccountCode?: string; // default 1000
  incomeAccountCode?: string; // OTHER_INCOME_RECEIVED (4xxx)
  expenseAccountCode?: string; // EXPENSE_PAID / EXPENSE_ON_CREDIT (5xxx)
  assetAccountCode?: string; // ASSET_PURCHASED / ASSET_DISPOSAL (15xx)
  fundingAccountCode?: string; // ASSET_PURCHASED: cash (1000) or AP (2200)
  principal?: Decimal.Value; // LOAN_REPAYMENT
  interest?: Decimal.Value; // LOAN_REPAYMENT
  disposal?: { cost: Decimal.Value; accumulated: Decimal.Value; proceeds: Decimal.Value };
  manualLines?: { accountCode: string; debit: Decimal.Value; credit: Decimal.Value }[];
}

function dr(accountCode: string, amount: Decimal.Value): PostingLine {
  return { accountCode, debit: round2(amount), credit: ZERO };
}
function cr(accountCode: string, amount: Decimal.Value): PostingLine {
  return { accountCode, debit: ZERO, credit: round2(amount) };
}

export class PostingError extends Error {}

function requireAmount(input: PostingInput): Decimal {
  const a = money(input.amount ?? 0);
  if (!gt(a, 0)) throw new PostingError("Amount must be greater than zero.");
  return round2(a);
}

/**
 * Pure posting engine: turns a plain-language transaction into balanced
 * double-entry journal lines (by account code). Never trusts the client.
 * Throws PostingError on invalid input; the returned lines always balance.
 */
export function buildPosting(input: PostingInput): PostingLine[] {
  const cash = input.cashAccountCode || CODE.CASH;
  let lines: PostingLine[];

  switch (input.sourceType) {
    case "RENT_RECEIVED": {
      const a = requireAmount(input);
      lines = [dr(cash, a), cr(CODE.RENTAL_INCOME, a)];
      break;
    }
    case "OTHER_INCOME_RECEIVED": {
      const a = requireAmount(input);
      const acc = input.incomeAccountCode;
      if (!acc || acc[0] !== "4") throw new PostingError("Pick an income (4xxx) account.");
      lines = [dr(cash, a), cr(acc, a)];
      break;
    }
    case "RENT_INVOICED": {
      const a = requireAmount(input);
      lines = [dr(CODE.AR, a), cr(CODE.RENTAL_INCOME, a)];
      break;
    }
    case "RENT_PAYMENT": {
      const a = requireAmount(input);
      lines = [dr(cash, a), cr(CODE.AR, a)];
      break;
    }
    case "EXPENSE_PAID": {
      const a = requireAmount(input);
      const acc = input.expenseAccountCode;
      if (!acc || acc[0] !== "5") throw new PostingError("Pick an expense (5xxx) account.");
      lines = [dr(acc, a), cr(cash, a)];
      break;
    }
    case "EXPENSE_ON_CREDIT": {
      const a = requireAmount(input);
      const acc = input.expenseAccountCode;
      if (!acc || acc[0] !== "5") throw new PostingError("Pick an expense (5xxx) account.");
      lines = [dr(acc, a), cr(CODE.AP, a)];
      break;
    }
    case "PAY_BILL": {
      const a = requireAmount(input);
      lines = [dr(CODE.AP, a), cr(cash, a)];
      break;
    }
    case "DEPOSIT_RECEIVED": {
      const a = requireAmount(input);
      lines = [dr(cash, a), cr(CODE.DEPOSITS, a)];
      break;
    }
    case "DEPOSIT_REFUNDED": {
      const a = requireAmount(input);
      lines = [dr(CODE.DEPOSITS, a), cr(cash, a)];
      break;
    }
    case "DEPOSIT_APPLIED": {
      const a = requireAmount(input);
      lines = [dr(CODE.DEPOSITS, a), cr(CODE.AR, a)];
      break;
    }
    case "DEPOSIT_FORFEIT": {
      const a = requireAmount(input);
      lines = [dr(CODE.DEPOSITS, a), cr(CODE.OTHER_INCOME, a)];
      break;
    }
    case "OWNER_CAPITAL": {
      const a = requireAmount(input);
      lines = [dr(cash, a), cr(CODE.CAPITAL, a)];
      break;
    }
    case "OWNER_DRAWINGS": {
      const a = requireAmount(input);
      lines = [dr(CODE.DRAWINGS, a), cr(cash, a)];
      break;
    }
    case "LOAN_RECEIVED": {
      const a = requireAmount(input);
      lines = [dr(cash, a), cr(CODE.LOANS, a)];
      break;
    }
    case "LOAN_REPAYMENT": {
      const principal = round2(money(input.principal ?? 0));
      const interest = round2(money(input.interest ?? 0));
      if (!gt(principal, 0) && !gt(interest, 0))
        throw new PostingError("Enter a principal and/or interest amount.");
      const total = add(principal, interest);
      lines = [];
      if (gt(principal, 0)) lines.push(dr(CODE.LOANS, principal));
      if (gt(interest, 0)) lines.push(dr("5500", interest));
      lines.push(cr(cash, total));
      break;
    }
    case "ASSET_PURCHASED": {
      const a = requireAmount(input);
      const asset = input.assetAccountCode;
      if (!asset || !["1500", "1510", "1520"].includes(asset))
        throw new PostingError("Pick an asset account (1500/1510/1520).");
      const funding = input.fundingAccountCode || cash; // cash or AP (2200)
      lines = [dr(asset, a), cr(funding, a)];
      break;
    }
    case "DEPRECIATION": {
      const a = requireAmount(input);
      lines = [dr(CODE.DEP_EXPENSE, a), cr(CODE.ACC_DEP, a)];
      break;
    }
    case "ASSET_DISPOSAL": {
      const d = input.disposal;
      if (!d) throw new PostingError("Disposal details required.");
      const cost = round2(money(d.cost));
      const accumulated = round2(money(d.accumulated));
      const proceeds = round2(money(d.proceeds));
      const asset = input.assetAccountCode;
      if (!asset || !["1500", "1510", "1520"].includes(asset))
        throw new PostingError("Pick the asset account being disposed.");
      lines = [cr(asset, cost)];
      if (gt(accumulated, 0)) lines.push(dr(CODE.ACC_DEP, accumulated));
      if (gt(proceeds, 0)) lines.push(dr(cash, proceeds));
      // gain/loss = proceeds - net book value
      const nbv = cost.minus(accumulated);
      const gainLoss = proceeds.minus(nbv);
      if (gt(gainLoss, 0)) lines.push(cr(CODE.OTHER_INCOME, gainLoss));
      else if (gainLoss.isNegative()) lines.push(dr(CODE.OTHER_EXPENSE, gainLoss.abs()));
      break;
    }
    case "MANUAL": {
      if (!input.manualLines || input.manualLines.length < 2)
        throw new PostingError("A manual entry needs at least two lines.");
      lines = input.manualLines.map((l) => {
        const debit = round2(money(l.debit));
        const credit = round2(money(l.credit));
        if (!isZero(debit) && !isZero(credit))
          throw new PostingError("Each line must be either a debit or a credit, not both.");
        if (isZero(debit) && isZero(credit))
          throw new PostingError("Each line must have a non-zero amount.");
        return { accountCode: l.accountCode, debit, credit };
      });
      break;
    }
    default:
      throw new PostingError(`Unsupported transaction type: ${input.sourceType}`);
  }

  validateLines(lines);
  return lines;
}

/** Enforce the double-entry invariant: >=2 lines, single-sided, balanced. */
export function validateLines(lines: PostingLine[]): void {
  if (lines.length < 2) throw new PostingError("An entry needs at least two lines.");
  let debits = ZERO;
  let credits = ZERO;
  for (const l of lines) {
    if (!isZero(l.debit) && !isZero(l.credit))
      throw new PostingError("Each line must be either a debit or a credit, not both.");
    debits = add(debits, l.debit);
    credits = add(credits, l.credit);
  }
  if (!round2(debits).equals(round2(credits)))
    throw new PostingError(
      `Entry does not balance: debits ${round2(debits)} vs credits ${round2(credits)}.`
    );
}
