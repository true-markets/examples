import { compareDecimal, fractionDigits, fromUnits, minusDecimal, toUnits } from "./amount.ts";
import { POSITIVE_DECIMAL, SOLANA_ADDRESS } from "./validation.ts";

const SOL_DECIMALS = 9;

// The network fee a SOL transfer pays, kept back so the wallet can always send it.
export const SOL_FEE_RESERVE = "0.00001";
// Sending a token can open the recipient's token account, and the sender pays that rent.
export const SOL_FOR_TOKEN_SEND = "0.003";
// The SOL to keep for sending this many different tokens.
export function solForTokenSends(count: number): string {
  return fromUnits(toUnits(SOL_FOR_TOKEN_SEND, SOL_DECIMALS) * BigInt(count), SOL_DECIMALS);
}

// A transfer to an address that holds nothing must fund at least the rent-exempt minimum.
export const MIN_SOL_SEND = "0.001";

// The most that can leave the wallet: all of a token, or SOL less the fee.
export function maxWithdrawable(symbol: string, balance: string): string {
  if (symbol !== "SOL") return balance;
  const left = minusDecimal(balance, SOL_FEE_RESERVE, SOL_DECIMALS);
  return compareDecimal(left, "0") > 0 ? left : "0";
}

export function addressError(to: string, ownAddress: string): string | null {
  if (!SOLANA_ADDRESS.test(to)) return "Enter a valid Solana address.";
  if (to === ownAddress) return "That is this client's own wallet.";
  return null;
}

export interface WithdrawalCheck {
  symbol: string;
  amount: string;
  decimals: number;
  // What the wallet holds of the asset, and of SOL.
  balance: string;
  solBalance: string;
}

// Why a withdrawal can't go ahead, in words for the advisor; null when it can. The server and the form both use it.
export function withdrawalError({ symbol, amount, decimals, balance, solBalance }: WithdrawalCheck): string | null {
  if (!POSITIVE_DECIMAL.test(amount)) return "Enter an amount.";
  if (fractionDigits(amount) > decimals) return `Use at most ${decimals} decimal places.`;
  const max = maxWithdrawable(symbol, balance);
  if (symbol === "SOL" && compareDecimal(amount, MIN_SOL_SEND) < 0) return `Send at least ${MIN_SOL_SEND} SOL.`;
  if (compareDecimal(amount, max) > 0) return `Only ${max} ${symbol} can be withdrawn.`;
  if (symbol !== "SOL" && compareDecimal(solBalance, SOL_FOR_TOKEN_SEND) < 0) {
    return `Keep about ${SOL_FOR_TOKEN_SEND} SOL in the client wallet to pay network fees.`;
  }
  return null;
}
