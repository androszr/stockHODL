/**
 * Break-glass recovery (docs/context.md § Auth).
 *
 * Run this when there is no working passkey — either because it is the very
 * first launch and none exists yet, or because every enrolled device is gone.
 *
 * It is a LOCAL CLI script on purpose. Recovery has no HTTP surface at all:
 * there is no /enroll route for a scanner to find, no reset endpoint to
 * rate-limit. The only way to run it is to already hold the production
 * DATABASE_URL.
 *
 *   1. pnpm recover '<a-long-temporary-password>'
 *   2. Set RECOVERY_MODE=1 in Vercel → redeploy (or restart `pnpm dev`)
 *   3. Open the iPhone app → Emergency password with ALLOWED_EMAIL + that password
 *   4. Settings → Passkeys → Add a passkey
 *   5. Set RECOVERY_MODE=0 → redeploy. The password path is now dead code again.
 *
 * Step 5 is not optional. While RECOVERY_MODE=1 the app accepts a password,
 * which is exactly the standing credential this design exists to avoid.
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { auth } from '../src/lib/auth';
import { db } from '../src/lib/db';
import { account, session, user } from '../src/lib/db/schema';

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// Wrapped in main() rather than using top-level await: this package is
// CommonJS, so tsx compiles the script to CJS where top-level await is illegal.
async function main() {
  const password = process.argv[2];
  const email = process.env.ALLOWED_EMAIL;

  if (!password) die("Usage: pnpm recover '<temporary-password>'");
  if (password.length < 16) die('Use at least 16 characters — this is a live credential.');
  if (!email) die('ALLOWED_EMAIL is not set. Check .env.');

  const ctx = await auth.$context;

  /**
   * Better Auth's generateId returns `false` when it wants the database to supply
   * the id. These are `text` primary keys with no default, so we mint one here.
   */
  function newId(model: 'user' | 'account'): string {
    const id = ctx.generateId({ model });
    return typeof id === 'string' ? id : crypto.randomUUID();
  }

  // --- 1. Ensure the single user row exists ------------------------------------
  let [existing] = await db.select().from(user).where(eq(user.email, email));

  if (!existing) {
    const id = newId('user');
    [existing] = await db
      .insert(user)
      .values({ id, email, name: email.split('@')[0], emailVerified: true })
      .returning();
    console.log(`  created user ${email}`);
  } else {
    console.log(`  found existing user ${email}`);
  }

  // --- 2. Set the credential password using Better Auth's own hasher -----------
  // Hashing here rather than in the app is the whole point: the plaintext never
  // crosses the network and never reaches a request log.
  const hash = await ctx.password.hash(password);

  const [credential] = await db
    .select()
    .from(account)
    .where(eq(account.userId, existing.id));

  if (credential && credential.providerId === 'credential') {
    await db.update(account).set({ password: hash }).where(eq(account.id, credential.id));
    console.log('  reset existing credential password');
  } else {
    await db.insert(account).values({
      id: newId('account'),
      accountId: existing.id,
      providerId: 'credential',
      userId: existing.id,
      password: hash,
    });
    console.log('  created credential account');
  }

  // --- 3. Invalidate everything else -------------------------------------------
  // If this is a real recovery, assume the old devices are compromised or lost.
  await db.delete(session).where(eq(session.userId, existing.id));
  console.log('  revoked all existing sessions');

  console.log(`
  ✓ Recovery credential is set.

    Next:
      1. RECOVERY_MODE=1   (Vercel env → redeploy, or restart pnpm dev)
      2. Open the iPhone app → Emergency password with ${email} and the password you just passed
      3. Settings → Passkeys → Add a passkey
      4. RECOVERY_MODE=0   ← do not skip this
  `);

  process.exit(0);
}

main();
