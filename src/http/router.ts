import type { HttpContext } from "./context.js";

export type RouteHandler = (ctx: HttpContext) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

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

  match(method: string, url: string): { handler: RouteHandler; params: Record<string, string> } | null {
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
}
