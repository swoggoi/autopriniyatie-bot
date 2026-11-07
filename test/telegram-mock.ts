/**
 * Minimal outbound `fetch` mock for Telegram API calls.
 *
 * `fetchMock` was removed from `cloudflare:test` in the Vitest plugin for
 * Workers v1. Our worker calls the global `fetch`, and tests run in the same
 * isolate, so replacing `globalThis.fetch` is enough to intercept requests.
 */

interface PendingInterceptor {
  token: string;
  method: string;
  remaining: number;
  status: number;
  data: unknown;
}

const pending: PendingInterceptor[] = [];
let installed = false;
let originalFetch: typeof globalThis.fetch | undefined;

function pathFor(token: string, method: string): string {
  return `/bot${token}/${method}`;
}

export function intercept(
  token: string,
  method: string,
  times: number,
  response: { status?: number; data: unknown } = {
    data: { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } },
  },
): void {
  pending.push({
    token,
    method,
    remaining: times,
    status: response.status ?? 200,
    data: response.data,
  });
}

export function installFetchMock(): void {
  if (installed) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const requestMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const interceptor = pending.find(
      (item) => item.remaining > 0 && pathFor(item.token, item.method) === url.pathname,
    );
    if (!interceptor || requestMethod.toUpperCase() !== 'POST') {
      throw new Error(`Unexpected outbound fetch: ${requestMethod} ${url.pathname}`);
    }
    interceptor.remaining -= 1;
    return new Response(JSON.stringify(interceptor.data), {
      status: interceptor.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  installed = true;
}

export function uninstallFetchMock(): void {
  if (!installed || !originalFetch) return;
  globalThis.fetch = originalFetch;
  installed = false;
  originalFetch = undefined;
  pending.length = 0;
}

export function assertNoPendingInterceptors(): void {
  const leftovers = pending.filter((item) => item.remaining > 0);
  pending.length = 0;
  if (leftovers.length > 0) {
    const detail = leftovers
      .map((item) => `${item.method} on ${item.token.slice(0, 6)}… (${item.remaining} unused)`)
      .join(', ');
    throw new Error(`Unused Telegram interceptors: ${detail}`);
  }
}
