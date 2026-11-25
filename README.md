# HaloBestie

A local emotional-support app with separate Customer and Bestie targets. TypeScript, React Native / Expo, Express, and SQLite. Payments remain sandbox-only, as requested.

## Start

Requires Node.js 24 and npm.

```sh
npm install
cp .env.example .env
npm start
```

Open Customer at http://localhost:8081 and Bestie at http://localhost:8082. The API runs at http://localhost:3001; its health check is `/health` and database readiness check is `/ready`.

1. Create a customer account in Customer. Choose a private nickname and a password with at least 12 characters, then sign in.
2. Create a listener account in Bestie. Approve it from the server terminal:

   ```sh
   npm run approve-bestie -- listener@example.com
   ```

3. Sign in to Bestie and go online.
4. Customer chooses text or browser voice, a duration, and a sandbox method. Confirm the simulated payment.
5. The assigned Bestie accepts. For text, both click ready. For voice, both connect their microphones.
6. Talk, extend, or end the session. Customer can leave feedback. Both roles can report a concern or block future matching.

There are no public passwords, preconfigured login tokens, or automatic Bestie approvals. Old anonymous records stay in the database under a legacy owner; registering a new account does not claim somebody else's old history. Do not delete the database when upgrading.

## Accounts and privacy

Passwords are hashed with individually salted scrypt (N=131072, r=8, p=1). Session tokens are random, stored as SHA-256 hashes in SQLite, expire after seven days, and are revoked on sign-out. Browser sessions use separate HttpOnly, SameSite=Strict Customer and Bestie cookies, so both apps work in one browser. Tokens are not kept in browser localStorage. Native bearer tokens stay in memory; native users sign in again after an app restart.

Every booking, message, receipt, rating, refund, report, and voice-signaling endpoint checks the signed-in participant. Customer and Bestie histories and statistics are account-scoped. Listeners see customer nicknames; private customer account IDs and emails are excluded from listener session responses. Login/registration have per-IP limits. API responses are not cacheable.

Set `COOKIE_SECURE=true` when serving over HTTPS. Browser origins are restricted by `ALLOWED_ORIGINS`; include your actual app origins when using LAN addresses or reverse proxies. Local HTTP is for development. Email verification, password recovery, and administrator MFA are still needed before public release.

## Matching and paid sessions

Multiple customers can book concurrently. Each customer can have one open booking, and each listener can hold one reservation/session. Transactions and unique indexes prevent double assignment. Matching chooses an available approved Bestie, prefers listeners least recently matched, and excludes blocked pairs. If nobody accepts within 30 seconds, the sandbox payment is refunded.

The backend returns the IDR quote. Sandbox choices are QRIS, e-wallet, and bank transfer; none creates a real charge. Failed payments stay unpaid. Booking request IDs and payment event IDs make retries safe. A successful payment arriving after cancellation is refunded without reopening the booking.

Saved payment proof must match the booking amount, currency, settled status, and settlement timestamp before session access. Customer and Bestie see the verified sandbox receipt before entering. `GET /api/bookings/:id/payment-proof` returns it for an authenticated participant. It confirms a recorded simulated payment, not a real bank transfer.

Text participants have 30 seconds after acceptance to become ready; browser voice has 60 seconds for microphone setup. Time starts only when both are ready. The server saves the end time, so reopening the app cannot reset it. At expiry, new messages and signaling are rejected, the composer closes, and browser microphones stop. Alerts cover payment failure/verification, start, one minute remaining, cancellation, and end.

Paid extensions add ten minutes exactly once while the session and listener remain available. Late payments are refunded. Unused-time refunds are calculated separately for each purchased time block. Customer-initiated early ending does not refund unused time; Bestie-initiated ending does. A listener disconnect of 60 seconds ends the session and refunds unused time. Customer disconnects do not pause the timer.

Receipts and refund records persist. Refunds have pending, failed, and completed states; pending/failed sandbox refunds retry every five seconds with the same reference. Server restarts reconcile session deadlines. Each account can open its last 30 closed sessions.

## Browser voice and optional TURN

