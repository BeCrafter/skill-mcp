import type { HttpContext } from "../context.js";
import type { RequestContext } from "../../types/index.js";
import { enforceAuth, type AuthMiddlewareDeps } from "./admin-auth.js";

/** Gateway auth — authenticates the token but does NOT require admin userType. */
export function enforceGatewayAuth(ctx: HttpContext, deps: AuthMiddlewareDeps): Promise<RequestContext | null> {
  return enforceAuth(ctx, deps);
}
