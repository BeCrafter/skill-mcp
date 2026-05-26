import type { ISkillProvider } from "./interface.js";
import { metrics } from "../telemetry/metrics.js";

// Wrap an ISkillProvider so every method observes provider_latency. We use a
// Proxy rather than per-method wrapping so adding a new method to the
// interface picks up metrics automatically. Sync getters pass through
// untouched; async-returning methods are timed end-to-end.
export function instrumentProvider(provider: ISkillProvider, providerLabel: string): ISkillProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const end = metrics.providerLatency.startTimer({
          provider: providerLabel,
          operation: String(prop),
        });
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          end({ status: "error" });
          throw err;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => { end({ status: "ok" }); return v; },
            (err) => { end({ status: "error" }); throw err; },
          );
        }
        end({ status: "ok" });
        return result;
      };
    },
  });
}
