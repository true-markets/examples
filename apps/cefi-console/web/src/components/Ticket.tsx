import { ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { DefiQuote } from "../../../shared/api.ts";
import { isDefiDone } from "../../../shared/api.ts";
import type { Side, TimeInForce } from "../../../shared/wire.ts";
import {
  useDefiExecute,
  useDefiOrder,
  useDefiQuote,
  useInstruments,
  usePlaceOrder,
  useSession,
} from "../api.ts";
import { price as fmtPrice, qty as fmtQty, usd } from "../format.ts";
import { store, useMarket } from "../store.ts";
import { sizeOrder, type SizeUnit } from "../order-size.ts";
import { useUi } from "../ui-state.tsx";
import {
  Button,
  Field,
  Modal,
  Panel,
  Segmented,
  cx,
  inputClass,
} from "./ui.tsx";

type Venue = "CEFI" | "DEFI";

// A manual order ticket: handy for testing and for stepping in next to an automated strategy.
// CeFi orders go straight to the exchange (limit or market). DeFi orders go through the gateway as
// market swaps on the asset's DeFi listing: quoted first, then signed by the server and executed.
export function Ticket() {
  const { symbol, ticket } = useUi();
  const { data: session } = useSession();
  const { data: instruments } = useInstruments();
  useMarket();
  const place = usePlaceOrder();
  const quoteDefi = useDefiQuote();
  const [venue, setVenue] = useState<Venue>("CEFI");
  const [side, setSide] = useState<Side>("BUY");
  const [type, setType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [tif, setTif] = useState<TimeInForce>("GTC");
  // What you type: an amount in USD (the default) or a quantity of the asset.
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<SizeUnit>("USD");
  const [price, setPrice] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [armed, setArmed] = useState(false);
  const [quote, setQuote] = useState<DefiQuote>();
  const [lastDefi, setLastDefi] = useState<string>();

  const inst = instruments?.find((i) => i.symbol === symbol);
  const defi = inst?.defi;
  // A halted CeFi book takes no orders; its DeFi listing still trades.
  const status =
    (symbol && store.instruments.get(symbol)?.status) || inst?.status;
  const halted = !!status && /HALT/i.test(status);
  // Not every book has a DeFi listing; fall back to CeFi when it doesn't, and to DeFi when CeFi is halted.
  useEffect(() => {
    if (venue === "DEFI" && instruments && !defi) setVenue("CEFI");
    if (venue === "CEFI" && halted && defi) setVenue("DEFI");
  }, [venue, defi, instruments, halted]);

  // A click on the book fills in the price and the side that would rest there.
  useEffect(() => {
    if (!ticket.nonce) return;
    if (ticket.price) {
      setPrice(ticket.price);
      setType("LIMIT");
      if (!halted) setVenue("CEFI");
    }
    if (ticket.side) setSide(ticket.side);
  }, [ticket]);

  useEffect(
    () => setArmed(false),
    [side, type, tif, qty, price, symbol, venue, unit],
  );

  const onDefi = venue === "DEFI";
  const ebbo = symbol ? store.ebbo.get(symbol) : undefined;
  const bid = Number(ebbo?.info.best_bid?.price ?? 0);
  const ask = Number(ebbo?.info.best_ask?.price ?? 0);
  const baseSymbol = defi?.symbol ?? symbol?.split("-")[0] ?? "";
  const live = session?.mode === "live";

  // Turn the amount into what this route accepts, and say what will be sent.
  const sized = sizeOrder({
    venue,
    side,
    type: onDefi ? "MARKET" : type,
    unit,
    amount: qty,
    limitPrice: Number(price) || undefined,
    bid: bid || undefined,
    ask: ask || undefined,
    base: baseSymbol,
    defiDecimals: defi?.decimals,
  });
  const cefiHalted = !onDefi && halted;
  const valid = !!symbol && sized.ok && !cefiHalted;

  const submit = () => {
    if (!symbol || !valid) return;
    if (onDefi) {
      // The quote dialog is the confirmation step for a DeFi order.
      if (sized.ok)
        quoteDefi.mutate(
          { symbol, side, qty: sized.qty },
          { onSuccess: setQuote },
        );
      return;
    }
    // In live mode the first click arms the button and the second sends.
    if (live && !armed) {
      setArmed(true);
      return;
    }
    if (!sized.ok) return;
    place.mutate(
      {
        symbol,
        side,
        type,
        tif: type === "MARKET" ? "IOC" : tif,
        qty: sized.qty,
        price: type === "LIMIT" ? price : undefined,
        postOnly: type === "LIMIT" && postOnly,
        quoteQty: type === "MARKET" && sized.quoteQty,
      },
      { onSettled: () => setArmed(false) },
    );
  };

  const busy = place.isPending || quoteDefi.isPending;
  const label = onDefi
    ? quoteDefi.isPending
      ? "Getting quote…"
      : `Get DeFi quote · ${side === "BUY" ? "buy" : "sell"} ${baseSymbol}`
    : place.isPending
      ? "Sending…"
      : armed
        ? `Confirm LIVE ${side.toLowerCase()}`
        : `${side === "BUY" ? "Buy" : "Sell"} ${symbol ?? ""}`;

  return (
    <Panel
      className="h-full"
      title={symbol ? `Ticket · ${symbol}` : "Ticket"}
      actions={
        <span
          title={[
            halted
              ? `CeFi: ${symbol} is ${status?.toLowerCase()}, so the exchange takes no orders on it.`
              : "CeFi: the exchange's book.",
            defi
              ? `DeFi: a market swap of ${defi.symbol} on ${defi.chain ?? "chain"}.`
              : "This book has no DeFi listing.",
          ].join(" ")}
        >
          <Segmented<Venue>
            value={venue}
            onChange={(v) =>
              (v === "DEFI" && !defi) || (v === "CEFI" && halted)
                ? undefined
                : setVenue(v)
            }
            options={[
              {
                value: "CEFI",
                label: <span className={cx(halted && "opacity-40")}>CeFi</span>,
              },
              {
                value: "DEFI",
                label: <span className={cx(!defi && "opacity-40")}>DeFi</span>,
              },
            ]}
          />
        </span>
      }
    >
      {/* Scrolls inside its pane, so the DeFi status card is never cut off. */}
      <div className="h-full space-y-2.5 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-1 rounded border border-line bg-raised p-0.5">
          {(["BUY", "SELL"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={cx(
                "h-7 rounded-[3px] text-xs font-semibold",
                side === s
                  ? s === "BUY"
                    ? "bg-buy text-white"
                    : "bg-sell text-white"
                  : "text-muted hover:text-ink",
              )}
            >
              {s === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>

        {onDefi ? (
          <>
            <p className="text-[11px] leading-relaxed text-muted">
              Market swap on{" "}
              <span className="text-ink">{defi?.chain ?? "chain"}</span>. DeFi
              takes market orders only.
            </p>
            <AmountField
              unit={unit}
              setUnit={setUnit}
              base={baseSymbol}
              value={qty}
              onChange={setQty}
            />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Segmented
                value={type}
                onChange={setType}
                options={[
                  { value: "LIMIT", label: "Limit" },
                  { value: "MARKET", label: "Market" },
                ]}
              />
              {type === "LIMIT" && (
                <Segmented
                  value={tif}
                  onChange={setTif}
                  options={[
                    { value: "GTC", label: "GTC" },
                    { value: "IOC", label: "IOC" },
                  ]}
                />
              )}
            </div>
            {/* Bottom-aligned, so the two inputs line up under labels of different heights. */}
            <div className="grid grid-cols-2 items-end gap-2">
              <AmountField
                unit={unit}
                setUnit={setUnit}
                base={baseSymbol}
                value={qty}
                onChange={setQty}
              />
              <Field label="Limit price">
                <input
                  className={inputClass}
                  value={type === "MARKET" ? "" : price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder={type === "MARKET" ? "market" : "0.00"}
                  disabled={type === "MARKET"}
                  inputMode="decimal"
                />
              </Field>
            </div>
          </>
        )}

        {!onDefi && (
          <label
            className={cx(
              "flex items-center gap-1.5 text-[11px] text-muted",
              type !== "LIMIT" && "opacity-40",
            )}
          >
            <input
              type="checkbox"
              checked={postOnly}
              disabled={type !== "LIMIT"}
              onChange={(e) => setPostOnly(e.target.checked)}
            />
            Post only (ALO)
          </label>
        )}
        {cefiHalted && (
          <p className="text-[11px] leading-snug text-accent">
            {symbol} is {status?.toLowerCase()} on the exchange, so it takes no
            CeFi orders{defi ? "; switch to DeFi to trade it" : ""}.
          </p>
        )}
        {/* Exactly what will be sent, after any USD ↔ quantity conversion. */}
        {sized.describe && (
          <p
            className={cx(
              "text-[11px] leading-snug",
              sized.ok ? "text-muted" : "text-accent",
            )}
          >
            {sized.describe}
          </p>
        )}
        <Button
          tone={armed ? "danger" : side === "BUY" ? "buy" : "sell"}
          size="md"
          className="w-full"
          disabled={!valid || busy}
          onClick={submit}
        >
          {label}
        </Button>
        {live && (
          <p className="text-center text-[10px] text-faint">
            {onDefi
              ? "Live: you confirm the quote before anything trades."
              : "Live: orders are real. Click twice to send."}
          </p>
        )}
        {lastDefi && (
          <DefiStatus
            orderId={lastDefi}
            onClear={() => setLastDefi(undefined)}
          />
        )}
      </div>

      {quote && (
        <DefiConfirm
          quote={quote}
          live={live}
          onClose={() => setQuote(undefined)}
          onExecuted={(id) => {
            setQuote(undefined);
            setLastDefi(id);
          }}
        />
      )}
    </Panel>
  );
}

// The amount input with its unit: USD by default, or a quantity of the asset.
function AmountField({
  unit,
  setUnit,
  base,
  value,
  onChange,
}: {
  unit: SizeUnit;
  setUnit: (u: SizeUnit) => void;
  base: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center">
        <span className="text-[11px] font-medium text-muted">
          {unit === "USD" ? "Amount (USD)" : `Quantity (${base})`}
        </span>
        <span className="ml-auto">
          <Segmented<SizeUnit>
            value={unit}
            onChange={setUnit}
            options={[
              { value: "USD", label: "USD" },
              { value: "QTY", label: base || "Qty" },
            ]}
          />
        </span>
      </div>
      <input
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={unit === "USD" ? "$0.00" : "0.00"}
        inputMode="decimal"
        aria-label={unit === "USD" ? "Amount in USD" : `Quantity of ${base}`}
      />
    </div>
  );
}

// The confirmation step for a DeFi order: what goes in, what is expected out, and the fee, with the
// gateway's warnings. Execute signs the payloads on the server and sends them.
function DefiConfirm({
  quote,
  live,
  onClose,
  onExecuted,
}: {
  quote: DefiQuote;
  live: boolean;
  onClose: () => void;
  onExecuted: (orderId: string) => void;
}) {
  const execute = useDefiExecute();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((quote.expiresAt - now) / 1000));
  const expired = left === 0;
  const inQty = Number(quote.qtyIn);
  const outQty = Number(quote.qtyOut);
  // USDC per unit of the asset, whichever way the swap goes.
  const px =
    quote.side === "BUY"
      ? outQty > 0
        ? inQty / outQty
        : 0
      : inQty > 0
        ? outQty / inQty
        : 0;

  return (
    <Modal
      title={`DeFi ${quote.side === "BUY" ? "buy" : "sell"} · ${quote.assetOut === "USDC" ? quote.assetIn : quote.assetOut} on ${quote.chain ?? "chain"}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone={quote.side === "BUY" ? "buy" : "sell"}
            disabled={!quote.executable || expired || execute.isPending}
            onClick={() =>
              execute.mutate(quote.orderId, {
                onSuccess: () => onExecuted(quote.orderId),
              })
            }
          >
            {execute.isPending
              ? "Sending…"
              : expired
                ? "Quote expired"
                : `${live ? "Execute LIVE swap" : "Execute swap"} (${left}s)`}
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted">You pay</dt>
        <dd className="num text-right text-ink">
          {fmtQty(quote.qtyIn, 6)} {quote.assetIn}
        </dd>
        <dt className="text-muted">You receive ≈</dt>
        <dd className="num text-right font-medium text-ink">
          {fmtQty(quote.qtyOut, 6)} {quote.assetOut}
        </dd>
        <dt className="text-muted">Fee</dt>
        <dd className="num text-right text-muted">
          {fmtQty(quote.fee, 6)} {quote.feeAsset}
        </dd>
        <dt className="text-muted">Price</dt>
        <dd className="num text-right text-muted">
          {px > 0 ? `${fmtPrice(px, 4)} USDC` : "—"}
        </dd>
      </dl>
      {quote.issues.length > 0 && (
        <div className="space-y-1 rounded border border-accent/40 bg-accent-soft px-3 py-2 text-[11px] text-accent">
          {quote.issues.map((i) => (
            <div key={i} className="flex items-start gap-1.5">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {i}
            </div>
          ))}
        </div>
      )}
      {!quote.executable && (
        <p className="text-[11px] text-sell">This quote can't be executed.</p>
      )}
      <p className="text-[11px] leading-relaxed text-faint">
        The amount received depends on the chain at execution and can differ
        from the quote. Getting this quote may have freed funds you had
        allocated to CeFi, to pay for the swap; funds held by open CeFi orders
        are never used.
      </p>
    </Modal>
  );
}

// The most recent DeFi order from this ticket, followed until it completes or fails.
function DefiStatus({
  orderId,
  onClear,
}: {
  orderId: string;
  onClear: () => void;
}) {
  const { data, error } = useDefiOrder(orderId);
  const done = data && isDefiDone(data.status);
  const tone =
    data?.status === "complete"
      ? "text-buy"
      : data?.status === "failed" || data?.status === "canceled"
        ? "text-sell"
        : "text-accent";
  return (
    <div className="rounded border border-line bg-raised px-2.5 py-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="text-muted">Last DeFi order</span>
        <span
          className={cx(
            "flex items-center gap-1 font-semibold uppercase",
            tone,
          )}
        >
          {!done && <LoaderCircle size={11} className="animate-spin" />}
          {data?.status ?? "sent"}
        </span>
        {done && (
          <button
            type="button"
            className="ml-auto text-faint hover:text-ink"
            onClick={onClear}
          >
            Dismiss
          </button>
        )}
      </div>
      {data?.executedQty && Number(data.executedQty) > 0 && (
        <div className="num mt-1 text-ink">
          {data.side === "SELL" ? "Sold" : "Bought"}{" "}
          {fmtQty(data.executedQty, 6)}
          {data.executedVwap ? ` @ ${fmtPrice(data.executedVwap, 4)}` : ""}
          {data.fee ? (
            <span className="text-muted"> · fee {fmtQty(data.fee, 6)}</span>
          ) : null}
        </div>
      )}
      {data?.failureReason && (
        <div className="mt-1 text-sell">{data.failureReason}</div>
      )}
      {error && <div className="mt-1 text-sell">{error.message}</div>}
      {data?.explorerUrl ? (
        <a
          className="mt-1 inline-flex items-center gap-1 text-info hover:underline"
          href={data.explorerUrl}
          target="_blank"
          rel="noreferrer"
        >
          View transaction <ExternalLink size={11} />
        </a>
      ) : data?.txHash ? (
        <div className="num mt-1 truncate text-faint" title={data.txHash}>
          tx {data.txHash}
        </div>
      ) : null}
    </div>
  );
}
