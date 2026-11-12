import { AssetLogo, Button, Mono } from "../ui.tsx";

interface Props {
  symbol: string;
  icon: string | null;
  amount: string;
  to: string;
  clientName: string;
  error: Error | null;
  sending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

// The second step: exactly what leaves, and where it goes.
export function WithdrawReview({ symbol, icon, amount, to, clientName, error, sending, onBack, onConfirm }: Props) {
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-xl font-semibold tracking-[-0.02em]">Review withdrawal</h3>
        <span className="text-base text-muted">From {clientName}'s client wallet</span>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-2xl border border-hairline bg-paper px-5 py-4">
        <span className="flex flex-col gap-1">
          <span className="text-sm text-muted">You send</span>
          <span className="text-[28px] leading-none font-medium tracking-[-0.03em]">{amount}</span>
        </span>
        <span className="flex items-center gap-2 text-base font-medium">
          <AssetLogo symbol={symbol} icon={icon} size={28} />
          {symbol}
        </span>
      </div>

      <dl className="m-0 flex flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-white text-base">
        <div className="flex flex-col gap-1.5 px-5 py-4">
          <dt className="text-sm text-muted">To</dt>
          <dd className="m-0">
            <Mono className="text-sm break-all">{to}</Mono>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 px-5 py-4">
          <dt className="text-sm text-muted">Network fee</dt>
          <dd className="m-0 text-right">Paid in SOL from the client wallet</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 px-5 py-4">
          <dt className="text-sm text-muted">Signed by</dt>
          <dd className="m-0 text-right">The client wallet's key</dd>
        </div>
      </dl>

      <p className="m-0 rounded-xl bg-segment px-4 py-3 text-sm text-label">Check the address. A withdrawal is final and can't be undone.</p>

      {error && (
        <p role="alert" className="m-0 text-sm text-error">
          {error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="h-12 flex-1 rounded-3xl text-base" disabled={sending} onClick={onBack}>
          Back
        </Button>
        <Button className="h-12 flex-[2] rounded-3xl text-base" disabled={sending} onClick={onConfirm}>
          {sending ? "Sending…" : `Withdraw ${symbol}`}
        </Button>
      </div>
    </div>
  );
}
