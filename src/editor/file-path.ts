import type { monaco } from "./monaco";

/** Monaco URI 的 path 已解码，不能再次 decodeURIComponent（文件名可含 %）。 */
export function pathFromUri(uri: Pick<monaco.Uri, "path" | "authority">): string {
  return (uri.authority ? `//${uri.authority}${uri.path}` : uri.path).replace(/^\/(?=[A-Za-z]:)/, "");
}
