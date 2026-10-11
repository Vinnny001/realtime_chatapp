import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * Returns the user id stored in the token, or null when the token is invalid/expired, or a
 * "pending" token (email not confirmed yet: such accounts can't chat or call).
 */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.pending) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * The payload of a full (not pending) login token, or null. `did` is the device it was
 * issued to (absent on tokens from before devices existed).
 */
export function readToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.pending || typeof payload.sub !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}
