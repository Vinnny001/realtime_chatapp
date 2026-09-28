import jwt from 'jsonwebtoken';
import { config } from './config.js';

/** Returns the user id stored in the token, or null when the token is invalid/expired. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
