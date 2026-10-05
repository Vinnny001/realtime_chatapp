import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '#shared';

// Private endpoint the API uses to reach connected clients. Keep it off the public
// internet in production (firewall / private network); it is also protected by a secret.

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const room = z.string().min(1).max(100);

const opsSchema = z.object({
  ops: z
    .array(
      z.discriminatedUnion('op', [
        z.object({
          op: z.literal('emit'),
          rooms: z.array(room).min(1),
          except: z.array(room).optional(), // e.g. people the user blocked
          event: z.string().min(1).max(64),
          data: z.any(),
        }),
        z.object({ op: z.literal('disconnect'), rooms: z.array(room).min(1) }), // an account was disabled
        z.object({ op: z.literal('join'), rooms: z.array(room).min(1), room }),
        z.object({ op: z.literal('leave'), rooms: z.array(room).min(1), room }),
      ])
    )
    .max(1000),
});

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-internal-secret'] || ''));
  const expected = Buffer.from(config.internalSecret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export async function handleInternalEvents(io, req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { message: 'Method not allowed' });
  if (!authorized(req)) return reply(401, { message: 'Unauthorized' });

  try {
    const parsed = opsSchema.safeParse(await readJson(req));
    if (!parsed.success) return reply(400, { message: parsed.error.issues[0]?.message || 'Invalid ops' });
    for (const op of parsed.data.ops) {
      if (op.op === 'emit') io.to(op.rooms).except(op.except || []).emit(op.event, op.data);
      else if (op.op === 'disconnect') io.in(op.rooms).disconnectSockets(true);
      else if (op.op === 'join') io.in(op.rooms).socketsJoin(op.room);
      else io.in(op.rooms).socketsLeave(op.room);
    }
    reply(200, { ok: true, applied: parsed.data.ops.length });
  } catch (err) {
    reply(err.status || 500, { message: err.message });
  }
}
