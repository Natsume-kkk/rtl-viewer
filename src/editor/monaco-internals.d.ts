/** Monaco 0.57 内部纯函数的局部声明；升级时与实现一起核对。 */
declare module "monaco-editor/editor/common/core/cursorColumns" {
  export class CursorColumns {
    static visibleColumnFromColumn(lineContent: string, column: number, tabSize: number): number;
    static columnFromVisibleColumn(lineContent: string, visibleColumn: number, tabSize: number): number;
  }
}
