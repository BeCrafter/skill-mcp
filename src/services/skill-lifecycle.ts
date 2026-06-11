// P0-9 — skill lifecycle state machine.
//
//        ┌─────────┐ publish  ┌───────────┐ deprecate ┌────────────┐
//        │  draft  ├─────────▶│ published ├──────────▶│ deprecated │
//        └─────┬───┘          └─────┬─────┘           └─────┬──────┘
//              │ archive            │ archive               │ archive
//              ▼                    ▼                       ▼
//        ┌──────────┐          ┌──────────┐            ┌──────────┐
//        │ archived │          │ archived │            │ archived │
//        └──────────┘          └──────────┘            └──────────┘
//
// `republish` (deprecated → published) is allowed because the review doc §1.3
// describes deprecation as soft-retire, not a terminal state. `archived` is
// terminal: revival requires a fresh skill or import. `draft → deprecated`
// is rejected because deprecation only makes sense for published skills.

import type { SkillStatus } from "../types/index.js";
import { AppError } from "../utils/errors.js";

export const ALL_LIFECYCLE_STATES: readonly SkillStatus[] = [
  "draft",
  "published",
  "deprecated",
  "archived",
];

const TRANSITIONS: Record<SkillStatus, ReadonlySet<SkillStatus>> = {
  draft:      new Set(["published", "archived"]),
  published:  new Set(["deprecated", "archived"]),
  deprecated: new Set(["published", "archived"]),
  archived:   new Set(),
};

export class IllegalTransitionError extends AppError {
  constructor(public from: SkillStatus, public to: SkillStatus) {
    super(`Illegal lifecycle transition: ${from} → ${to}`, "ILLEGAL_LIFECYCLE_TRANSITION", 409);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: SkillStatus, to: SkillStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: SkillStatus, to: SkillStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function nextStates(from: SkillStatus): SkillStatus[] {
  return Array.from(TRANSITIONS[from] ?? []);
}
