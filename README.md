# chat-realtime

Socket.IO service for ChatApp. It handles sending messages, delivered/read receipts, typing indicators, online/last seen, edits, deletes, reactions, and WebRTC call signaling.

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

## Push notifications

New messages are pushed to the recipients' phones through Firebase Cloud Messaging, so they arrive as pop-up notifications even when the app is closed. Muted chats and the sender's own devices are skipped. Set `FIREBASE_SERVICE_ACCOUNT` to the service-account key from Firebase (*Project settings → Service accounts → Generate new private key*): paste the whole JSON on one line, or base64-encode it. Set the same value on both **chat-api** and **chat-realtime**. Without it, the service runs normally but sends no notifications.
