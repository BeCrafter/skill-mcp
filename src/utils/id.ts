import { customAlphabet } from "nanoid";

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789");

const MAX_RETRIES = 5;

/** 生成带前缀的短ID（对外暴露的实体用） */
export function generateId(prefix: string, size = 16): string {
  return `${prefix}${nano(size)}`;
}

/** 生成不带前缀的短ID（内部关联表用） */
export function shortId(size = 21): string {
  return nano(size);
}

/** 生成 API Token（sk-live-xxx 格式） */
export function generateToken(): string {
  return `sk-live-${nano(24)}`;
}

/**
 * 生成唯一 ID，碰撞时自动重试。
 * @param generator - ID 生成函数（如 `() => generateId("skl_")`）
 * @param exists    - 异步存在性检查，返回 true 表示 ID 已存在
 * @returns 唯一的 ID
 * @throws 碰撞超过 MAX_RETRIES 次时抛出错误
 */
export async function generateUniqueId(
  generator: () => string,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const id = generator();
    if (!(await exists(id))) return id;
  }
  throw new Error(`Failed to generate unique ID after ${MAX_RETRIES} attempts`);
}

/** 判断是否为旧版 UUID v4 格式 */
export function isLegacyUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
