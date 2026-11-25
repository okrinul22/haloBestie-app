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
2. Customer chooses a nickname, text chat or browser voice, 10, 30, or 60 minutes, and a sandbox method: QRIS, e-wallet, or bank transfer.
3. The backend returns an IDR quote. Customer can simulate payment success or failure; no money is charged. Failed payments stay unpaid and can be retried.
4. Bestie accepts. For text, both participants confirm readiness. For voice, both click Connect microphone and allow permission; the timer starts when both audio connections are ready.
5. Exchange messages in text sessions or speak through the microphone in voice sessions. Either session can be extended or ended.
6. Customer leaves a rating and optional feedback. Both apps can open past sessions through Session history.

The Bestie workspace includes completed-session count, minutes supported, and average rating. Only nicknames are shared; no email or phone number is stored.

## Sessions and refunds

- One customer and one Bestie are preconfigured. Only one booking can be open at a time.
- Booking request IDs, payment event IDs, and extension records prevent duplicate bookings, settlements, and added time. Failed payments can be retried; later failure events cannot reverse a successful payment.
- A paid booking reserves the online Bestie and waits for acceptance. If the listener comes online during the 30-second window, the server reserves them then. The paid timer starts only after both participants are ready. Session APIs also verify a matching paid ledger receipt: correct amount, IDR currency, settlement timestamp, and no full refund. A client booking status alone cannot unlock the session.
- Each payment has a persistent receipt with method, IDR amount, reference, and status. Refunds have separate pending, failed, and completed states. Failed or pending sandbox refunds retry every five seconds using the same refund reference. These records survive restarts.
- A successful payment arriving after cancellation is fully refunded and never reopens the booking.
- If no Bestie accepts within 30 seconds, the booking is cancelled and the sandbox payment is refunded.
- Bestie can decline a waiting booking for a full sandbox refund.
- Both participants must become ready within 30 seconds of acceptance for text, or 60 seconds for microphone setup in voice, or the booking is refunded.
- Keep Bestie open for connection heartbeats. A disconnect of 60 seconds ends an active session and refunds unused time in the sandbox.
- Customer disconnection does not pause the timer. Customer-initiated early ending does not refund unused time; Bestie-initiated early ending does.
- Expired sessions reject new messages. The server stores the original end time; reopening either app cannot reset it.
- An extension payment adds time once only while the session is active and the Bestie is available. Late payments and payments made while the Bestie is unavailable are refunded in the sandbox.
- Unused-time refunds are calculated separately for the original purchase and each paid extension, respecting different prices. A delayed server restart uses the disconnect deadline rather than charging for the outage.
- History includes the latest 30 closed sessions; messages and feedback persist across server restarts.

SQLite data lives in `data/halobestie.sqlite`. Existing databases upgrade automatically. Stop the API before deleting `data/` if you want a fresh local setup.

## Payment proof and alerts

The verified sandbox receipt is visible to Customer and Bestie before session entry. It includes the booking reference, amount, currency, and settlement time. Fetch it from `GET /api/bookings/:id/payment-proof` using the same local identity header as other API requests. This proves a simulated payment was recorded; it is not evidence of a real bank transfer. Screenshots and client-supplied paid status never authorize session access.

Both apps show alerts for payment failure/verification, session start, one minute remaining, cancellation, and session end. At exactly the server end time, the text composer disappears and microphone tracks are stopped. End-of-session alerts take priority over earlier warnings. History remains readable, but the backend rejects new messages, voice signaling, and reconnection after expiry. Ten-minute boundary tests use a controlled server clock; browser microphone cleanup is checked separately with a shortened isolated QA session.

## Browser voice calls

Voice now uses WebRTC microphone audio rather than text. Open Customer and Bestie in separate browser tabs or devices, complete sandbox payment, accept, then connect both microphones. Mute/unmute and reconnect controls are available. Use headphones to avoid feedback when both tabs share the same computer.

This is a local peer-to-peer implementation with no external STUN/TURN relay. It is verified on localhost; different networks may require a configured TURN service or a managed voice provider. Microphone access requires localhost or HTTPS. If connection recovery fails, click Reconnect voice on both apps within the 60-second recovery window. Voice health is based on media-connection heartbeats, not just an open Bestie tab.

Native Expo microphone calling is not implemented in this build. Native voice selection is disabled and existing voice bookings show a browser requirement instead of silently switching to text. A native WebRTC development build or managed voice SDK is required before offering native voice.

## Test the paid flow

Open both apps. Keep Bestie online, select a service, duration, and sandbox method on Customer, then test failure followed by success. Bestie accepts and both click ready. Send messages, create an extension, and confirm its sandbox payment. Check the remaining time and receipt.

For the no-listener case, keep Bestie offline and complete a sandbox payment. After 30 seconds, the booking is cancelled and the refund appears in the receipt. To test late extension settlement, create an extension, let Bestie end the session, then settle the extension from Customer: no time is added and that payment is refunded. Closing Bestie for 60 seconds during an active session tests disconnect recovery. Use automated tests for expiry without waiting ten minutes.

## Production replacement (outside the simulated flow)

Before enabling real payments, integrate approved Xendit methods using hosted checkout, authenticated provider verification, deduplicated durable webhooks, and payment reconciliation. Refund requests need an outbox and final provider confirmation; a request response alone must not be labeled completed. Check full and partial refund support for every enabled channel, including manual support for unsupported refunds. The current synchronous adapter is sandbox-only and is not a live-payment integration.

Live voice needs a managed SDK with private session credentials, join verification before billing, provider-enforced expiry, and expiry updates for paid extensions. The local browser call is peer-to-peer; production and native voice still require that managed media integration. Review Apple and Google payment eligibility, including transcript/replay behavior, before store submission.

Provider references: [Xendit sessions](https://docs.xendit.co/apidocs/create-session), [Xendit refund lifecycle](https://docs.xendit.co/apidocs/create-a-refund), [Daily session time limits](https://www.daily.co/blog/video-call-api-tutorial-time-limits-for-rooms-and-meetings/), [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google payment policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en-TJ).

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

Text messaging, matching, timers, history, nicknames, ratings, and activity statistics run locally with persistent storage. Payments and refunds use a **sandbox adapter** and never move real money. Browser voice uses WebRTC on localhost; native voice and internet-wide relay infrastructure are not connected.

The two local identity tokens are public development identifiers, not secure authentication. There is no account registration, multi-user isolation, live payment gateway, production TLS, or store release. Use this app locally. Real checkout, verified provider webhooks, secure accounts, native voice support, and a managed media/relay service are the next steps before a public launch.
