import type { Env } from './types';

export function getMainToken(env: Env): string {
  return env.MAIN_BOT_TOKEN || env.BOT_TOKEN || '';
}

export function getAdminToken(env: Env): string {
  return env.ADMIN_BOT_TOKEN || '';
}

export function getAdminIds(env: Env): number[] {
  const raw = env.ADMIN_IDS || env.ADMIN_ID || '';
  const ids = raw
    .split(/[,\s;]+/)
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(ids)];
}

export function isAdmin(env: Env, userId: number | undefined): boolean {
  return Boolean(userId && getAdminIds(env).includes(userId));
}

export function checkSecret(provided: string | null, expected: string | undefined): boolean {
  if (!expected) return true;
  return provided === expected;
}
