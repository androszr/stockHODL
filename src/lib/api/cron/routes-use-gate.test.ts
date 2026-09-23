import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every scheduled job must go through `cronGate`. The routes are read as
 * source (the `proxy.test.ts` arrangement) rather than imported, because
 * importing them drags in the database and every vendor client. A new cron
 * route written with its own hand-rolled check — or none — fails here.
 */

const CRON_DIR = fileURLToPath(new URL('../../../app/api/cron/', import.meta.url));

const routes = readdirSync(CRON_DIR)
  .filter((name) => statSync(join(CRON_DIR, name)).isDirectory())
  .map((name) => ({ name, path: join(CRON_DIR, name, 'route.ts') }))
  .filter(({ path }) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });

describe('every cron route uses the shared gate', () => {
  it('finds the five scheduled jobs', () => {
    expect(routes.map((r) => r.name).sort()).toEqual([
      'check-price-alerts',
      'daily-summary',
      'morning-brief',
      'refresh-history',
      'refresh-symbols',
    ]);
  });

  it.each(routes.map((r) => [r.name, r.path]))('%s calls cronGate(', (_name, path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain("from '@/lib/api/cron/gate'");
    expect(source).toContain('cronGate(');
  });

  it.each(routes.map((r) => [r.name, r.path]))(
    '%s carries no private copy of the comparison',
    (_name, path) => {
      expect(readFileSync(path, 'utf8')).not.toContain('timingSafeEqual');
    },
  );
});
