import type { HttpContext } from "./context.js";

/**
 * Koa-style middleware contract: receive ctx + downstream `next`, optionally
 * await `next()` to invoke the rest of the chain. A middleware that returns
 * without calling `next()` short-circuits the chain (useful for auth guards
 * that have already written a 401/403 to the response).
 *
 * Optional `middlewareName` property is surfaced by `compose` in error
 * messages — set it via `named()` (or attach manually) so a double-`next()`
 * bug names the offender instead of just "compose: next() called multiple
 * times".
 */
export type Middleware = ((ctx: HttpContext, next: () => Promise<void>) => Promise<void>) & {
  middlewareName?: string;
};

/** Terminal route handler — converted into a Middleware by `wrapHandler`. */
export type RouteHandler = (ctx: HttpContext) => Promise<void>;

/** Adapt a leaf handler (no `next`) into the Middleware shape. */
export function wrapHandler(handler: RouteHandler): Middleware {
  const mw: Middleware = async (ctx, _next) => {
    await handler(ctx);
  };
  mw.middlewareName = "wrapHandler";
  return mw;
}

/**
 * Tag a middleware with a name for nicer error messages. Idempotent;
 * overwrites the previous name if any.
 */
export function named(name: string, mw: Middleware): Middleware {
  mw.middlewareName = name;
  return mw;
}

function describeMw(mw: Middleware | undefined, index: number): string {
  if (!mw) return `#${index}(<terminal>)`;
  return `#${index}(${mw.middlewareName ?? mw.name ?? "<anonymous>"})`;
}

/**
 * Compose an array of middleware into a single Middleware.
 * Order: mws[0] outermost (runs first, can wrap inner), mws[N-1] innermost.
 *
 * Throws if `next()` is called more than once within the same middleware
 * (catches the classic "double next()" bug early instead of letting it
 * silently produce duplicate writes to the response). The thrown error
 * names the offending middleware via its `middlewareName` so future
 * debuggers don't have to bisect the chain.
 */
export function compose(mws: Middleware[]): Middleware {
  return async (ctx, finalNext) => {
    let lastIndex = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= lastIndex) {
        const offender = describeMw(mws[i - 1], i - 1);
        throw new Error(`compose: next() called multiple times in ${offender}`);
      }
      lastIndex = i;
      const mw = mws[i];
      if (!mw) {
        await finalNext();
        return;
      }
      await mw(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
  };
}
