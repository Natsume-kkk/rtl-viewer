/** Windows 文件身份；显示和 IO 仍保留原始路径。 */
export function filePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function sameFilePath(a: string, b: string): boolean {
  return filePathKey(a) === filePathKey(b);
}

/** 优先直接命中，只有路径大小写不同才查找已有工程路径。 */
export function indexedFilePath<T>(files: Map<string, T>, path: string): string {
  if (files.has(path)) return path;
  const key = filePathKey(path);
  for (const file of files.keys()) if (filePathKey(file) === key) return file;
  return path;
}