Browser voice exchanges microphone audio through WebRTC, with mute and reconnect controls. Use headphones when testing both apps on one computer. Microphones require localhost or HTTPS. If recovery fails, reconnect on both apps within 60 seconds. Media health is tracked separately from an open Bestie tab.

Local defaults use direct peer connections. For different networks, configure a coturn-compatible relay on the server:

```dotenv
TURN_URLS=turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp
TURN_SECRET=your-server-side-shared-secret
VOICE_FORCE_RELAY=false
```

Keep real values in the ignored `.env` file, never in `EXPO_PUBLIC_*`. The authenticated `/api/bookings/:id/voice/config` endpoint issues two-hour credentials only to paid, assigned voice participants. It does not expose the shared secret or private user ID. Set `VOICE_FORCE_RELAY=true` to require the configured relay during relay testing. No relay account is configured or contacted by default, and external relay connectivity has not been verified without that service.

Native voice selection remains disabled; native WebRTC development builds or a managed mobile SDK are still required. Native voice bookings never silently turn into text chat.

## Reporting and support operations

Reports are visible only through administrator endpoints. Blocking prevents future matching with that participant and leaves the current session unchanged; either participant can still explicitly end the current session.

Create a separate support account, then promote it from the server terminal:

```sh
npm run make-admin -- support@example.com
```

Promotion revokes its existing sessions. Sign in through `POST /auth/login` with `role: "admin"` to obtain a support bearer token. There is no public administrator registration or default administrator password. Use this token only in authorized support tooling, not in the customer/listener apps.

Administrator endpoints:

- `GET /api/admin/reports` — open reports.
- `POST /api/admin/reports/:reportId/resolve` — resolve a report and record an audit entry.
- `GET /api/admin/refunds` — refunds needing follow-up.
- `POST /api/admin/refunds/:refundId/retry` — retry an existing refund with its stable reference and record an audit entry.
- `GET /api/admin/health` — database status, session/refund counts, reports, and reconciliation-worker status.

Enable `LOG_REQUESTS=true` for JSON request logs with correlation IDs, status, path, and duration. Passwords, request bodies, and session tokens are not logged. Liveness and readiness checks are public; operational details require an administrator session.

## Backups

```sh
npm run backup
```

This creates a consistent SQLite snapshot in ignored `backups/`, with owner-only file permissions. It can run while the API is active. Keep backups private and copy them off the server using your own retention/storage policy. Verify restoration into a separate database path before replacing a live database; leave the original untouched until validation passes.

The database defaults to `data/halobestie.sqlite`. `DATABASE_PATH` selects another path. Backend and management scripts load an optional `.env` file. Tests use isolated databases.

## Android/iOS text testing

Set `EXPO_PUBLIC_API_URL` to your computer's LAN address, add the browser origins to `ALLOWED_ORIGINS` if testing web clients over LAN, and use the same Wi-Fi network. Start the three processes separately and scan Expo QR codes on separate devices:

```sh
npm run api
npm run customer
npm run bestie
```

Native devices and simulators are not verified in this Linux workspace. Browser builds, account flows, matching, and messaging are checked.

## Verification

```sh
npm run typecheck
npm test
npm run build:customer
npm run build:bestie
```

Tests include authentication, cookie isolation, session expiry/revocation, cross-account access denial, concurrent matching, moderation, TURN credential generation, live backup integrity, payment retries/refunds, and exact ten-minute text/voice expiry. Browser voice was checked using microphone test devices and two-way RTP statistics; expiry closes peers and microphone tracks.

## Remaining external integrations

Real checkout and real refunds remain disabled because merchant access is not yet available. Before enabling them, add approved Xendit channels, verified/deduplicated webhooks, reconciliation, and a durable refund outbox with final provider confirmation. The synchronous sandbox adapter must not be used for real money.

Internet-wide relay hosting, native calling, production HTTPS, recovery email, and administrator MFA require further configuration/integration. No site or app-store release is performed by `npm start`.

References: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [coturn credentials](https://github.com/coturn/coturn/blob/master/man/man1/turnserver.1), [SQLite backups](https://www.sqlite.org/lang_vacuum.html), [Xendit sessions](https://docs.xendit.co/apidocs/create-session), [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google payment policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en-TJ).
