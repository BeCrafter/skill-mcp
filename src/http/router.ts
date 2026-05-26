import type { HttpContext } from "./context.js";
import type { Middleware, RouteHandler } from "./compose.js";
import { compose, wrapHandler } from "./compose.js";

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: Middleware[] = [];

  /**
   * Register router-level middleware that runs before every matched handler
   * (in registration order). Use for cross-cutting concerns like errorMap,
   * request logging, etc. Per-route middleware is intentionally not supported
   * to keep the router minimal — compose what you need at dispatch time.
   */
  use(mw: Middleware): void {
    this.middlewares.push(mw);
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:([a-zA-Z_]+)/g, (_match, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void { this.addRoute("GET", path, handler); }
  post(path: string, handler: RouteHandler): void { this.addRoute("POST", path, handler); }
  put(path: string, handler: RouteHandler): void { this.addRoute("PUT", path, handler); }
  delete(path: string, handler: RouteHandler): void { this.addRoute("DELETE", path, handler); }

  match(method: string, url: string): RouteMatch | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = url.match(route.pattern);
      if (m) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
        }
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  /**
   * Match `(method, url)` and dispatch through the router-level middleware
   * chain plus the matched handler. Returns `false` if no route matched (the
   * caller can then fall through to a 404). Returns `true` after the handler
   * (and any middleware) has fully resolved or thrown — errors propagate to
   * the caller, so wrap with `errorMap` middleware to translate them to HTTP.
   */
  async dispatch(ctx: HttpContext): Promise<boolean> {
    const match = this.match(ctx.method, ctx.url);
    if (!match) return false;
    ctx.params = match.params;
    const chain = compose([...this.middlewares, wrapHandler(match.handler)]);
    await chain(ctx, async () => {});
    return true;
  }
}
