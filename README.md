# Paisa

Personal money tracker. Bank alert mails become labelled transactions; a Telegram bot asks only when it
cannot work out what a payment was; shared payments are split in two taps and tracked in a built-in
"who owes whom" ledger (Splitwise's API is paid-only, so nothing depends on it).

```
Gmail (bank alerts) --Apps Script, every 5 min--> /api/ingest/email --> Neon Postgres
                                                        |
                              Telegram bot <------------+------> Groq (category guess)
Vercel cron, 09:00 IST --> /api/cron/daily (card bill reminders, Sunday digest)
```

## How a payment gets its label
1. Rule: a payment to a credit card is a `Card bill`.
2. Memory: a payee you labelled once is never asked about again.
3. Receipt: a Rapido / Uber / Swiggy / Zomato / Blinkit / Zepto receipt for the same amount within 45 minutes.
4. Groq guess, used silently only at 0.8 confidence or more.
5. Otherwise the bot asks with one-tap buttons.

Spending counts your share of a split payment, ignores `Own transfer`, `Card bill`, `Settle-up` and
`Investment`, and subtracts refunds.

## Set up
1. **Neon**: create a project and copy the pooled and direct connection strings.
2. **Telegram**: create a bot with @BotFather. Send the bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and note `message.chat.id`.
3. **Groq**: create a free API key at console.groq.com.
4. **Vercel**: import this repo and set every variable from `.env.example`. The build runs the migrations.
5. **Telegram webhook** (once, after the first deploy):
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url=https://<app>.vercel.app/api/telegram/webhook -d secret_token=<TG_WEBHOOK_SECRET>
   ```
6. **Apps Script**, on the Gmail account that receives bank alerts: new project at script.google.com,
   show the manifest (Project Settings), paste `apps-script/Code.gs` and `appsscript.json`, add the script
   properties `APP_URL` and `CRON_SECRET`, run `installTrigger`, then run `forwardMail` once.

7. **Bank SMS** (banks rarely email UPI debits): install "Incoming SMS to URL forwarder" from F-Droid on
   the phone and add one rule: sender `(?i)(ICICI|SBI|AXIS)` as a regular expression, URL
   `https://<app>/api/ingest/sms`, text filter `(?i)(debited|credited|spent|withdrawn|received)`, headers
   `{"X-Cron-Secret":"<CRON_SECRET>"}`, payload `{"from":"%from%","text":"%text%","sentStamp":%sentStamp%}`.
   The app drops non-bank senders and one-time passwords without storing them, and a payment reported by
   both SMS and mail is stored once.

## Past statements and the Splitwise backfill
1. Download the last 12 months: bank accounts as `.xls` / `.xlsx` / `.csv`, cards as statement PDFs.
2. Dry run, and compare the printed totals with the statement:
   `npx tsx scripts/import-statements.ts "ICICI a/c 1234" ~/Downloads/icici.xls`
3. Store them: the same command with `--write` (needs `DATABASE_URL` in `.env.local`; set
   `PDF_PASSWORD=...` for locked PDFs). A row already recorded from a live SMS or mail (same bank and
   amount, within a day) is skipped and re-running adds nothing twice, so importing a recent statement
   also fills in any payment the live alerts missed.
4. Open `/backfill`: tick the shared payments, choose a group or person, check the preview, then save.

## Who owes whom
- Tap **Split** on a payment and pick a group or person for equal shares, or reply to the payment with
  `me 300, Aman 500` for uneven ones. New names are added as you use them.
- `/group Flat: Aman, Riya` makes a group. `/who` lists balances.
- `Aman owes 500 dinner` and `owe Aman 500 cab` add lines by hand, e.g. opening balances copied from Splitwise.
- Label a transfer to or from a friend `Settle-up` and pick the friend once; later transfers with the same
  UPI id update the ledger without asking.
- `/people` on the dashboard shows every balance and its history.

## Investments
1. Export your holdings from Groww (mutual funds and stocks), or write a CSV with the header
   `isin,name,units,invested`.
2. `npx tsx scripts/import-holdings.ts <files...>` prints what it read; add `--write` to store it.
   An import replaces the stored funds and/or shares, so re-run it after buying or selling.
3. Prices refresh every morning: funds from AMFI's NAV file, shares from Yahoo Finance (unofficial).
4. `/invest` shows value, gain, the equity/debt spread and the nudges. The Sunday digest carries the
   top two nudges, and on the 1st the bot sends a monthly review written by Groq from your numbers.

Nudges are fixed rules, not predictions: surplus income not invested, equity share 10 points off
`TARGET_EQUITY_PCT`, two funds in one category, a Regular plan, one share above 15%, a stale import.

## Local development
```
npx tsx scripts/dev-db.ts            # embedded Postgres with made-up data, no Neon needed
PGLITE_DIR=.pglite npm run dev       # .env.local needs DASHBOARD_PASSWORD and SESSION_SECRET
npm test
```

## Known limits
- `lib/parse.ts` is one generic parser written from typical alert wording, not yet checked against real
  ICICI, SBI and Axis mail. Raw mail is kept in the `emails` table. To re-read mail after a parser fix,
  delete the affected `emails` rows (stored mail is skipped as a duplicate), then run `replayLast30Days`
  in Apps Script.
- The transaction time is the time the mail arrived, not the time printed inside it.
