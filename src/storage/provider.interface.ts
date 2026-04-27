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

  /** List files in a directory (non-recursive) */
  list(prefix: string): Promise<string[]>;

  /** List all files recursively under a prefix, returning relative paths */
  listRecursive(prefix: string): Promise<string[]>;

  /** Check if a path is a directory */
  isDirectory(path: string): Promise<boolean>;

  /** Get total size of a path */
  size(path: string): Promise<number>;
}
