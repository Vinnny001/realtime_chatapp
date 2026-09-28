import { z } from 'zod';
import { EVENTS, User, rooms } from '#shared';
import { objectId } from '../socketUtils.js';

// userId -> ids of that user's connected sockets (one per device/tab).
// A user is online while they have at least one socket on this realtime server.
const connections = new Map();

export const isOnline = (userId) => (connections.get(userId)?.size ?? 0) > 0;

const convRoomsOf = (socket) => [...socket.rooms].filter((r) => r.startsWith('conv:'));

export function registerPresenceHandlers({ io, socket, userId, on }) {
  let roomsAtDisconnect = [];
  socket.on('disconnecting', () => {
    roomsAtDisconnect = convRoomsOf(socket);
  });

  socket.on('disconnect', async () => {
    const sockets = connections.get(userId);
    if (!sockets?.delete(socket.id)) return; // never finished coming online
    if (sockets.size > 0) return; // still connected on another device
    connections.delete(userId);
    try {
      const lastSeen = new Date();
      const user = await User.findByIdAndUpdate(userId, { lastSeen }, { new: true }).select('settings').lean();
      // They may have reconnected while we were saving lastSeen.
      if (isOnline(userId) || !roomsAtDisconnect.length) return;
      io.to(roomsAtDisconnect).emit(EVENTS.PRESENCE, {
        userId,
        online: false,
        lastSeen: user?.settings?.showLastSeen === false ? null : lastSeen,
      });
    } catch (err) {
      console.error('[realtime] presence offline failed:', err.message);
    }
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

/** Called once the socket has joined its rooms. */
export function goOnline({ socket, userId }) {
  if (!socket.connected) return; // disconnected while we were setting up
  let sockets = connections.get(userId);
  if (!sockets) connections.set(userId, (sockets = new Set()));
  sockets.add(socket.id);
  if (sockets.size === 1) {
    const convRooms = convRoomsOf(socket);
    if (convRooms.length) socket.to(convRooms).emit(EVENTS.PRESENCE, { userId, online: true });
  }
}
