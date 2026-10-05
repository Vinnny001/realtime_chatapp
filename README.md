# chat-realtime

Socket.IO service for ChatApp. It handles sending messages, delivered/read receipts, typing indicators, online/last seen, edits, deletes, reactions, @mentions (stored with the message; read receipts reset the @ count), and WebRTC call signaling.

It works with two other repos:
- **chat-api**: the REST service. It issues the login tokens this service checks, and sends live events to `POST /internal/events`.
- **chat-frontend**: connects here with `io(REALTIME_URL, { auth: { token } })`.

## Setup

```bash
npm install
cp .env.example .env     # same MONGO_URI, JWT_SECRET and INTERNAL_SECRET as chat-api
npm run dev              # http://localhost:5051
```

## Client events (all acknowledged with `{ ok, ...result }` or `{ ok: false, error }`)

| Event | Payload |
| --- | --- |
| `message:send` | `{ conversationId, clientId, type, text?, media?, replyTo?, forwarded? }` |
| `message:edit` / `message:delete` / `message:react` | `{ messageId, text }` / `{ messageId, forEveryone }` / `{ messageId, emoji \| null }` |
| `message:delivered` / `conversation:read` | `{ conversationId, upTo }` (a message's `createdAt`) |
| `typing` | `{ conversationId, state: 'typing' \| 'recording' \| 'stop' }` |
| `presence:get` | `{ userIds }` |
| `call:invite` / `call:accept` / `call:reject` / `call:signal` / `call:end` | `{ callId, ... }` |

The server pushes these events to clients: `message:new`, `message:updated`, `message:removed`, `receipt`, `typing`, `presence`, `conversation:upsert`, `conversation:removed`, `user:updated`, and `call:*`.

## Notes

- Online status and active calls are kept in memory, so run **one** instance.
- `/internal/events` requires the `X-Internal-Secret` header. Keep it off the public internet (firewall or private network).
- `src/shared/` is duplicated in chat-api. When you change a model, change it in both repos.

## Usernames and privacy

Registered names are private: payloads carry the user's `username`, and their phone number / email only when they chose to share them (users without a username always share their number). Notifications and incoming calls carry `@username` (or the number) as the name; the Android app replaces it with the name the recipient saved the person under.

## Push notifications

New messages are pushed to the recipients' phones through Firebase Cloud Messaging, so they arrive as pop-up notifications even when the app is closed. Muted chats and the sender's own devices are skipped. Set `FIREBASE_SERVICE_ACCOUNT` to the service-account key from Firebase (*Project settings → Service accounts → Generate new private key*): paste the whole JSON on one line, or base64-encode it. Set the same value on both **chat-api** and **chat-realtime**. Without it, the service runs normally but sends no notifications.

The pushes are data-only: the Android app builds the notifications itself. This service also rings the callee's phone for incoming calls (`call`), stops the ringing when the call is answered, declined or cancelled (`call_end`), and clears a chat's notifications on your other phones once you read it (`read`).

## Calls

Calls ring for 45 seconds, then count as missed. Every call is written into the chat as a `call` message (missed, declined, or answered with its duration); only missed calls count as unread. If the callee opens the app while a call is still ringing, the call is sent to them again so they can answer it. `POST /calls/:callId/reject` (with `Authorization: Bearer <token>`) is the Decline button on the incoming-call notification, which works without opening the app.
