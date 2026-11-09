# StayEasy demo script (about 8 minutes)

## Before you start (once)
```powershell
docker compose up -d postgres
cd server; npm run migrate            # applies 005_payments_bookings.sql if new
```
Open **four terminals**:

| # | Command | What it is |
|---|---|---|
| 1 | `cd server; npm run dev` | API on :3000 |
| 2 | `cd server; npm run fakepay` | the pretend payment company on :4000 |
| 3 | `cd server; npm run worker` | hold expiry every 5s + reconciler every 30s |
| 4 | `cd client; npm run dev` | the site on http://localhost:5173 |

For the chaos steps, set these in a fifth PowerShell window:
```powershell
$k = (Select-String -Path ..\.env -Pattern '^FAKEPAY_API_KEY=(.*)').Matches.Groups[1].Value
function Chaos($body) { Invoke-RestMethod -Method Post http://localhost:4000/_chaos -Headers @{Authorization="Bearer $k"} -ContentType 'application/json' -Body $body }
```

---

## 1. The happy path (2 min)
1. Search **London**, pick dates ~2 weeks out, 2 guests. *Point out: prices include tax, per night 5% / 18% around ₹7,500.*
2. Open a hotel. Show a room marked **"Sold out for at least one of your nights"**: availability is checked **per night**.
3. Sign up, then **Reserve** the flexible rate. The hold page shows a **10:00 countdown** and the **frozen price**.
4. Press **Pay**. You leave our site for **FakePay** (the gateway's page, not ours). Press **Pay ₹…**.
5. You're sent back. The page says *"Confirming your payment"* for a moment, then lands on the **confirmed booking**.
   - **Say:** "Coming back from the gateway proves nothing. Anyone can type that URL. The booking was made by the **signed webhook** the gateway sent our API."
6. **My bookings** lists it. The booking page shows **"Free cancellation until … 14:00 (Europe/London time)"**, which is the hotel's clock, not yours.

## 2. Two people, one last room (1 min)
- Run `cd server; npm run test:db`. Point at the line **"50 people, last room: exactly 1 hold, 49 refused, never below 0"**.
- **Say:** "One SQL statement checks and takes the room (`… AND available_count > 0`). Nights are locked in date order, so overlapping stays can't deadlock."

## 3. Holds expire (1 min)
- Reserve something and don't pay. In the database, move its expiry forward:
  `UPDATE holds SET expires_at = now() WHERE id = <id>;`
- Within 5s terminal 3 logs `expired 1 hold(s)`, and the hotel page shows the room available again.

## 4. The payment company misbehaves (3 min)

| Do this | Then | What it proves |
|---|---|---|
| `Chaos '{"dropResponse":1}'`, then Pay | Pay **still works**. FakePay's log shows the intent was created **once** | The response was lost and we retried with the **same request key**, so there's no second charge |
| `Chaos '{"dropResponse":0,"failCreate":1}'`, then Pay | "Payment provider not responding. Your room is still held" | A gateway outage never loses the room or charges twice |
| `Chaos '{"failCreate":0,"duplicateWebhook":1}'`, then pay a new hold | One booking. `SELECT * FROM webhook_events` shows the event **once** | The webhook inbox deduplicates by event id |
| `Chaos '{"duplicateWebhook":0,"dropWebhook":1}'`, then pay a new hold | Stuck on "Confirming…". Within ~30–60s the **reconciler** books it (terminal 3: `reconcile … changed: 1`) | Webhooks are a hint. **Asking the gateway** is the truth |
| `Chaos '{"dropWebhook":0}'`, then on FakePay press **Decline** | Back on the hold page: "Your card was declined… room still held". Pay again works | A failed attempt doesn't lose the hold |

`GET http://localhost:4000/_deliveries` (same header) shows every webhook attempt and retry.

## 5. Cancel and refund (1 min)
1. On a confirmed flexible booking, the page says *"If you cancel now you get back ₹X"*. This number comes from the server.
2. **Cancel → Yes**. The page shows "Refund of ₹X has been sent". FakePay's log shows the refund. The room is available again.
3. **After the deadline:** `UPDATE bookings SET cancel_deadline = now() - interval '1 minute' WHERE id = <id>;` and reload. The refund is now the total **minus the first night and its tax**.
4. A **non-refundable** booking can be cancelled (the room goes back) but the refund is ₹0.

## If something goes wrong on stage
- "Cannot reach the server": terminal 1 isn't running.
- Stuck on "Confirming your payment" with chaos off: is terminal 2 running? Then wait for the reconciler (terminal 3).
- FakePay was restarted: every old intent is gone (it keeps everything in memory). Reserve again.
