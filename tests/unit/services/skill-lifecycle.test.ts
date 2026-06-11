import { describe, it, expect } from "vitest";
import {
  ALL_LIFECYCLE_STATES,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  nextStates,
} from "@/services/skill-lifecycle.js";
import type { SkillStatus } from "@/types/index.js";

const LEGAL: Array<[SkillStatus, SkillStatus]> = [
  ["draft", "published"],
  ["draft", "archived"],
  ["published", "deprecated"],
  ["published", "archived"],
  ["deprecated", "published"],
  ["deprecated", "archived"],
];

describe("skill lifecycle state machine", () => {
  it("declares the four canonical states in order", () => {
    expect(ALL_LIFECYCLE_STATES).toEqual(["draft", "published", "deprecated", "archived"]);
  });

  describe("canTransition matrix", () => {
    for (const [from, to] of LEGAL) {
      it(`allows ${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(true);
      });
    }

    it("rejects every transition out of archived (terminal)", () => {
      for (const target of ALL_LIFECYCLE_STATES) {
        expect(canTransition("archived", target)).toBe(false);
      }
    });

    it("rejects no-op transitions (same state)", () => {
      for (const s of ALL_LIFECYCLE_STATES) {
        expect(canTransition(s, s)).toBe(false);
      }
    });

    it("rejects draft → deprecated (only published can be deprecated)", () => {
      expect(canTransition("draft", "deprecated")).toBe(false);
    });
  });

  describe("assertTransition", () => {
    it("throws IllegalTransitionError on illegal transition with 409 status", () => {
      try {
        assertTransition("archived", "published");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        const e = err as IllegalTransitionError;
        expect(e.from).toBe("archived");
        expect(e.to).toBe("published");
        expect(e.statusCode).toBe(409);
        expect(e.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
      }
    });

    it("returns silently on a legal transition", () => {
      expect(() => assertTransition("draft", "published")).not.toThrow();
    });
  });

  describe("nextStates", () => {
    it("returns the legal next states for each source", () => {
      expect(nextStates("draft").sort()).toEqual(["archived", "published"]);
      expect(nextStates("published").sort()).toEqual(["archived", "deprecated"]);
      expect(nextStates("deprecated").sort()).toEqual(["archived", "published"]);
      expect(nextStates("archived")).toEqual([]);
    });
  });
});
