# Kumi

Kumi is a demo app for a wealth advisor on True Markets rails. An advisor signs in, adds clients and places a market buy or sell of SOL or another top Solana token for one client. Each client has two wallets: a client wallet, which Kumi creates and holds, and a trading wallet, which is a True Markets gateway user with its own wallet. For a trade, Kumi moves only the amount needed into the trading wallet, trades on-chain through the gateway, and sends the proceeds straight back to the client wallet.

Kumi uses the True Markets gateway exactly the way any outside client would. Its server holds an organization API key and one signer key, maps each client to a gateway user, and makes every True Markets call on that client's behalf. The browser only ever talks to Kumi's own server and never sees a True Markets credential or a wallet key. The same model fits any platform that runs its own custody, such as a wallet provider.

> [!WARNING]
> - **These are real funds and there is no sandbox.** Every move, trade and transfer happens on Solana mainnet through https://api.truemarkets.co.
> - **Run it on your own machine only.** The demo login is public and there is no rate limiting or HTTPS, so never expose the port to a network.
> - **Back up `data/wallet-signer-key`.** Kumi creates it on first start, and it signs for every client's trading wallet. Lose it and every trading wallet it seated is locked for good.
> - **Back up `data/safekeeping-keys/`.** It holds each client's wallet key, one file per client. Lose a file and you lose the funds in that client wallet.
> - **An organization allows 5 clients, and none can be deleted.** Each client takes one of the organization's 5 gateway users for good. To go past the limit, use an API key from a new organization: Kumi then shows only that organization's clients and keeps the old ones on disk.
> - **Start small.** SOL and JUP were tested live; the other tokens use the same code path but were not. A failed trade stops and leaves the funds where they are, and Wallets on the client page has a button that moves them back.

## Requirements

- Node 22 or newer with npm, or Docker with Compose.
- A True Markets organization with an API key downloaded from the developer console (a JSON file).

## Setup

1. Move the API key you downloaded from the developer console into `.secrets/`. Everything in that folder is gitignored and kept out of the Docker image, and Kumi finds the key on its own. To keep it somewhere else, set `TM_API_KEY_PATH` to the file.
2. That is all. Kumi talks to https://api.truemarkets.co and Solana mainnet, creates the wallet signer key and the advisor login on first start, and reads your organization id from the API key's token.

Optional settings go in a `.env` file next to `package.json`:

| Variable | Default | What it does |
| --- | --- | --- |
| `TM_TOKENS` | `SOL,JUP,BONK,WIF,PYTH,RAY,JTO,RENDER,PENGU,TRUMP,W,ORCA,HNT,DRIFT` | Tokens offered for trading, as Solana symbols. Each must be listed as tradeable by True Markets. |
| `SOLANA_RPC_URL` | the public mainnet endpoint | The public endpoint rate-limits; set your own provider's URL if you see read errors. |
| `PORT` | `4848` | The port the server listens on. |
| `DATA_DIR` | `data` | Where Kumi keeps its state: `advisors.json`, `households.json`, `trades.json`, `safekeeping-keys/`, `session-secret` and `wallet-signer-key`. Delete it to start over, but only once no wallet it created holds funds. |

## Run

Three steps, with no Docker:

```sh
npm install
npm run dev
```

Then open http://localhost:5180. `npm run dev` first checks your setup and says what is missing in plain words: the Node version, the API key, a busy port, or a bad RPC setting. `npm run doctor` runs the same checks on their own. The server listens on port 4848 and the web app proxies `/api` to it, and the proxy follows `PORT` if you change it in `.env`. `npm run build && npm start` serves everything from one port, 4848.

With Docker, if you want the same environment on every machine and nothing installed on yours:

```sh
docker compose up --build
```

Open http://localhost:4848. Compose mounts `.secrets/` read-only and keeps state in `./data`, so your keys survive a restart. The container reports its health, and `docker compose logs -f` shows what it is doing.

Sign in with the demo login, which the sign-in form fills in for you: `hana.sato@kumi.example` / `kumi-demo`.

## Funding a client

A new client starts empty. Its page shows the safekeeping address with a copy button. Send to that address on Solana:

- USDC to trade with, about $50 to $100.
- About 0.02 SOL. It stays in the client wallet to pay the move-in's network fee and the one-time token account rent.

