import { addressError } from "../../../../shared/withdraw-rules.ts";

export const FIELD = "box-border h-12 w-full rounded-xl border border-control bg-white px-4 text-base text-ink";

// Where the funds go: a Solana address, checked as it is typed. Returns the problem too, so a form can hold its button back.
export function addressProblem(to: string, ownAddress: string): string | null {
  return to === "" ? null : addressError(to, ownAddress);
}

export function AddressField({ value, ownAddress, onChange }: { value: string; ownAddress: string; onChange: (to: string) => void }) {
  const problem = addressProblem(value, ownAddress);
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-label">
      Send to
      <input
        autoFocus
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="Solana address"
        aria-invalid={problem !== null}
        className={`${FIELD} font-mono text-sm`}
      />
      {problem && (
        <span role="alert" className="text-sm font-normal text-error">
          {problem}
        </span>
      )}
    </label>
  );
}
