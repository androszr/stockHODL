// Match Next.js env-file precedence: `.env.local` overrides `.env`. dotenv
// never overwrites a variable that is already set, so loading `.env.local`
// FIRST gives it priority — the same DATABASE_URL `pnpm dev` uses. Loading
// only `.env` here could silently run migrations against a different database
// than the app talks to.
import { config } from 'dotenv';

import { defineConfig } from 'drizzle-kit';

config({ path: '.env.local' });
config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run drizzle-kit');
}

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
