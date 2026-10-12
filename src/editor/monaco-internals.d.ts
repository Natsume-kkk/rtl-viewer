/** Monaco 0.57 内部纯函数的局部声明；升级时与实现一起核对。 */
declare module "monaco-editor/editor/common/core/cursorColumns" {
  export class CursorColumns {
    static visibleColumnFromColumn(lineContent: string, column: number, tabSize: number): number;
    static columnFromVisibleColumn(lineContent: string, visibleColumn: number, tabSize: number): number;
  }
}

declare module "monaco-editor/editor/standalone/browser/standaloneServices" {
  export const StandaloneServices: {
    initialize(overrides: Record<string, unknown>): unknown;
    get(service: unknown): unknown;
  };
}

declare module "monaco-editor/editor/common/services/model" {
  export const IModelService: unknown;
}

declare module "monaco-editor/editor/common/services/inMemoryTextModelService" {
  type ModelReference = {
    object: { textEditorModel: import("monaco-editor/editor/editor.api").editor.ITextModel };
    dispose(): void;
  };
  export class InMemoryTextModelService {
    constructor(modelService: unknown);
    createModelReference(resource: import("monaco-editor/editor/editor.api").Uri): Promise<ModelReference>;
    createSyntheticDocument(value: string, languageSelection: unknown): Promise<ModelReference>;
  }
}

declare module "monaco-editor/base/common/uri" {
  export const URI: typeof import("monaco-editor/editor/editor.api").Uri;
}
