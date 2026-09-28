import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (copy .env.example to .env)`);
  return value;
}

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5051),
  mongoUri: required('MONGO_URI'),
  // Must match the API's JWT_SECRET: sockets authenticate with tokens the API issued.
  jwtSecret: required('JWT_SECRET'),
  // Must match the API's INTERNAL_SECRET: guards the /internal/events endpoint.
  internalSecret: required('INTERNAL_SECRET'),
  // Web app + Capacitor (capacitor://localhost on iOS, https://localhost on Android); "*" allows any.
  corsOrigins: list(
    process.env.CORS_ORIGINS ||
      'http://localhost:5173,http://127.0.0.1:5173,capacitor://localhost,https://localhost,http://localhost'
  ),
};

export function corsOriginOption() {
  return config.corsOrigins.includes('*') ? true : config.corsOrigins;
}
