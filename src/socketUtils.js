import mongoose from 'mongoose';
import { z } from 'zod';
import { idOf, rooms } from '#shared';

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

/** An error whose message is safe to send back to the client. */
export class SocketError extends Error {}

/**
 * Registers a validated event handler. The handler's return value is sent through the
 * client's ack callback as { ok: true, ...result }; failures become { ok: false, error }.
 */
export function createOn(socket) {
  return (event, schema, fn) =>
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) {
        return reply({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid payload' });
      }
      try {
        reply({ ok: true, ...(await fn(parsed.data)) });
      } catch (err) {
        if (err instanceof SocketError) return reply({ ok: false, error: err.message });
        console.error(`[realtime] ${event} failed:`, err);
        reply({ ok: false, error: 'Server error' });
      }
    });
}

/** Fixed-window limiter, one per socket. */
export function createLimiter(max, windowMs) {
  let windowStart = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    return ++count <= max;
  };
}

/** Targets every member's personal room (reaches all their devices, even ones not yet in the conv room). */
export function toMembers(io, conversation) {
  return io.to(conversation.participants.map((p) => rooms.user(idOf(p.user))));
}
