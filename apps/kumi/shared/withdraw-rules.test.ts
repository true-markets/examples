import { describe, expect, it } from "vitest";
import { addressError, maxWithdrawable, solForTokenSends, withdrawalError } from "./withdraw-rules.ts";

const OWN = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("maxWithdrawable", () => {
  it("is all of a token and SOL less the network fee", () => {
    expect(maxWithdrawable("USDC", "12.54")).toBe("12.54");
    expect(maxWithdrawable("SOL", "1")).toBe("0.99999");
  });

  it("never goes below zero", () => {
    expect(maxWithdrawable("SOL", "0.000005")).toBe("0");
  });
});

describe("addressError", () => {
  it("accepts another Solana address", () => {
    expect(addressError(OTHER, OWN)).toBeNull();
  });

  it.each([
    ["", "Enter a valid Solana address."],
    ["0x3fA9b1C47e0D2a8F5E6c9B04d71A2F8e5b3Cc21E", "Enter a valid Solana address."],
    [OWN, "That is this client's own wallet."],
  ])("refuses %s", (to, message) => {
    expect(addressError(to, OWN)).toBe(message);
  });
});

describe("withdrawalError", () => {
  const base = { symbol: "USDC", amount: "10", decimals: 6, balance: "12.54", solBalance: "0.05" };

  it("lets a valid withdrawal through", () => {
    expect(withdrawalError(base)).toBeNull();
    expect(withdrawalError({ ...base, symbol: "SOL", amount: "0.04", decimals: 9, balance: "0.05" })).toBeNull();
  });

  it.each([
    [{ amount: "" }, "Enter an amount."],
    [{ amount: "0" }, "Enter an amount."],
    [{ amount: "1.1234567" }, "Use at most 6 decimal places."],
    [{ amount: "12.55" }, "Only 12.54 USDC can be withdrawn."],
    [{ solBalance: "0.001" }, "Keep about 0.003 SOL in the client wallet to pay network fees."],
    [{ symbol: "SOL", decimals: 9, amount: "0.0005", balance: "0.05" }, "Send at least 0.001 SOL."],
    [{ symbol: "SOL", decimals: 9, amount: "0.05", balance: "0.05" }, "Only 0.04999 SOL can be withdrawn."],
  ])("refuses %j", (change, message) => {
    expect(withdrawalError({ ...base, ...change })).toBe(message);
  });
});

describe("solForTokenSends", () => {
  it("scales the SOL to keep with the number of tokens, without float noise", () => {
    expect(solForTokenSends(1)).toBe("0.003");
    expect(solForTokenSends(3)).toBe("0.009");
    expect(solForTokenSends(0)).toBe("0");
  });
});
