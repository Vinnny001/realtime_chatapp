import { z } from 'zod';
import { Conversation, EVENTS, Message, pushRead, rooms } from '#shared';
import { SocketError, objectId, toMembers } from '../socketUtils.js';

// Receipts are watermarks: "everything up to <at> in this chat has reached / been read by me".
// Senders derive their ticks from every other member's watermark.
const watermarkSchema = z.object({ conversationId: objectId, upTo: z.string().datetime().optional() });

async function advance(userId, conversationId, fields, at) {
  let changed = false;
  for (const field of fields) {
    const result = await Conversation.updateOne(
      { _id: conversationId, participants: { $elemMatch: { user: userId, [field]: { $lt: at } } } },
      { $set: { [`participants.$.${field}`]: at } }
    );
    changed ||= result.modifiedCount > 0;
  }
  return changed;
}

export function registerReceiptHandlers({ io, userId, on }) {
  async function members(conversationId) {
    const conv = await Conversation.findOne(
      { _id: conversationId, 'participants.user': userId },
      'participants.user'
    ).lean();
    if (!conv) throw new SocketError('Conversation not found');
    return conv;
  }

  // Never trust a future timestamp from the client.
  const clamp = (upTo) => new Date(Math.min(upTo ? Date.parse(upTo) : Date.now(), Date.now()));

  on('message:delivered', watermarkSchema, async ({ conversationId, upTo }) => {
    const conv = await members(conversationId);
    const at = clamp(upTo);
    if (await advance(userId, conversationId, ['lastDeliveredAt'], at)) {
      toMembers(io, conv).emit(EVENTS.RECEIPT, { conversationId, userId, kind: 'delivered', at });
    }
    return {};
  });

  on('conversation:read', watermarkSchema, async ({ conversationId, upTo }) => {
    const conv = await members(conversationId);
    const at = clamp(upTo);
    const changed = await advance(userId, conversationId, ['lastDeliveredAt', 'lastReadAt'], at);

    const unreadCount = await Message.countDocuments({
      conversation: conversationId,
      sender: { $ne: userId },
      createdAt: { $gt: at },
      $nor: [{ type: 'call', 'call.status': { $ne: 'missed' } }], // only missed calls count as unread
    });
    await Conversation.updateOne(
      { _id: conversationId, 'participants.user': userId },
      { $set: { 'participants.$.unreadCount': unreadCount } }
    );
    toMembers(io, conv).emit(EVENTS.RECEIPT, { conversationId, userId, kind: 'read', at, unreadCount });
    if (changed && unreadCount === 0) pushRead(userId, conversationId); // clear it on my other phones
    return { unreadCount };
  });
}

/**
 * A device that connects will sync every chat, so everything sent to this user so far counts
 * as delivered. Only chats with something newer than the old watermark are touched.
 */
export async function markAllDelivered(io, userId, conversations) {
  const now = new Date();
  const stale = conversations.filter((c) => c.lastMessageAt > (c.participants[0]?.lastDeliveredAt ?? 0));
  if (!stale.length) return;

  await Conversation.updateMany(
    { _id: { $in: stale.map((c) => c._id) }, 'participants.user': userId },
    { $set: { 'participants.$.lastDeliveredAt': now } }
  );
  for (const c of stale) {
    io.to(rooms.conv(c._id)).emit(EVENTS.RECEIPT, {
      conversationId: String(c._id),
      userId,
      kind: 'delivered',
      at: now,
    });
  }
}
