import { z } from 'zod';
import { Conversation, EVENTS, User, rooms } from '#shared';
import { SocketError, objectId } from '../socketUtils.js';
import { isOnline } from './presence.js';

// WebRTC signaling for 1:1 voice/video calls. Media flows peer-to-peer; this service only
// relays offers/answers/ICE candidates between the two parties registered for a callId.

const CALL_TTL_MS = 4 * 3600 * 1000;
const callId = z.string().min(8).max(64);

// callId -> { caller, callee, timer }. Entries expire so abandoned calls don't pile up.
const calls = new Map();

function endCall(id) {
  clearTimeout(calls.get(id)?.timer);
  calls.delete(id);
}

export function registerCallHandlers({ io, socket, userId, on }) {
  const toUser = (id) => io.to(rooms.user(id));

  /** Returns the other party of a call this user belongs to. */
  async function peerOf(id) {
    const call = calls.get(id);
    if (!call || ![call.caller, call.callee].includes(userId)) throw new SocketError('Call not found');
    return call.caller === userId ? call.callee : call.caller;
  }

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
      calls.set(id, { caller: userId, callee: toUserId, timer: setTimeout(() => calls.delete(id), CALL_TTL_MS) });

      const caller = await User.findById(userId, 'name avatarUrl').lean();
      toUser(toUserId).emit(EVENTS.CALL_INCOMING, {
        callId: id,
        conversationId,
        kind,
        from: { id: userId, name: caller?.name, avatarUrl: caller?.avatarUrl ?? null },
      });
      return { reachable: isOnline(toUserId) };
    }
  );

  on('call:accept', z.object({ callId }), async ({ callId: id }) => {
    const peer = await peerOf(id);
    toUser(peer).emit(EVENTS.CALL_ACCEPTED, { callId: id, by: userId });
    // Stop ringing on this user's other devices.
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });

  on('call:reject', z.object({ callId, reason: z.enum(['declined', 'busy']).default('declined') }), async ({ callId: id, reason }) => {
    const peer = await peerOf(id);
    endCall(id);
    toUser(peer).emit(EVENTS.CALL_REJECTED, { callId: id, by: userId, reason });
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });

  on('call:signal', z.object({ callId, data: z.record(z.any()) }), async ({ callId: id, data }) => {
    const peer = await peerOf(id);
    toUser(peer).emit(EVENTS.CALL_SIGNAL, { callId: id, from: userId, data });
    return {};
  });

  on('call:end', z.object({ callId }), async ({ callId: id }) => {
    const peer = await peerOf(id).catch(() => null);
    if (!peer) return {};
    endCall(id);
    toUser(peer).emit(EVENTS.CALL_ENDED, { callId: id, by: userId });
    socket.to(rooms.user(userId)).emit(EVENTS.CALL_HANDLED_ELSEWHERE, { callId: id });
    return {};
  });
}
