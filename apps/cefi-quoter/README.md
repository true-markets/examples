# CeFi Quoter

A market maker for the True Markets CeFi exchange, written to be read. One process quotes **as many books as you add**, and every book draws on **one shared view of the account's balances**, so two books never spend the same USDC. For each book it quotes a ladder of post-only bids and asks around a reference price, keeps them in place with **modifies**, crosses the spread to get out of inventory when the exchange's book pays for it, and follows every order on the WebSocket **drop copy**. Books are added, started, stopped and tuned while it runs from a small management API, which the [CeFi Console](../cefi-console/) puts a screen on.

It runs without an API key in **paper mode**: a simulated exchange priced off live market prices (Coinbase for crypto, Hyperliquid for tokenized stocks), so you can watch it quote, fill and manage inventory before any real money is involved.

> [!WARNING]
> - **With an API key, every order is real.** There is no sandbox on production. Use `TM_ENV=uat` (the default in `.env.example`) until you trust your settings.
> - **A market maker loses money to faster traders.** Your quotes fill exactly when the market moves through them. Spread, skew and the max position change are how you get paid for that risk; paper mode shows you how much of it there is.
> - **Run it on your own machine.** The management API listens on 127.0.0.1 and changes how your money is quoted. It refuses any other address unless you set `ADMIN_TOKEN`.

## Run it

