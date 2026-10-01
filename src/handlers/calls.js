import { z } from 'zod';
import {
  Conversation,
  EVENTS,
  User,
  createMessage,
  pushCallEnded,
  pushIncomingCall,
  rooms,
  serializeMessage,
  userLabel,
  verifyToken,
} from '#shared';
import { SocketError, objectId, toMembers } from '../socketUtils.js';
import { isConnected } from './presence.js';

// WebRTC signaling for 1:1 voice/video calls. Media flows peer-to-peer; this service relays
// offers/answers/ICE candidates, rings the callee's phone through push (so calls ring even
// when the app is in the background or closed), and writes each call into the chat
// ("Missed voice call", "Video call · 2:31") like WhatsApp.

const RING_TIMEOUT_MS = 45 * 1000;
const CALL_TTL_MS = 4 * 3600 * 1000;
const callId = z.string().min(8).max(64);

// callId -> { caller, callee, kind, conversationId, callerInfo, state, startedAt, timers }
const calls = new Map();
let ioRef = null;

/** Ringing calls for this user, re-sent when they open the app while being called. */
export function ringingCallsFor(userId) {
  return [...calls.entries()]
    .filter(([, c]) => c.callee === userId && c.state === 'ringing')
    .map(([id, c]) => ({ callId: id, conversationId: c.conversationId, kind: c.kind, from: c.callerInfo }));
}

/** Ends a call once: stops timers, tells the callee's phone to stop ringing, logs it in the chat. */
async function finish(id, status, { by } = {}) {
  const call = calls.get(id);
  if (!call) return null;
  calls.delete(id);
  clearTimeout(call.ringTimer);
  clearTimeout(call.ttlTimer);
  const duration = status === 'answered' && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;

  pushCallEnded(call.callee, {
    callId: id,
    conversationId: call.conversationId,
    kind: call.kind,
    status,
    caller: call.callerInfo,
  });

  try {
    const conversation = await Conversation.findById(call.conversationId);
    if (conversation) {
      const { message } = await createMessage({
        conversation,
        senderId: call.caller,
        type: 'call',
        call: { kind: call.kind, status, duration },
        clientId: `call-${id}`,
        countsAsUnread: status === 'missed', // like WhatsApp, a missed call shows as unread
      });
      toMembers(ioRef, conversation).emit(EVENTS.MESSAGE_NEW, serializeMessage(message));
    }
  } catch (err) {
    console.error('[realtime] could not log call:', err.message);
  }
  return { call, by };
}

export function registerCallHandlers({ io, socket, userId, on }) {
  ioRef = io;
  const toUser = (id) => io.to(rooms.user(id));

  /** Returns the call if this user is part of it. */
  function callOf(id) {
    const call = calls.get(id);
    if (!call || ![call.caller, call.callee].includes(userId)) throw new SocketError('Call not found');
    return call;
  }
  const peerOf = (call) => (call.caller === userId ? call.callee : call.caller);

  on(
    'call:invite',
    z.object({
      callId,
      conversationId: objectId,
      toUserId: objectId,
      kind: z.enum(['audio', 'video']),
    }),
    async ({ callId: id, conversationId, toUserId, kind }) => {
      if (toUserId === userId) throw new SocketError('You cannot call yourself');
      const shared = await Conversation.exists({
        _id: conversationId,
        'participants.user': { $all: [userId, toUserId] },
      });
      if (!shared) throw new SocketError('You can only call people you chat with');
      if (calls.has(id)) throw new SocketError('Call id already in use');

      // The callee's app shows the name it saved the caller under; this label is the fallback.
      const caller = await User.findById(userId, 'username phone avatarUrl').lean();
      const callerInfo = { id: userId, name: userLabel(caller), avatarUrl: caller?.avatarUrl ?? null };
      calls.set(id, {
        caller: userId,
        callee: toUserId,
        kind,
        conversationId,
        callerInfo,
        state: 'ringing',
        startedAt: null,
        // Nobody answered: it's a missed call.
        ringTimer: setTimeout(async () => {
          const ended = await finish(id, 'missed');
          if (ended) {
            toUser(toUserId).emit(EVENTS.CALL_ENDED, { callId: id, by: userId, reason: 'missed' });
            toUser(userId).emit(EVENTS.CALL_REJECTED, { callId: id, by: toUserId, reason: 'no-answer' });
          }
        }, RING_TIMEOUT_MS),
        ttlTimer: setTimeout(() => calls.delete(id), CALL_TTL_MS),
      });

      toUser(toUserId).emit(EVENTS.CALL_INCOMING, { callId: id, conversationId, kind, from: callerInfo });
      pushIncomingCall(toUserId, { callId: id, conversationId, kind, caller: callerInfo }); // rings even if the app is closed
      return { reachable: isConnected(toUserId) };
    }
  );

  on('call:accept', z.object({ callId }), async ({ callId: id }) => {
    const call = callOf(id);
    if (call.state === 'ringing') {
      call.state = 'active';
      call.startedAt = Date.now();
      clearTimeout(call.ringTimer);
      // Stop the ringer on the callee's other phones.
      pushCallEnded(call.callee, { callId: id, conversationId: call.conversationId, kind: call.kind, status: 'answered', caller: call.callerInfo });
    }
    toUser(peerOf(call)).emit(EVENTS.CALL_ACCEPTED, { callId: id, by: userId });
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });

  on('call:reject', z.object({ callId, reason: z.enum(['declined', 'busy']).default('declined') }), async ({ callId: id, reason }) => {
    const call = callOf(id);
    const peer = peerOf(call);
    await finish(id, reason === 'busy' ? 'busy' : 'declined');
    toUser(peer).emit(EVENTS.CALL_REJECTED, { callId: id, by: userId, reason });
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });

  on('call:signal', z.object({ callId, data: z.record(z.any()) }), async ({ callId: id, data }) => {
    const call = callOf(id);
    toUser(peerOf(call)).emit(EVENTS.CALL_SIGNAL, { callId: id, from: userId, data });
    return {};
  });

  on('call:end', z.object({ callId }), async ({ callId: id }) => {
    const call = calls.get(id);
    if (!call || ![call.caller, call.callee].includes(userId)) return {};
    const peer = peerOf(call);
    // Hanging up before it was answered means the other person missed it.
    await finish(id, call.state === 'active' ? 'answered' : 'missed');
    toUser(peer).emit(EVENTS.CALL_ENDED, { callId: id, by: userId });
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });
}

/**
 * POST /calls/:callId/reject (Authorization: Bearer <token>): the "Decline" button on the
 * incoming-call notification, which works without opening the app.
 */
export async function handleRejectRequest(io, req, res, id) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization || '';
  const userId = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!userId) return reply(401, { message: 'Not signed in' });
  const call = calls.get(id);
  if (!call || call.callee !== userId) return reply(404, { message: 'Call not found' });
  await finish(id, 'declined');
  io.to(rooms.user(call.caller)).emit(EVENTS.CALL_REJECTED, { callId: id, by: userId, reason: 'declined' });
  io.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
  return reply(200, { ok: true });
}
