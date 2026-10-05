import http from 'node:http';
import { Server } from 'socket.io';
import {
  Conversation,
  EVENTS,
  INTERNAL_EVENTS_PATH,
  User,
  config,
  connectMongo,
  initPush,
  corsOriginOption,
  rooms,
  verifyToken,
} from '#shared';
import { createOn } from './src/socketUtils.js';
import { handleInternalEvents } from './src/internal.js';
import { registerMessageHandlers } from './src/handlers/messages.js';
import { markAllDelivered, registerReceiptHandlers } from './src/handlers/receipts.js';
import { goOnline, registerPresenceHandlers } from './src/handlers/presence.js';
import { handleRejectRequest, registerCallHandlers, ringingCallsFor } from './src/handlers/calls.js';

await connectMongo();
initPush();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'realtime', sockets: io.engine.clientsCount }));
  }
  if (req.url === INTERNAL_EVENTS_PATH) return handleInternalEvents(io, req, res);
  const reject = req.url.match(/^\/calls\/([\w-]{8,64})\/reject$/);
  if (reject && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST',
    });
    return res.end();
  }
  if (reject && req.method === 'POST') {
    return handleRejectRequest(io, req, res, reject[1]).catch((err) => {
      console.error('[realtime] reject failed:', err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }
  res.writeHead(404).end();
});

const io = new Server(server, {
  cors: { origin: corsOriginOption() },
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1024 * 1024, // long messages (up to 65,536 characters)
});

io.use(async (socket, next) => {
  const userId = verifyToken(socket.handshake.auth?.token);
  if (!userId || !(await User.exists({ _id: userId, disabled: { $ne: true } }))) return next(new Error('unauthorized'));
  socket.data.userId = userId;
  next();
});

io.on('connection', async (socket) => {
  const { userId } = socket.data;
  const ctx = { io, socket, userId, on: createOn(socket) };

  // Register handlers before any await so no early client event is missed.
  registerPresenceHandlers(ctx);
  registerMessageHandlers(ctx);
  registerReceiptHandlers(ctx);
  registerCallHandlers(ctx);

  try {
    const conversations = await Conversation.find(
      { 'participants.user': userId },
      { lastMessageAt: 1, participants: { $elemMatch: { user: userId } } }
    ).lean();
    socket.join([rooms.user(userId), ...conversations.map((c) => rooms.conv(c._id))]);
    goOnline(ctx);
    // Opened the app while someone is calling: show the ringing call now.
    for (const call of ringingCallsFor(userId)) socket.emit(EVENTS.CALL_INCOMING, call);
    await markAllDelivered(io, userId, conversations);
  } catch (err) {
    console.error('[realtime] connection setup failed:', err);
  }
});

server.listen(config.port, () => {
  console.log(`[realtime] socket.io listening on http://localhost:${config.port}`);
});
