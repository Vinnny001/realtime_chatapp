import { z } from 'zod';
import {
  EVENTS,
  MAX_TEXT_LENGTH,
  Message,
  UPLOAD_URL_PATTERN,
  canSend,
  createMessage,
  findConversationForUser,
  pushNewMessage,
  pushReaction,
  pushReactionRemoved,
  reactToMessage,
  rooms,
  sameId,
  serializeMessage,
} from '#shared';
import { SocketError, createLimiter, objectId, toMembers } from '../socketUtils.js';

const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;

const mediaSchema = z.object({
  url: z.string().regex(UPLOAD_URL_PATTERN, 'Invalid media url'),
  name: z.string().max(200).optional(),
  size: z.number().nonnegative().optional(),
  mime: z.string().max(100).optional(),
  duration: z.number().nonnegative().max(24 * 3600).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

const sendSchema = z
  .object({
    conversationId: objectId,
    clientId: z.string().min(8).max(64),
    type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file']).default('text'),
    text: z.string().max(MAX_TEXT_LENGTH).default(''),
    media: mediaSchema.optional(),
    replyTo: objectId.nullish(),
    forwarded: z.boolean().optional(),
  })
  .refine((d) => (d.type === 'text' ? d.text.trim().length > 0 : !!d.media), 'Message is empty');

const editSchema = z.object({ messageId: objectId, text: z.string().trim().min(1).max(MAX_TEXT_LENGTH) });
const deleteSchema = z.object({ messageId: objectId, forEveryone: z.boolean().default(false) });
const reactSchema = z.object({ messageId: objectId, emoji: z.string().min(1).max(16).nullable() });

export function registerMessageHandlers({ io, socket, userId, on }) {
  const allowSend = createLimiter(40, 10_000);

  /** Loads a message plus its conversation, ensuring the user is a member. */
  async function loadMessage(messageId) {
    const message = await Message.findById(messageId);
    const conversation = message && (await findConversationForUser(message.conversation, userId));
    if (!conversation) throw new SocketError('Message not found');
    return { message, conversation };
  }

  on('message:send', sendSchema, async (data) => {
    if (!allowSend()) throw new SocketError('You are sending messages too fast');
    const conversation = await findConversationForUser(data.conversationId, userId);
    if (!conversation) throw new SocketError('Conversation not found');
    if (!canSend(conversation, userId)) throw new SocketError('Only admins can send messages to this group');

    const replyTo =
      data.replyTo && (await Message.exists({ _id: data.replyTo, conversation: conversation._id }))
        ? data.replyTo
        : null;

    const { message, duplicate } = await createMessage({
      conversation,
      senderId: userId,
      type: data.type,
      text: data.text,
      media: data.media,
      replyTo,
      forwarded: data.forwarded,
      clientId: data.clientId,
    });

    socket.join(rooms.conv(conversation._id));
    if (!duplicate) {
      toMembers(io, conversation).emit(EVENTS.MESSAGE_NEW, serializeMessage(message));
      pushNewMessage(message, conversation); // phones in the background / app closed
    }
    return { message: serializeMessage(message, userId) };
  });

  on('message:edit', editSchema, async ({ messageId, text }) => {
    const { message, conversation } = await loadMessage(messageId);
    if (!sameId(message.sender, userId) || message.deletedForEveryone || message.type === 'system') {
      throw new SocketError('You can only edit your own messages');
    }
    if (Date.now() - message.createdAt > EDIT_WINDOW_MS) {
      throw new SocketError('Messages can only be edited within 24 hours');
    }
    message.text = text;
    message.editedAt = new Date();
    await message.save();

    const patch = { id: messageId, conversationId: String(conversation._id), text, editedAt: message.editedAt };
    toMembers(io, conversation).emit(EVENTS.MESSAGE_UPDATED, patch);
    return { message: patch };
  });

  on('message:delete', deleteSchema, async ({ messageId, forEveryone }) => {
    const { message, conversation } = await loadMessage(messageId);
    const conversationId = String(conversation._id);

    if (!forEveryone) {
      await Message.updateOne({ _id: messageId }, { $addToSet: { deletedFor: userId } });
      io.to(rooms.user(userId)).emit(EVENTS.MESSAGE_REMOVED, { id: messageId, conversationId });
      return {};
    }

    const isSender = sameId(message.sender, userId);
    const isAdmin = conversation.type === 'group' && conversation.member(userId)?.role === 'admin';
    if (message.type === 'system' || !(isSender || isAdmin)) {
      throw new SocketError('You can only delete your own messages for everyone');
    }
    if (isSender && !isAdmin && Date.now() - message.createdAt > DELETE_FOR_EVERYONE_WINDOW_MS) {
      throw new SocketError('Messages can only be deleted for everyone within 48 hours');
    }

    await Message.updateOne(
      { _id: messageId },
      { $set: { deletedForEveryone: true, text: '', reactions: [], editedAt: null }, $unset: { media: 1 } }
    );
    const patch = { id: messageId, conversationId, deletedForEveryone: true, text: '', media: null, reactions: [] };
    toMembers(io, conversation).emit(EVENTS.MESSAGE_UPDATED, patch);
    return {};
  });

  on('message:react', reactSchema, async ({ messageId, emoji }) => {
    let result;
    try {
      result = await reactToMessage({ messageId, userId, emoji });
    } catch (err) {
      throw new SocketError(err.message);
    }
    const { message, conversation, patch, added, removed, preview } = result;
    toMembers(io, conversation).emit(EVENTS.MESSAGE_UPDATED, patch);
    if (added) pushReaction({ message, conversation, reactorId: userId, emoji: added, preview });
    if (removed) pushReactionRemoved({ message, conversation, reactorId: userId });
    return { reactions: patch.reactions };
  });
}
