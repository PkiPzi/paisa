#!/data/data/com.termux/files/usr/bin/sh
# Paisa SMS sweeper, run inside Termux on the phone. It re-sends the recent bank SMS from the inbox, so a
# payment the live forwarder missed (app killed, phone off, no network) still reaches Paisa. Messages that
# were already stored are ignored by the app, so running it often is harmless.
# Only messages whose sender looks like a bank leave the phone.
#
# Needs: pkg install termux-api jq curl, the Termux:API app, and SMS permission for Termux:API.
# shortcut: field names of termux-sms-list output were not checked on a real phone; the app accepts
# number/address/sender and body/text, and received as "YYYY-MM-DD HH:MM:SS".
URL="https://paisa-ten-xi.vercel.app"
SECRET="PASTE_CRON_SECRET_HERE"
DAYS="${1:-3}"

termux-sms-list -d -n -l 400 -t inbox \
  | jq -c '[.[] | select((.number // .address // .sender // "") | test("ICICI|SBI|AXIS"; "i"))]' \
  | curl -sS --retry 3 -X POST "$URL/api/ingest/sms/sweep?days=$DAYS" \
      -H "X-Cron-Secret: $SECRET" -H "content-type: application/json" --data-binary @-
echo
