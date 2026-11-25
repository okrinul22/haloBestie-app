# HaloBestie — one-day demo

Implements the limited scope in `document/HaloBestie Implementation Plan.docx`. Two React Native / Expo app targets share a TypeScript codebase and an Express + SQLite backend. Seeded customer **Moonlight** and one Bestie; no registration.

## Run locally

Requires Node.js 24 (uses built-in SQLite) and npm.

```sh
npm install
npm run demo
```

Open the two web URLs printed by Expo: **Customer on port 8081**, **Bestie on port 8082**. The backend is on `http://localhost:3001`. Keep the listener app open for heartbeats. The web preview is included for easy demonstration; Android and iOS use the same React Native screens.

For Android with Expo Go, first copy `.env.example` to `.env` and change `EXPO_PUBLIC_API_URL` to your computer's LAN IP, for example `http://192.168.1.20:3001`. Put phone and computer on the same network. Start the backend and each app in separate terminals:

```sh
npm run api
npm run customer
npm run bestie
```

Scan each Expo QR code on separate devices. `npm run customer -- --android` / `npm run bestie -- --android` require an installed Android emulator. iOS device/simulator execution has not been verified in this Linux workspace.

## Try the complete flow

1. Open Bestie, click **Go online**.
2. Open Customer, choose text and 10 or 30 minutes, then continue.
3. Choose **Simulate successful payment**. No money is charged.
4. Bestie accepts. Both participants click **I'm ready to start**.
5. Send messages in both directions. Reloading preserves messages and server time.
6. Customer adds 10 minutes and completes simulated extension checkout. The server adds time once.
7. At expiry, sending closes automatically. Use tests for expiry without waiting ten minutes.

Failure demos: choose failed payment and retry; leave Bestie offline and wait 30 seconds for a full simulated refund; accept but leave one participant unready for a connection-timeout refund; close the Bestie tab for at least 60 seconds during a session to refund unused time. Reopening sooner reconnects without resetting the timer. Customer disconnects do not pause time. A successful late extension payment is refunded, not applied.

Only one booking can be open at a time in this seeded demo. The backend reserves this slot transactionally. A new booking is available after completion/cancellation. Messages use client IDs for retry deduplication. No customer email or phone is stored or returned. SQLite data persists in `data/halobestie.sqlite`; stop the backend and remove `data/` to reset.

## Checks

```sh
npm run typecheck
npm test
npm run build:customer
npm run build:bestie
```

## Boundaries

Payments/refunds are **simulated**, using a replaceable adapter in `server/payments.ts`. Voice booking is a **placeholder**, using text for the demonstration. Real Xendit checkout/webhooks, live audio, secure authentication, real refunds, production hardening, and store submission are deferred exactly as scoped. Demo identity tokens are public and are not production authentication. Run locally; do not expose this demo as a public service. Production TLS and privacy controls are not implemented.
