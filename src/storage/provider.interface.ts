export interface IStorageProvider {
  /** Read a file as Buffer */
  get(path: string): Promise<Buffer | null>;

  /** Check if a file exists */
  exists(path: string): Promise<boolean>;

  /** Write a file */
  put(path: string, data: Buffer): Promise<void>;

  /** Delete a file */
  delete(path: string): Promise<void>;

  /** Recursively delete a directory and all its contents */
  deleteDir(prefix: string): Promise<void>;

  /**
   * Move/rename a directory from `srcPrefix` to `dstPrefix`.
   *
   * Local FS uses an atomic `fs.rename` when src and dst sit on the same
   * filesystem (the common case for skill imports inside a single base
   * path). Object stores (e.g. OSS) implement copy+delete per object — not
   * atomic across many objects, but the importer pairs this with a staging
   * directory and idempotent retry semantics so partial failures are
   * recoverable.
   *
   * If `dstPrefix` already exists, the implementation is allowed to refuse
   * (callers are expected to `deleteDir(dstPrefix)` first when they want
   * overwrite semantics).
   */
  moveDir(srcPrefix: string, dstPrefix: string): Promise<void>;

  /** List files in a directory (non-recursive) */
  list(prefix: string): Promise<string[]>;

  /** List all files recursively under a prefix, returning relative paths */
  listRecursive(prefix: string): Promise<string[]>;

  /** Check if a path is a directory */
  isDirectory(path: string): Promise<boolean>;

  /** Get total size of a path */
  size(path: string): Promise<number>;
}
