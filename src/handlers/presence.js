import { z } from 'zod';
import { EVENTS, User, blockedBy, rooms } from '#shared';
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
    // Hiding your own last seen also hides everyone else's from you (as on WhatsApp).
    const me = await User.findById(userId, 'settings').lean();
    const iHide = me?.settings?.showLastSeen === false;
    const blockedMe = new Set(await blockedBy(userId)); // they don't show me online / last seen
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return {
      presence: userIds.map((id) => {
        const u = byId.get(id);
        return {
          userId: id,
          online: !blockedMe.has(id) && isOnline(id),
          lastSeen: iHide || blockedMe.has(id) || u?.settings?.showLastSeen === false ? null : u?.lastSeen ?? null,
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

/** "Online" to my chats, except people I blocked. */
async function announceOnline(socket, userId) {
  const convRooms = convRoomsOf(socket);
  if (!convRooms.length) return;
  const me = await User.findById(userId, 'blocked').lean().catch(() => null);
  const except = (me?.blocked || []).map((id) => rooms.user(String(id)));
  socket.to(convRooms).except(except).emit(EVENTS.PRESENCE, { userId, online: true });
}

/** Last seen = now; tell their chats they're offline. */
async function wentOffline(io, userId, convRooms) {
  try {
    const lastSeen = new Date();
    const user = await User.findByIdAndUpdate(userId, { lastSeen }, { new: true }).select('settings blocked').lean();
    const iBlocked = new Set((user?.blocked || []).map(String));
    // They may have come back while we were saving lastSeen.
    if (isOnline(userId) || !convRooms.length) return;
    const shared = user?.settings?.showLastSeen === false ? null : lastSeen;
    if (!shared && !iBlocked.size) {
      io.to(convRooms).emit(EVENTS.PRESENCE, { userId, online: false, lastSeen: null });
      return;
    }
    // Viewers who hide their own last seen don't get anyone else's.
    const sockets = await io.in(convRooms).fetchSockets();
    const viewerIds = [...new Set(sockets.map((s) => s.data.userId))];
    const hiding = new Set(
      (await User.find({ _id: { $in: viewerIds }, 'settings.showLastSeen': false }, '_id').lean()).map((u) => String(u._id))
    );
    for (const s of sockets) {
      if (s.data.userId === userId) continue;
      if (iBlocked.has(s.data.userId)) continue; // people I blocked don't see my presence
      s.emit(EVENTS.PRESENCE, { userId, online: false, lastSeen: hiding.has(s.data.userId) ? null : shared });
    }
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
