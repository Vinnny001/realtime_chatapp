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
