# HaloBestie

A simple local emotional-support app with separate Customer and Bestie targets. Built with TypeScript, React Native / Expo, Express, and SQLite.

## Run locally

Requires Node.js 24 and npm.

```sh
npm install
npm start
```

Open Customer at http://localhost:8081 and Bestie at http://localhost:8082. The API runs at http://localhost:3001.

1. Bestie goes online.
2. Customer chooses a nickname, text chat, and 10, 30, or 60 minutes.
3. Customer confirms the sandbox payment. No money is charged.
4. Bestie accepts; both participants confirm they are ready.
5. Exchange messages, add 10 minutes, or end the session.
6. Customer leaves a rating and optional feedback. Both apps can open past sessions through Session history.

The Bestie workspace includes completed-session count, minutes supported, and average rating. Only nicknames are shared; no email or phone number is stored.

## Sessions and refunds

- One customer and one Bestie are preconfigured. Only one booking can be open at a time.
- Payment and extension requests are idempotent. Failed payments can be retried.
- If no Bestie accepts within 30 seconds, the booking is cancelled and the sandbox payment is refunded.
- Bestie can decline a waiting booking for a full sandbox refund.
- Both participants must become ready within 30 seconds of acceptance or the booking is refunded.
- Keep Bestie open for connection heartbeats. A disconnect of 60 seconds ends an active session and refunds unused time in the sandbox.
- Customer disconnection does not pause the timer. Customer-initiated early ending does not refund unused time; Bestie-initiated early ending does.
- Expired sessions reject new messages. Late extension payments are refunded in the sandbox.
- History includes the latest 30 closed sessions; messages and feedback persist across server restarts.

SQLite data lives in `data/halobestie.sqlite`. Existing databases upgrade automatically. Stop the API before deleting `data/` if you want a fresh local setup.

## Android and iOS

Copy `.env.example` to `.env`, then set `EXPO_PUBLIC_API_URL` to your computer's LAN IP, for example `http://192.168.1.20:3001`. Use the same Wi-Fi network on phones and computer. Start each process in a separate terminal:

```sh
npm run api
npm run customer
npm run bestie
```

Scan the Expo QR codes with Expo Go on separate devices. The targets have separate Android package and iOS bundle identifiers. Native device and simulator execution is not verified in this Linux environment; browser previews and web exports are checked.

## Checks

```sh
npm run typecheck
npm test
npm run build:customer
npm run build:bestie
```

## Current limits

Text messaging, matching, timers, history, nicknames, ratings, and activity statistics run locally with persistent storage. Payments and refunds use a **sandbox adapter** and never move real money. Voice booking is a **preview only**; live audio is not connected.

The two local identity tokens are public development identifiers, not secure authentication. There is no account registration, multi-user isolation, live payment gateway, production TLS, or store release. Use this app locally. Real checkout, verified provider webhooks, secure accounts, and a live voice SDK are the next steps before a public launch.