Trades start at $5.50, because the move back to the client wallet has to clear True Markets' $5 transfer minimum after the order fee and any price move. The same floor applies to a sell, so a position worth less than that can't be sold through Kumi. True Markets' own minimum trade is $1, so the $5 transfer is what sets the floor. A sell of SOL always leaves 0.01 SOL in the client wallet for fees; any other token can be sold down to nothing.

## Getting your funds out

Open a client, then **Wallets** at the bottom of the page.

- **Withdraw** sends any asset the client wallet holds to any Solana address. You enter the address and an amount, check the review, and confirm. It is signed by the client wallet's own key, and the network fee is paid in SOL from the same wallet. Keep a little SOL there, about 0.003, because sending a token can open the recipient's token account and the sender pays that rent. A withdrawal is final.
- **Transfer all** moves everything the client wallet holds to one address, without selling anything. Each token is sent and confirmed in turn, then the SOL that is left after fees. If a send fails or does not confirm, it stops there and shows what is still in the wallet. A little SOL under 0.001 may stay behind, because it is too small to send.
- **Return funds** appears when a stopped trade left something in the trading wallet. It sends that back to the client wallet through the gateway. The gateway refuses transfers under $5, so a smaller amount can't be returned.
- **Client ID** is shown there too, for `npm run return-funds -- <client id>` if you prefer the command line.

By hand: each client wallet's key is in `data/safekeeping-keys/<client id>.json`, in the standard Solana CLI keypair format, so you can import it into a wallet or point `solana transfer` or `spl-token transfer` at it with `--keypair`. Every send, withdrawal and trade is recorded in `data/`.

## How it works

Every True Markets call lives in `server/tm/`, lifted from the Tensho example, which uses only `fetch` and `node:crypto`:

- `apikey.ts` reads the API key file the developer console downloads.
- `token.ts` gets an organization access token by signing `<key_id>.<unix seconds>` with the org key, caches it and renews it two minutes before it expires. The organization id comes from the token's claims.
- `stamp.ts` signs a payload with the signer key in the stamp format `/execute` expects.
- `client.ts` sends each request with the org token and, for a client, `TM-On-Behalf-Of: <gateway user id>`.
- `gateway.ts` has one typed function per endpoint Kumi uses.

The safekeeping side lives in `server/solana/`, built on `@solana/kit`. Each client's safekeeping key is generated by Kumi, kept in `data/safekeeping-keys/<client id>.json` in the Solana CLI format, and never leaves the server.

**Adding a client** calls `POST /v1/account/organizations/{organization_id}/users` with `external_ref_id: kumi_hh_<client id>` and the signer public key, then creates the safekeeping key. That call is idempotent, so if it fails the household is kept with "Setup not finished", and Finish setup sends the same call again. At the organization's user limit, nothing is saved.

**The trade runner** (`server/runner.ts`) runs a trade on the server in three steps and saves `data/trades.json` after every one, so a restart picks up where it left off:

1. **Move in.** The safekeeping key signs an ordinary Solana transfer of the USDC (for a buy) or SOL (for a sell) to the trading wallet's address. Kumi records the signature before broadcasting, waits for confirmation, then polls `GET /v1/gateway/balances` until the amount shows as available.
2. **Trade.** `POST /v1/gateway/orders` with `type: market` and `venue: defi` naming the DeFi SOL listing returns unsigned payloads; Kumi stamps them with the signer key and executes, once. It then polls the order until it is `complete`.
3. **Move back.** Kumi reads the trading wallet's whole balance of what it received and sends exactly that back with `POST /v1/gateway/transfers`, signed and executed the same way, then polls until it is `completed`. Sending the whole balance means fees and rounding never strand dust.

Any failure stops the trade, marks the step that failed in plain words, and leaves funds where they are. There is no automatic retry, and nothing is ever executed twice: after a restart, Kumi re-reads an order or transfer it had started executing instead of sending it again.

Signing is listed on each trade under a collapsed "How this trade was signed": **Client wallet transfer: Signed by Kumi**, because the client wallet is Kumi's alone, and **Trade and move back: Kumi, co-signed by True Markets**, because a gateway order or transfer is signed by Kumi's signer key and approved by True Markets.

