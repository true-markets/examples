import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { fromUnits, toUnits } from "../../shared/amount.ts";
import { SOL_DECIMALS } from "../../shared/trade-rules.ts";
import { env } from "../env.ts";
import { loadSafekeepingSigner } from "./keys.ts";

export type SignatureStatus = "confirmed" | "failed" | "unknown";

interface Send {
  householdId: string;
  to: string;
  amount: string;
  // Called with the signature before broadcast, so the caller can record what it is about to send.
  onSigned: (signature: string) => void;
}

export interface SolanaClient {
  // Token balances are keyed by mint; a mint the owner holds no account for is absent.
  balances(owner: string): Promise<{ sol: string; tokens: Record<string, string> }>;
  sendToken(send: Send & { mint: string; decimals: number }): Promise<string>;
  sendSol(send: Send): Promise<string>;
  status(signature: string): Promise<SignatureStatus>;
}

function createKitSolanaClient(rpcUrl: string): SolanaClient {
  const rpc = createSolanaRpc(rpcUrl);

  async function status(signature: string): Promise<SignatureStatus> {
    const { value } = await rpc
      .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
      .send();
    const result = value[0];
    if (!result) return "unknown";
    if (result.err) return "failed";
    return result.confirmationStatus === "confirmed" || result.confirmationStatus === "finalized" ? "confirmed" : "unknown";
  }

  async function sendSigned(signer: KeyPairSigner, instructions: Instruction[], onSigned: (sig: string) => void) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(transaction);
    onSigned(signature);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
    return signature;
  }

  return {
    async balances(owner) {
      const [sol, accounts] = await Promise.all([
        rpc.getBalance(address(owner), { commitment: "confirmed" }).send(),
        rpc
          .getTokenAccountsByOwner(address(owner), { programId: TOKEN_PROGRAM_ADDRESS }, { encoding: "jsonParsed", commitment: "confirmed" })
          .send(),
      ]);
      const units = new Map<string, { units: bigint; decimals: number }>();
      for (const { account } of accounts.value) {
        const { mint, tokenAmount } = account.data.parsed.info;
        const held = units.get(mint) ?? { units: 0n, decimals: tokenAmount.decimals };
        units.set(mint, { units: held.units + BigInt(tokenAmount.amount), decimals: tokenAmount.decimals });
      }
      const tokens = Object.fromEntries([...units].map(([mint, held]) => [mint, fromUnits(held.units, held.decimals)]));
      return { sol: fromUnits(sol.value, SOL_DECIMALS), tokens };
    },

    async sendToken({ householdId, to, mint, decimals, amount, onSigned }) {
      const signer = await loadSafekeepingSigner(householdId);
      const mintAddress = address(mint);
      const owner = address(to);
      const [source] = await findAssociatedTokenPda({ owner: signer.address, mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const [destination] = await findAssociatedTokenPda({ owner, mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      return sendSigned(
        signer,
        [
          getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner, mint: mintAddress }),
          getTransferCheckedInstruction({
            source,
            mint: mintAddress,
            destination,
            authority: signer,
            amount: toUnits(amount, decimals),
            decimals,
          }),
        ],
        onSigned,
      );
    },

    async sendSol({ householdId, to, amount, onSigned }) {
      const signer = await loadSafekeepingSigner(householdId);
      return sendSigned(
        signer,
        [getTransferSolInstruction({ source: signer, destination: address(to), amount: lamports(toUnits(amount, SOL_DECIMALS)) })],
        onSigned,
      );
    },

    status,
  };
}

export const solanaClient: SolanaClient = createKitSolanaClient(env.SOLANA_RPC_URL);