You need Go 1.25 or newer (`brew install go`, or [go.dev/dl](https://go.dev/dl/)).

```bash
cp .env.example .env
```

```bash
go run .
```

With no key it starts in paper mode with 10,000 USDC, 0.05 BTC, 1 ETH and 20 SOL (`PAPER_BALANCES`), and offers BTC-USDC, ETH-USDC and SOL-USDC. It starts with no books. Add one from the console's Quoter screen (next section), or:

```bash
curl -X POST http://127.0.0.1:4860/api/books -d '{"symbol": "BTC-USDC"}'
```

A new book starts stopped, showing the ladder it would quote. To start every book:

```bash
curl -X POST http://127.0.0.1:4860/api/start
```

The books you add, and each book's settings, are saved to `books.json` and come back on the next start, stopped (or quoting, with `QUOTER_AUTOSTART=true`).

Ctrl-C cancels every order on every book and waits for the exchange to confirm before it exits.

### Watch it from the CeFi Console

In `../cefi-console`, add the quoter's address to `.env`, then start the console as usual:

```bash
echo QUOTER_URL=http://127.0.0.1:4860 >> .env
```

```bash
npm run dev
```

A **Trading | Quoter** switch appears in the header. The Quoter screen has:

- **Books**: every book, with its state, orders, position (in the asset and in USD) and PnL. Amounts in the quote currency are shown as USD, whichever dollar stablecoin it is. Pick one from the list of books the exchange offers to add it, then set up its reference sources with a live preview (see [Reference prices](#reference-prices)). **Start all** and **Stop all** act on every book.
- **Shared balances**: the ledger every book draws on, in USD with quantities under them: **Balance** (your CeFi balance), **Trading** (held by the quoter's orders), **Unused** (what's left for new orders), and **Other orders** when orders the quoter didn't place hold funds. Sortable and filterable.
- For the selected book: its state and the reason for it, the ladder (where each order rests next to where the strategy wants it), position and PnL, its budget, activity, an event feed, and a field for every parameter. Change one, press **Apply**, and the book uses it on its next cycle; it's saved to `books.json` too. **Start quoting** asks for confirmation on production. **Stop and pull quotes** cancels that book's orders. A stopped book with nothing resting can be removed.

### Going live

1. Create an API key at [app.truemarkets.co](https://app.truemarkets.co) (Settings, API keys) on an account enabled for CeFi trading. The browser downloads a JSON file with `key_id` and a P-256 `private_key`.
2. Move it into `.secrets/` (gitignored). With a key there, the quoter runs live.
3. Allocate the funds you want quoted to CeFi. The console's Balances panel does this.
4. Set `TM_ENV` (`uat` or `production`).
5. Start it and add books on the Quoter screen. The list is every active instrument on the exchange. Give each book a `quoteSize` that clears the exchange's $1 minimum at its price (the screen warns when it doesn't), and when several books share a quote asset, a `maxQuoteAlloc` each (see below).
6. Check each preview ladder, then press **Start quoting**.

On start-up it cancels any orders an earlier run left on any book (recognized by the `cq` prefix on their client order ids), so a crash never leaves quotes it can't see.

### FIX instead of REST

Most people should quote over REST. FIX is there for firms that already run FIX, and it brings one real advantage: **cancel on disconnect**. If the session drops, the exchange pulls every order the session placed. REST has no equivalent.

```bash
ORDER_TRANSPORT=fix
FIX_ADDR=host:port          # from support@truemarkets.co; FIX runs over a private connection
FIX_TLS=false               # the default: plain FIX, not TLS
FIX_SENDER_COMP_ID=yourfirm-mm1
FIX_TARGET_COMP_ID=...      # assigned by the exchange
```

The connection is plain FIX over TCP, not TLS: the private network is what protects it. If the server logs "Received data that is not a FIX message" and drops you, the quoter is speaking TLS to it; check `FIX_TLS=false`. Every book shares one FIX session; each order names its symbol. The session uses the same API key file as REST. The Logon carries your `key_id` as Username (553) and, as Password (554), an ES256 signature over `SendingTime + MsgType + MsgSeqNum + SenderCompID + TargetCompID + Username` ([fix/session.go](fix/session.go)). Only order entry moves to FIX. Order state still comes from the WebSocket drop copy, so the rest of the quoter can't tell the difference.

## How it works

```
                      ┌───────────────────────── cefi-quoter ─────────────────────────┐
                      │  desk: routes each message to its book                        │
 Coinbase/HL/Kraken ─▶│   ┌─ book BTC-USDC ─────────────────────────────┐             │
  (one connection,    │   │ reference ─▶ ladder ─▶ plan ─▶ reserve ─▶ send ──REST/FIX──▶ exchange
   every product)     │   │ EBBO, drop copy ─▶ order book, position      │   ▲         │
 CeFi WS: EBBO ──────▶│   └──────────────────────────────────────────────┘   │         │
 CeFi WS: DROPCOPY ──▶│   ┌─ book ETH-USDC ── (the same) ──────────────────┐ │         │
                      │   └────────────────────────────────────────────────┘ │         │
                      │                                                      │         │
 GET /balances ──────▶│   ledger: one view of the balances for every book ───┘         │
  (every 10 s)        │                                                                │
                      └────────────────────── management API :4860 ────────────────────┘
                                                    ▲
                                         CeFi Console / curl
```

Each book runs its own loop. Every cycle, which runs on each reference tick, drop copy or parameter change and at least every 250 ms:

1. **Fair value.** The book's reference mid ([reference/](reference/)). A market maker needs a price from somewhere deeper than the book it quotes into; [Reference prices](#reference-prices) says where each book's comes from.
2. **Skew.** Holding inventory shifts the mid toward getting flat: long means a lower mid, so the asks fill more readily than the bids. Scaled by `position / MAX_POSITION`, up to `SKEW_BPS`.
3. **Ladder.** Level *i* sits `SPREAD_BPS × LEVEL_SPREAD_MULT^i` from the mid, sized `QUOTE_SIZE × LEVEL_SIZE_MULT^i`, rounded to the exchange's tick and lot. Sizes are capped inside out by the max position change and the budget, so the inner levels get funded first ([quoter/ladder.go](quoter/ladder.go)).
4. **Plan.** Compare the ladder with the orders resting and work out the fewest requests that close the gap ([quoter/plan.go](quoter/plan.go)). That is the part worth reading closely, and the next section explains it.
5. **Reserve and send**, one request at a time. Before a new order or a modify goes out, it takes its funds from the shared ledger, so a book never sends an order another book has already spent the money for ([Many books, one balance](#many-books-one-balance)).

### Modify, don't cancel and replace

The quoter prefers modifying an order in place (`PATCH /v1/cefi/orders`, or a FIX OrderCancelReplaceRequest) to canceling it and placing a new one:

- **It keeps the funds held.** The exchange re-sizes a modified order's hold in place. Cancel-then-new releases the hold and then needs it back, and the new order can reach the exchange before the cancel has freed anything. When you quote with nearly all of your balance, that new order is rejected for insufficient balance, and the level goes dark until the next cycle. A modify never has that window.
- **It's half the traffic.** One request and one drop copy instead of two of each, against the same rate limit.
- **The order keeps its identity.** Same client order id, so nothing has to re-learn which order is which.

The order of the requests matters as much as the kind. A plan goes out as cancels first, then modifies that hold the same or less, then modifies that hold more, then new orders. Every request that needs funds therefore comes after the ones that release them. Within each group, moves away from the spread go before moves toward it. Every price is also clamped one tick inside our own nearest order on the other side, and inside the exchange's best price on the other side, so a post-only quote is never sent at a price where it would be rejected.

`paper/exchange_test.go` shows the difference in a few lines: with the whole balance on one bid, moving it with a modify works, and placing a second order does not.

### Staying under the rate limit

The exchange's order checks hold each account to a number of orders **per second** and a number **per minute** (100 and 2,000 on production; `ORDER_RATE_LIMIT` and `ORDER_RATE_LIMIT_PER_MIN` default to 90 and 1,800). Each is a fixed window that opens with the first request after the last one ran out. New orders and modifies count; cancels don't, and are never refused for the rate. A request the minute limit refuses doesn't count toward it, so once the minute is spent, every new order and modify is refused until that window ends, up to a minute later.

Every book shares one budget to match (`quoter/pacer.go`): no more than `ORDER_RATE_LIMIT` new orders and modifies in any one second and `ORDER_RATE_LIMIT_PER_MIN` in any one minute, counted back from each send. A rolling window never holds more than a fixed one of the same length, so staying under it keeps the exchange's count under too, however its windows line up. Leave some room under the exchange's numbers: requests spaced out here can still arrive bunched together. A book that runs out mid-round stops there and plans again on its next cycle, with fresh prices, rather than queueing requests that would be stale by the time they went out. Cancels always go out, so stopping a book pulls its quotes at once even with the budget spent.

Both limits can be changed while the quoter runs (`PATCH /api/settings`, or **Quoter settings** at the top of the console's all-books parameter editor). They take effect at once and are saved under `"settings"` in the books file, where they win over `.env` on the next start.

If the exchange rejects a request for its rate limit anyway ("Rate limit exceeded" over FIX, a 429 over REST), every book stops sending new orders and modifies for a second, and its state reads "rate limited". Resting quotes stay where they are. Another rate-limit reject within 30s of the last pause doubles it, up to 30s, long enough for the exchange's minute to run out. Rejects for requests already on the wire land during the pause and neither extend it nor fill the events: each pause is one event.

Each pause counts as one hit on the book whose request set it off (`rateLimitPauses` in its stats), and every request refused counts in `rateLimited`. Both carry across restarts with the rest of the activity. `GET /api/status` also reports `idPrefix`, the client order id prefix on every quoter order, so other tools can tell its orders apart; it adds the rate-limit counts up in `totals` and gives the pacer's limits (`perSec`, `perMin`), the new orders and modifies sent in the last second and minute (`used`, `usedMin`), the most in any second over the last minute (`peak`), any pause running and the last hit this run in `rateLimit`; the Quoter screen shows them in the Activity bar and each book's Activity card. `POST /api/books/{symbol}/reset-rejects` (or **Reset rejects** on the book's Activity card) starts one book's reject, error and rate-limit counts from zero; `POST /api/reset-rejects` (or **Reset rejects** on the Activity bar) does every book and forgets the last hit. Nothing else is reset.

### Taking: getting unstuck

Resting quotes alone can jam a book. A move fills one side up to the max position change, that side stops quoting, and the position only comes back when someone trades against the other side's quotes. So each book has two takers that cross the spread with an IOC (immediate or cancel) order when the exchange's book pays for it. Both are ported from the internal Python quoter ([quoter/taker.go](quoter/taker.go)):

- **Profit taker (on by default).** While long, it sells into the best bid; while short, it buys the best ask, when that price beats the skewed mid by enough. "Enough" starts at `TAKE_EDGE_BPS` and falls toward `TAKE_FLATTEN_FLOOR_BPS` as the position nears the max position change: a full book gets out readily, a nearly flat one waits for a good price. It never closes below what the position cost, after the taker fee. Getting flat isn't worth booking a loss, so an underwater position is left for the ladder's quotes to work off.
- **Takeout (off by default).** It crosses to build a position when the book sits at least `TAKE_EDGE_BPS` past fair value, betting the dislocation closes. Past half the max position change it needs more edge and takes less, and it stops at 90%, so there's always room left for the ladder and for getting out.

All take edges are measured against the skewed mid, net of `TAKER_FEE_BPS`. They count only other people's orders: if our own quote is the best price, it's subtracted, so a take never trades with ourselves. A take is sized to the least of what the book shows, `TAKE_MAX_SIZE`, the room under the max position change (a profit take stops at flat) and what's free. It reserves its funds from the shared ledger like any order. If a profit take has the edge but the book's own quotes on that side hold everything, it cancels the outermost quote first and takes on the next cycle. One take is in flight at a time, at most one per `TAKE_COOL_DOWN_MS`. Takes show on the Quoter screen's Activity card and in the event feed.

In paper mode the exchange's best bid and offer are the reference's, with its sizes, so takes fill against the live Coinbase or Hyperliquid book. Because that's the same book the quoter prices from, takes are rare there unless you lower the take edge. Live, they fire when the CeFi book moves away from the reference.

Left out of the port: the momentum taker (retired in the Python quoter: it made 1–3 bps gross against 6–10 bps of taker cost), takes against our own ladder's targets, mark-out learning and the regime gates.

### Trades and edge retention

Every fill goes in a journal ([quoter/journal.go](quoter/journal.go)) with its **edge at fill**: how far the price was from fair value (the reference mid) in your favor, in bps. The same measure is taken again 30 seconds and 5 minutes later; those are the **mark-outs**. A maker is filled exactly when the market moves through its quote, so the mid often keeps going. A fill with +10 bps of edge that marks out at −5 bps was a loser, however good it looked when it happened. That's adverse selection, and it's what the spread has to pay for. **Kept** is the mark-out over the edge at fill: 100% means the edge held, and below 0 means the market took all of it and more. It's left blank when the edge at fill is under 1 bps, where the ratio means nothing. A fill that came in while the book had no reference price has no edge to measure; it shows — and is left out of the averages.

The Quoter screen's Trades view shows every fill with its mark-outs, and a summary per book and across all books, weighted by notional. Watch it when you change the spread: a wider spread earns more edge at fill, and the mark-outs show how much of it survives. The journal is saved in the state file, so it survives a restart.

### Following orders: the drop copy

`DROPCOPY` on the CeFi WebSocket sends the full state of one of your orders every time it changes. The quoter treats it as the only source of truth:

- **Requests are recorded before they're sent.** The drop copy for a request can arrive before the request's own HTTP response, so state set after the call can overwrite an answer that already came in ([quoter/orders.go](quoter/orders.go)).
- **One request per order in flight.** While an order waits for an answer, nothing else is sent for it. In a fast market that costs one round trip of reaction time. In exchange, there is never any doubt about which answer belongs to which request.
- **A fill is growth in `executed_qty`**, not the `trade_qty` field, so a repeated message can't count a fill twice.
- **Nothing is polled that the WebSocket already sends.** Orders are read over REST only on start-up, after the drop copy reconnects, and if a request goes 5 seconds without an answer. Balances are the exception, because the WebSocket has no balance channel: they're read every 10 seconds, preferably while nothing is in flight, and fills are debited locally in between.

The budget for each side is the free balance plus what the book's own orders already hold, because a modify reuses its order's hold. Bids keep 0.5% of the quote back as headroom for fee holds.

### Reference prices

Each book's fair value is a **blend**: a weighted average of one or more sources, each lined up with a multiplier ([reference/blend.go](reference/blend.go)). A new book starts from its listing's default:

| Book | Default reference | Example |
| --- | --- | --- |
| Crypto | Coinbase Exchange's ticker for the base asset in USD | BTC-USDC prices off `BTC-USD` |
| Tokenized stock | Hyperliquid's perp on the stock, on its `xyz` equities dex | GOOGLC-USDC (Alphabet) prices off `hyperliquid:xyz:GOOGL` |

Coinbase Exchange lists no stocks, so a stock book can't use the crypto default. The quoter asks the public asset catalog (`GET /v1/gateway/assets?asset_class=stock`, no key) which listings are tokenized stocks, then takes the ticker from the issuer's naming rule, read from the listing's slug. Coinbase tokenized stocks drop a trailing C (GOOGLC to GOOGL). Robinhood tokens are the ticker itself (NVDA). A stock from any other issuer has no default; name its reference when you add it.

Why Hyperliquid: real-time quotes on the stock itself need an account or come 15 minutes late. Hyperliquid's equity perps are keyless, pushed every block, open 24/7 and deep. The cost is that a perp's mid carries its funding premium, usually a few bps, which this quoter doesn't remove.

#### Several sources

One source is a single point of failure, and a thin one is easy to push around: whoever moves it moves your quotes. A blend checks every source against the others. Sources, all keyless and streamed:

| Source | Name | Quotes |
| --- | --- | --- |
| Coinbase Exchange | `BTC-USD` | crypto spot |
| Hyperliquid, any dex | `hyperliquid:BTC`, `hyperliquid:xyz:GOOGL`, `hyperliquid:io:NVDA` | perps on crypto and, on the HIP-3 dexes, on stocks |
| Kraken | `kraken:BTC/USD`, `kraken:GOOGLx/USD` | crypto spot, and xStocks (Backed's tokenized stocks) |

The quoter suggests every source it finds for a book's underlying (`GET /api/references/{symbol}/suggest`). A Kraken pair that's post-only (orders rest, nothing matches, so the price is only indicative) is suggested at weight 0. How the blend works:

- **Weights.** *Fixed* uses each source's weight as set; *by depth* multiplies it by the dollars shown at the source's touch, so a deeper market counts for more. Weight 0 **watches** a source: it's shown and checked, but doesn't move the price.
- **Outliers are left out.** Each source is measured against the median of the others (with two, against the other one). One further than the **max deviation** (100 bps by default) drops out of the price until it comes back, and the book's event feed says so. If the sources can't agree at all, or every one is stale, the book stops quoting rather than guess.
- **Stale sources drop out** after `REF_STALE_MS` of silence, or a minute with no price change (a closed market's last price, repeated).

#### Multipliers and corporate actions

Every source quotes something slightly different. A perp tracks the share price. A tokenized stock is one token, and an issuer may define that as more or less than one share: after a split some issuers change the shares per token rather than the number of tokens, and some pay dividends as more shares per token. Providers apply these on different days, or not at all. So:

- each source's **multiplier** turns its price into the price of one share (1 unless it quotes something else; a token worth 1/10 of a share has 10);
- the book's **token multiplier** turns the price of a share into the price of one token of the book you quote.

A multiplier that should be set but isn't shows up as a source sitting a fixed ratio from the others, so the blend looks for exactly that. A ratio near a split ratio (2, 3, 4, 10, 1/2, …) is flagged as a **likely split**. Anything else out of line is flagged as a **likely multiplier**. Each flag comes with the multiplier that would line the source up. A smaller gap that's held (25 bps or more) is noted as **drift**: normal for a perp's funding premium, but if it lasts for days it's more likely dividends accruing in a token's multiplier.

The **reference guard** (`REF_GUARD_BPS`, 500 by default) catches what the sources can't: the book you're quoting into trading far through the blend. That covers a bid well above it or an ask well below, as when your token takes a split or multiplier your sources haven't. Someone crossing that far is more likely right about the price than handing out money, so the book stops quoting until the gap closes or you fix the reference.

The exchange runs a check of its own: it refuses orders more than a set percentage (5% today) from its own reference price for the book, with "Order outside book price bands". When your reference and the exchange's disagree by more than that, as when a stock gaps pre-market and the exchange's price hasn't caught up, every order on one side is refused and the quoter keeps sending them. Set the **band reject limit** (`BAND_REJECT_LIMIT`) to stop the book after that many band rejects within a minute; it pulls the book's quotes and stays stopped until you start it again.

#### Setting one up

On the Quoter screen, **Add…** opens the reference editor, filled with the suggested sources. **Edit…** on a book's Reference sources card opens the same editor. It previews every change against live prices before anything is saved, showing:
- each source's bid and ask and its adjusted price;
- its spread and depth, and its gap to the others;
- its share of the blend, and any corporate-action flag, with a button that applies the suggested multiplier.

Under the sources it shows the blended price per share, times the token multiplier, giving fair value. For a book that's already added, it also shows the book's own mid on True Markets, with the token multiplier that would line them up.

The same works over the API:

```bash
curl http://127.0.0.1:4860/api/references/GOOGLC-USDC/suggest
curl -X POST http://127.0.0.1:4860/api/references/GOOGLC-USDC/preview -d '{"sources": [
  {"ref": "hyperliquid:xyz:GOOGL", "weight": 2}, {"ref": "kraken:GOOGLx/USD", "weight": 1}]}'
curl -X PUT http://127.0.0.1:4860/api/books/GOOGLC-USDC/reference -d '{"sources": [...], "weighting": "depth",
  "maxDeviationBps": 100, "tokenMultiplier": "1"}'
```

Every source is checked with its provider before it's used, so a typo is refused instead of leaving the book with no price. Sources you preview stay subscribed until the quoter restarts.

### Many books, one balance

Run two separate quoters on BTC-USDC and ETH-USDC and each reads the account's 10,000 USDC, sizes its bids against all of it, and sends. The exchange takes whichever orders arrive first and rejects the rest for insufficient balance. Each quoter learns about the other's orders only at its next balance read, by which time it has already sent more. That is the race this design removes.

One process runs every book, and every book draws on one [`Ledger`](quoter/ledger.go):

```
free = spendable - foreign holds - our holds now
```

- **spendable** is the last `GET /balances`, less transfer holds and anything leaving at settlement, less what fills have spent since. One read serves every book.
- **foreign holds** are whatever the exchange held at that read that wasn't ours: orders you placed from the console, or another program on the same account. They count until a read shows them gone.
- **our holds** are summed live from every book's orders. When a cancel is confirmed its funds are free for any book at once, not at the next read.

Before a book sends a new order or a modify, it calls `Ledger.Reserve`. That hands the book the free balance (within the book's allocation) under one lock, and the book registers its order before the lock is released. The next book to ask already sees that money as held. If another book took some of it since this cycle's ladder was built, the order goes out smaller, or waits for the next cycle. It is never sent only to be rejected.

`maxQuoteAlloc` and `maxBaseAlloc` divide a shared asset between books. Without them, whichever book asks first can take all of it, and the Quoter screen warns when two running books share an asset and one has no allocation. `TestBooksShareOneBalance` in [quoter/engine_test.go](quoter/engine_test.go) runs two books against a fake exchange that rejects any overspend, with barely enough USDC for one ladder. It passes with no rejections, and fails when the reservation is taken out.

### Restarts: the state file

Each book's position, average cost, PnL, volume, activity counts and recent events carry across restarts, and so does the trade journal. They live in a state file, one per environment: `state.production.json`, `state.uat.json` or `state.paper.json` (`QUOTER_STATE_FILE` to put it elsewhere). The quoter writes it every two seconds when something changed, and once more on shutdown, in one step so a crash never leaves half a file. Settings stay in `books.json`. The state is about what happened; the books file is about what you want.

- **The position counts from a point you choose.** Each book's Position card says since when: its first start, or the last time you pressed **Reset** (`POST /api/books/{symbol}/reset`). The max position change is measured from there. Reset starts the position, PnL, volume and counts from zero. It trades nothing, changes no balance, and leaves the trade journal alone.
- **A crash doesn't lose fills.** A clean shutdown pulls every quote first, so nothing can fill while the quoter is down. A crash (or `kill -9`) can leave quotes resting, and they can keep filling until the next start cancels them. The state lists what each book had resting and how much of each order had filled. On the next start, after those orders are canceled, the quoter reads the exchange's recent order history. Whatever filled since the save goes into the position, priced at the order's last price (what a resting post-only order trades at). The log, the event feed and the trade journal mark these fills as filled while the quoter was down. They're left out of the edge averages, since there was no fair value at the time to measure them against.
- **Mark-outs that came due while it was down stay empty.** The price at that moment is gone, and marking late would be wrong. Ones still to come are taken as usual.
- **Each book waits for its reference sources.** They connect one at a time and rarely agree to the bps, so for the first 10 seconds a book with a blend waits for every weighted source to report before it prices off the ones that have. Quoting around the first source alone gets picked off as the rest arrive.
- **Paper mode carries its account too.** `state.paper.json` keeps the paper balances, so restored positions still match them. `PAPER_BALANCES` only sets the balances the first time.
- **It belongs to one account.** A state file from another client is refused at start, rather than overwritten. Books start stopped, as always, unless `QUOTER_AUTOSTART` is on.

To start everything from zero, stop the quoter and delete the state file.

### When it stops quoting

The state on the Quoter screen always says why. A book pulls its quotes when you stop it, when the drop copy or market data disconnects (it would be quoting blind), when the reference feed has said nothing about its product for `REF_STALE_MS`, or when its price hasn't changed for a minute. Coinbase's ticker only publishes on trades and Hyperliquid's bbo only when the touch moves, so a quiet market's price can be seconds old while its feed is healthy; each source's per-product heartbeat is what counts as alive. It holds its quotes, without adding to them, while it waits for balances, reads its orders back after a reconnect, or waits out a [rate-limit pause](#staying-under-the-rate-limit).

## Settings

Everything goes in `.env`; [.env.example](.env.example) lists all of it with comments. The strategy settings below are what a newly added book starts with. Each book then has its own copy, changed live on the Quoter screen or with `PATCH /api/books/{symbol}/params`, and saved in `books.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `SPREAD_BPS` | 10 | First level's distance from the mid, each side |
| `LEVELS` | 3 | Orders per side |
| `LEVEL_SPREAD_MULT` | 1.5 | Each level out is this many times the previous spread |
| `SIZE_UNIT` | quote | What the sizes below are in: `quote` (USDC, converted to the base asset at the reference price every cycle) or `base` (each book's base asset) |
| `QUOTE_SIZE` | 10 | First level's size, in `SIZE_UNIT`. It has to cover at least one lot (the exchange's quantity step) and $1: on BTC near $60,000 one lot is 0.0001, about $6 |
| `LEVEL_SIZE_MULT` | 1 | Each level out is this many times the previous size |
| `MODIFY_THRESHOLD_BPS` | 2 | Leave an order alone until its target moves this far. Keep it under the spread |
| `MAX_POSITION` | 100 | **Max position change**: how far a book may move your holdings from where they were when it started counting (bought minus sold since then), long or short, in `SIZE_UNIT`. A side stops quoting at the limit. The count carries across restarts until you reset the book's position. 0 turns the limit and skew off |
| `SKEW_BPS` | 5 | Mid shift back toward where you started, at the max position change |
| `MAX_QUOTE_ALLOC` | 0 | Most quote this book's bids may hold (USDC, so already dollars); 0 means any free balance. Set one per book when books share a quote asset |
| `MAX_BASE_ALLOC` | 0 | Most of the base asset this book's asks may hold, in `SIZE_UNIT`; 0 means any free balance |
| `REF_STALE_MS` | 3000 | Leave a reference source out after this long silent; pull quotes when every source is |
| `REF_GUARD_BPS` | 500 | **Reference guard**: stop quoting while other people's orders on the book sit this far past the reference (a bid this far above it, an ask this far below). 0 turns it off |
| `BAND_REJECT_LIMIT` | 0 | **Band reject limit**: stop the book and pull its quotes after this many orders are rejected for the exchange's price band within a minute. 0 turns it off |
| `MIN_REQUOTE_MS` | 100 | Smallest gap between rounds of order changes |
| `PROFIT_TAKER` | true | Cross to close inventory when the book pays at least the (scaled) take edge, never below cost |
| `TAKEOUT` | false | Cross to build inventory when the book sits at least `TAKE_EDGE_BPS` past fair value |
| `TAKE_EDGE_BPS` | 25 | Net edge over the skewed mid, after the taker fee, a take needs |
| `TAKE_FLATTEN_FLOOR_BPS` | 2 | The least edge a profit take accepts, reached at the max position change |
| `TAKE_MAX_SIZE` | 20 | Largest single take, in `SIZE_UNIT` |
| `TAKE_COOL_DOWN_MS` | 3000 | Least time between two takes on a book |
| `TAKER_FEE_BPS` | 0 | Your taker fee. Every take edge is counted after it; the published CeFi schedule is 0 |

Sizes in USDC are the easy default: one set of numbers works on any book, from BTC to a $270 tokenized stock, and a $10 level stays $10 as the price moves. The exchange still sizes orders in the base asset, so each level is rounded down to the book's lot: $2.18 of GOOGLC at $272 is 0.008, which the 0.001 lot leaves as 0.007 ($1.91). Each book has its own **Sizes in** switch at the top of its parameters on the Quoter screen; flipping it converts that book's sizes at the current reference price. Books saved before this setting existed keep their sizes in the base asset.

Position and PnL count each book's fills at average cost, from the book's first start or its last reset, across restarts ([the state file](#restarts-the-state-file)). The position is the change in your holdings, not the holdings themselves, and the max position change bounds it on each side.

`books.json` (`QUOTER_BOOKS_FILE`) can also be written by hand. A setting a book leaves out comes from `.env`:

```json
{
  "books": {
    "BTC-USDC": { "params": { "sizeUnit": "quote", "quoteSize": "20", "maxPosition": "500", "maxQuoteAlloc": "4000" } },
    "ETH-USDC": { "reference": "ETH-USD", "params": { "sizeUnit": "base", "quoteSize": "0.005", "maxQuoteAlloc": "4000" } },
    "GOOGLC-USDC": { "blend": { "sources": [
      { "ref": "hyperliquid:xyz:GOOGL", "weight": 2 },
      { "ref": "kraken:GOOGLx/USD", "weight": 1, "multiplier": "1" }
    ], "tokenMultiplier": "1" } }
  }
}
```

A book with neither `reference` nor `blend` uses its listing's default; `reference` is a blend of that one source.

## Management API

```bash
curl http://127.0.0.1:4860/api/status                    # every book, totals, shared balances, connections, books on offer
curl http://127.0.0.1:4860/api/trades?limit=100          # fills this run, newest first, with edge at fill and mark-outs
curl -X POST http://127.0.0.1:4860/api/books -d '{"symbol": "ETH-USDC"}'   # add a book, stopped ("reference" optional)
curl http://127.0.0.1:4860/api/books/ETH-USDC            # one book: ladder, orders, position, events, reference sources
curl http://127.0.0.1:4860/api/references/ETH-USDC/suggest   # reference sources found for the book
curl -X POST http://127.0.0.1:4860/api/references/ETH-USDC/preview -d '{"sources": [...]}'   # a blend on live prices, not saved
curl -X PUT http://127.0.0.1:4860/api/books/ETH-USDC/reference -d '{"sources": [...]}'      # change the book's blend
curl http://127.0.0.1:4860/api/books/ETH-USDC/params     # its settings, and a schema describing each one
curl -X PATCH http://127.0.0.1:4860/api/books/ETH-USDC/params -d '{"spreadBps": 15, "levels": 2}'
curl -X POST http://127.0.0.1:4860/api/books/ETH-USDC/start
curl -X POST http://127.0.0.1:4860/api/books/ETH-USDC/stop   # stop one book and pull its quotes
curl -X DELETE http://127.0.0.1:4860/api/books/ETH-USDC  # remove a stopped book with nothing resting
curl -X POST http://127.0.0.1:4860/api/start             # start every book
curl -X POST http://127.0.0.1:4860/api/stop              # stop every book and pull every quote
```

With `ADMIN_TOKEN` set, add `-H "Authorization: Bearer $ADMIN_TOKEN"`, and give the console the same value as `QUOTER_TOKEN`. The schema comes from the `param` tags on the `Params` struct ([quoter/params.go](quoter/params.go)). Add a field there and it shows up on the Quoter screen with no console change.

## Project structure

```
main.go            start-up: live or paper, feeds, management API, shutdown
config.go          .env and environment variables
books.go           books.json: the books to quote and their settings
tm/                True Markets: key file and ES256 signing, tokens, CeFi REST, CeFi WebSocket
fix/               a small FIX 5.0 SP2 order-entry session (no QuickFIX, no config files)
reference/         reference prices: Coinbase, Hyperliquid and Kraken feeds, and blends of them
  blend.go         weighted average, outliers, multipliers, corporate-action detection
quoter/
  desk.go          every book in the process: adds and removes them, routes feeds, reads balances
  ledger.go        the balances every book shares, and Reserve
  ladder.go        reference price -> target bids and asks
  taker.go         when to cross the spread: the profit taker and takeout
  plan.go          targets + resting orders -> creates, modifies, cancels, in a safe order
  orders.go        our orders, moved only by the drop copy
  engine.go        one book's loop, position, what to do when something is down
  transport.go     REST and FIX behind one interface
paper/             the simulated exchange for paper mode
admin/             the management API
```

## Tests

```bash
go test ./...
```

No test touches the network. The engine runs against a fake exchange that answers each request with the drop copy the real one would send, and the FIX session runs against a fake FIX server on localhost.

The profit taker and takeout came over too ([Taking](#taking-getting-unstuck)). Left out on purpose, because each is a strategy of its own and they obscure the core loop: the momentum taker, volatility- and imbalance-driven spreads, multi-maker scenarios and the terminal UI. Each would plug in as another input to `BuildLadder` or another kind of `Step`.