Fees show as an approximate dollar figure, priced with the order's own average price, with the per-asset amounts beneath exactly as True Markets returns them: the order's fee in its fee asset, and the transfer's fee, which comes out of the amount sent back.

The runner keeps to 20 gateway calls a minute per client. The pages poll Kumi, which caches each client's balances for 10 seconds, so a browser left open costs at most 6 gateway calls a minute per client.

## Project structure

```
server/
  tm/            True Markets gateway client, using only fetch and node:crypto
  solana/        client.ts reads balances and sends with @solana/kit; keys.ts holds each client wallet's key
  runner.ts      the trade runner: move in, trade, move back; resumes after a restart
  households.ts  client records and the idempotent gateway user setup
  trades.ts      trade records and the result shown after a trade
  assets.ts      the tradeable tokens, from the gateway listing
  prices.ts      polled token prices
  routes/        thin HTTP routes: validation and views; wallets.ts moves funds out
  withdraw.ts    sends from a client wallet, and plans what a full transfer moves
  clock.ts       time as a dependency, so a two-minute wait runs instantly in tests
  withdrawals.ts withdrawal records, and the lock that keeps a trade and a send apart
  app.ts         builds the app from its dependencies
  index.ts       starts everything with the real ones
shared/          amount maths in bigint, and the trade and withdrawal rules the server and the web both use
web/src/
  pages/         Clients, Client, Trade
  components/    the trade panel, the asset picker, shared pieces
  positions.ts   holdings, allocation and what a trade would change
  trade-input.ts the order form's rules and quick amounts
  format.ts      how amounts, prices and statuses read
scripts/         preflight.mjs checks the setup before dev and start; return-funds moves everything in a trading wallet back
```

The server is built from its parts: `createApp` and `createRunner` take the gateway, the Solana client, the token catalog and a clock as arguments. Tests pass in fakes, so the whole suite runs with no network and no keys. To reuse a piece, `server/tm/` is the one to lift into another stack.

## What it deliberately doesn't do

- No limit orders, cancel, partial fills, retry button, approvals or rebalancing. Market orders of the listed Solana tokens against USDC only, on Solana only. Tokenised stocks are not offered, because the True Markets DeFi listing carries none.
- No sign-up, password reset, MFA or client portal. There is one advisor login.
- No custodian: the client wallet is a key Kumi holds on disk.
- No deleting a client; True Markets has no route to delete a gateway user.
- No production hardening: no rate limiting, no HTTPS termination and no shared state across instances. One process owns `data/`.

## Measured on the first live run

One client on Solana mainnet through https://api.truemarkets.co: a $10 buy of SOL, then a sell of 0.119 SOL (about $10.10) back to USDC. Both trades reached `complete`.

- **Move in to trading wallet:** the whole move-in step, from placing the trade to the funds showing as available, took 13 s for the buy and 15 s for the sell. The send and its confirmation are included.
- **Whole-SOL return:** completed. The buy returned all 0.117113571 SOL, and the gateway took a fee of 0.0000105 SOL out of it.
- **Order fee:** 20 bps of notional on the buy and 20.1 bps on the sell, charged in USDC.
- **Return fee on a USDC return:** 0.000893 USDC on 10.0874 USDC.
- **Whole trade:** 16 s for the buy and 18 s for the sell, from placing it to complete.
- **Balance row matching:** not measured, because the trading wallet is empty between trades. Kumi matches by `asset_id` and falls back to the mint.
- **Sell into a trading wallet with no USDC token account:** not measured. The buy's move-in had already created that wallet's USDC token account, so the sell never hit the case.
- **Smallest trade tried:** a $6 buy completed, and its 0.07 SOL return cleared the gateway's $5 transfer minimum. Below about $5 the return would be refused, so the floor is set at $5.50 (a $6 trade was tried).
- **A token other than SOL:** a $6 buy of JUP and the sale of the whole position back both completed. The first return of a token creates the household's token account in the client wallet, and the gateway took about 0.7069 JUP (around $0.18) for it out of the amount. A token already held has no such cost, and USDC returns cost under a cent. The $6 buy then sold for 5.79 USDC, so a round trip of a token costs about $0.21 the first time.
