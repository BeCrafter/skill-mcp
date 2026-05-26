import type { Middleware } from "../compose.js";
import { named } from "../compose.js";
import { AppError, mapErrorToResponse } from "../../utils/errors.js";
import { json } from "../helpers.js";

/**
 * Catches every throw from downstream middleware / handlers and translates it
 * into an HTTP response via `mapErrorToResponse`.
 *
 * - `AppError` subclasses → their declared `statusCode` + `code`
 * - non-AppError → `500 Internal error` (logged at error level)
 *
 * Does nothing if the response has already been written (e.g. an auth guard
 * already wrote a 401), to avoid `ERR_HTTP_HEADERS_SENT`.
 */
export function errorMap(fallback = "Internal error"): Middleware {
  return named("errorMap", async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (ctx.res.headersSent || ctx.res.writableEnded) {
        ctx.logger.error(
          { err: error, url: ctx.url, method: ctx.method },
          "errorMap: caught error after response already sent",
        );
        return;
      }
      const { status, body } = mapErrorToResponse(error, fallback);
      if (error instanceof AppError) {
        // Domain-level — log at warn (expected error path), keep stack out of access logs.
        ctx.logger.warn(
          { code: error.code, status, url: ctx.url, method: ctx.method },
          error.message,
        );
      } else {
        ctx.logger.error(
          { err: error, url: ctx.url, method: ctx.method },
          "errorMap: unhandled error",
        );
      }
      json(ctx.res, status, body);
    }
  });
}
