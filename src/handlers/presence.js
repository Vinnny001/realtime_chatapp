import { z } from 'zod';
import { EVENTS, User, rooms } from '#shared';
import { objectId } from '../socketUtils.js';

// userId -> Map(socketId -> active) for that user's connected sockets (one per device/tab).
// Like WhatsApp, "online" means ChatApp is open on screen: a connected app that's in the
// background (or a hidden browser tab) doesn't count.
const connections = new Map();

export const isConnected = (userId) => (connections.get(userId)?.size ?? 0) > 0;
export const isOnline = (userId) => [...(connections.get(userId)?.values() ?? [])].some(Boolean);

const convRoomsOf = (socket) => [...socket.rooms].filter((r) => r.startsWith('conv:'));

export function registerPresenceHandlers({ io, socket, userId, on }) {
  let roomsAtDisconnect = [];
  socket.on('disconnecting', () => {
    roomsAtDisconnect = convRoomsOf(socket);
  });

  socket.on('disconnect', async () => {
    const sockets = connections.get(userId);
    const wasOnline = isOnline(userId);
    if (!sockets?.delete(socket.id)) return; // never finished coming online
    if (!sockets.size) connections.delete(userId);
    if (wasOnline && !isOnline(userId)) await wentOffline(io, userId, roomsAtDisconnect);
  });

  // The app came to the foreground (active) or went to the background / tab hidden.
  on('presence:state', z.object({ active: z.boolean() }), async ({ active }) => {
    const sockets = connections.get(userId);
    if (!sockets?.has(socket.id)) return {};
    const wasOnline = isOnline(userId);
    sockets.set(socket.id, active);
    const online = isOnline(userId);
    if (!wasOnline && online) announceOnline(socket, userId);
    if (wasOnline && !online) await wentOffline(io, userId, convRoomsOf(socket));
    return {};
  });

  on('presence:get', z.object({ userIds: z.array(objectId).max(500) }), async ({ userIds }) => {
    if (!userIds.length) return { presence: [] };
    const users = await User.find({ _id: { $in: userIds } }, 'lastSeen settings').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return {
      presence: userIds.map((id) => {
        const u = byId.get(id);
        return {
          userId: id,
          online: isOnline(id),
          lastSeen: u?.settings?.showLastSeen === false ? null : u?.lastSeen ?? null,
        };
      }),
    };
  });

  on(
    'typing',
    z.object({ conversationId: objectId, state: z.enum(['typing', 'recording', 'stop']) }),
    async ({ conversationId, state }) => {
      const room = rooms.conv(conversationId);
      if (socket.rooms.has(room)) {
        socket.to(room).volatile.emit(EVENTS.TYPING, { conversationId, userId, state });
      }
      return {};
    }
  );
}

function announceOnline(socket, userId) {
  const convRooms = convRoomsOf(socket);
  if (convRooms.length) socket.to(convRooms).emit(EVENTS.PRESENCE, { userId, online: true });
}

/** Last seen = now; tell their chats they're offline. */
async function wentOffline(io, userId, convRooms) {
  try {
    const lastSeen = new Date();
    const user = await User.findByIdAndUpdate(userId, { lastSeen }, { new: true }).select('settings').lean();
    // They may have come back while we were saving lastSeen.
    if (isOnline(userId) || !convRooms.length) return;
    io.to(convRooms).emit(EVENTS.PRESENCE, {
      userId,
      online: false,
      lastSeen: user?.settings?.showLastSeen === false ? null : lastSeen,
    });
  } catch (err) {
    console.error('[realtime] presence offline failed:', err.message);
  }
}

/**
 * Called once the socket has joined its rooms. Apps say whether they're on screen when
 * connecting (`auth.active`); older apps that don't count as on screen while connected.
 */
export function goOnline({ socket, userId }) {
  if (!socket.connected) return; // disconnected while we were setting up
  const wasOnline = isOnline(userId);
  let sockets = connections.get(userId);
  if (!sockets) connections.set(userId, (sockets = new Map()));
  sockets.set(socket.id, socket.handshake.auth?.active !== false);
  if (!wasOnline && isOnline(userId)) announceOnline(socket, userId);
}
