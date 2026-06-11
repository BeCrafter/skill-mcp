-- P1-11 (stage 3) — Sidecar table for skill embedding vectors.
--
-- Rationale for a sidecar (rather than another column on `skills`):
--   1. Embeddings are MUCH larger than every other column on `skills`
--      (a 384-dim float32 vector is 1.5 KiB; a 1536-dim OpenAI vector is
--      6 KiB). Putting them on the hot row would inflate every SELECT *
--      that touches the table and bloat the page size.
--   2. They are cold relative to `skills` — read at search time, written
--      only when content or model changes. A separate page set keeps the
--      `skills` working set small.
--   3. A future migration to pgvector / a vector store can swap the
--      backing impl by routing this table through a different repo
--      without disturbing the rest of the schema.
--
-- One row per skill (PK = skill_id). When the model swaps, the existing
-- row is overwritten; `model_name` lets the search service detect rows
-- written by a previous model and trigger re-embedding (rather than
-- silently mixing dimensions).
--
-- `vector` is stored as BLOB (Float32Array's underlying buffer). SQLite's
-- BLOB is opaque to SQL — no `WHERE vector @@ ...` queries; the in-memory
-- VectorIndex does cosine sim. When the project moves to Postgres + pgvector
-- the column type becomes `vector(N)` and the index becomes an `ivfflat` /
-- `hnsw`, but the repository surface stays the same.
--
-- `content_hash` mirrors `skills.content_hash` at the moment the embedding
-- was computed. Re-embedding only happens when content_hash *or* model_name
-- changes — keeps the LLM bill from re-running on every cosmetic update.
CREATE TABLE `skill_embeddings` (
  `skill_id` text PRIMARY KEY NOT NULL,
  `model_name` text NOT NULL,
  `dimension` integer NOT NULL,
  `vector` blob NOT NULL,
  `content_hash` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_skill_embeddings_model` ON `skill_embeddings`(`model_name`);
