import { realpathSync, statSync } from "node:fs";

/** 未配置时跳过；显式指定错误路径不能被当作验收通过。 */
export function acceptanceRoot(variable: string): string | undefined {
  const value = process.env[variable];
  if (!value) return undefined;
  try {
    const root = realpathSync(value);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch {
    throw new Error(`${variable} 必须指向存在的验收工程目录`);
  }
}
