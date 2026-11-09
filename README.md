# Paisa

Personal money tracker. Bank alert mails become labelled transactions; a Telegram bot asks only when it
cannot work out what a payment was; shared payments go to Splitwise in two taps.

```
Gmail (bank alerts) --Apps Script, every 5 min--> /api/ingest/email --> Neon Postgres
                                                        |
                              Telegram bot <------------+------> Splitwise, Groq (category guess)
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
3. **Splitwise**: secure.splitwise.com/apps -> register an app -> create an API key.
4. **Vercel**: import this repo and set every variable from `.env.example`. The build runs the migrations.
5. **Telegram webhook** (once, after the first deploy):
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url=https://<app>.vercel.app/api/telegram/webhook -d secret_token=<TG_WEBHOOK_SECRET>
   ```
6. **Apps Script**, on the Gmail account that receives bank alerts: new project at script.google.com,
   show the manifest (Project Settings), paste `apps-script/Code.gs` and `appsscript.json`, add the script
   properties `APP_URL` and `CRON_SECRET`, run `installTrigger`, then run `forwardMail` once.

## Past statements and the Splitwise backfill
1. Download the last 12 months: bank accounts as `.xls` / `.xlsx` / `.csv`, cards as statement PDFs.
2. Dry run, and compare the printed totals with the statement:
   `npx tsx scripts/import-statements.ts "ICICI a/c 1234" ~/Downloads/icici.xls`
3. Store them: the same command with `--write` (needs `DATABASE_URL` in `.env.local`; set
   `PDF_PASSWORD=...` for locked PDFs). Rows dated on or after the first live bank mail are skipped,
   and re-running adds nothing twice.
4. Open `/backfill`: tick the shared payments, choose a group or friend, check the dry-run preview,
   then post. Splitwise notifies your friends for each expense, 40 at most per batch.

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
