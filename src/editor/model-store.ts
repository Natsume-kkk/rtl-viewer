import type * as monaco from "monaco-editor/editor/editor.api";

interface ModelUri { toString(): string }
interface ManagedModel { dispose(): void; isDisposed(): boolean; setValue(content: string): void }
type ModelOwner = "tab" | "preview";

/** 标签和按需预览共用引用计数；外部创建的模型只借用，不接管其销毁权。 */
export class ModelStore<U extends ModelUri, M extends ManagedModel> {
  private entries = new Map<string, { model: M; refs: number; tabs: number; owned: boolean }>();

  constructor(private readonly editor: {
    getModel(uri: U): M | null;
    createModel(content: string, language: string, uri: U): M;
  }) {}

  acquire(uri: U, content: string, language: string, owner: ModelOwner = "tab"): M {
    const key = uri.toString();
    const entry = this.entries.get(key);
    if (entry && !entry.model.isDisposed()) {
      const takingOver = owner === "tab" && entry.tabs === 0 && entry.owned;
      entry.refs += 1;
      if (owner === "tab") entry.tabs += 1;
      // 只有预览引用存活时，旧缓冲不再代表打开中的编辑内容。
      // 首个标签采用此次真实打开内容，同时重置已放弃编辑的撤销历史。
      if (takingOver) {
        try { entry.model.setValue(content); }
        catch (error) {
          entry.refs -= 1;
          entry.tabs -= 1;
          throw error;
        }
      }
      return entry.model;
    }
    const existing = this.editor.getModel(uri);
    const model = existing ?? this.editor.createModel(content, language, uri);
    this.entries.set(key, { model, refs: 1, tabs: owner === "tab" ? 1 : 0, owned: !existing });
    return model;
  }

  release(key: string, owner: ModelOwner = "tab"): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (owner === "tab") entry.tabs -= 1;
    if (--entry.refs > 0) return;
    this.entries.delete(key);
    if (entry.owned && !entry.model.isDisposed()) entry.model.dispose();
  }
}

type SharedStore = ModelStore<monaco.Uri, monaco.editor.ITextModel>;
const stores = new WeakMap<object, SharedStore>();

export function sharedModelStore(editor: Pick<typeof monaco.editor, "getModel" | "createModel">): SharedStore {
  let store = stores.get(editor);
  if (!store) {
    store = new ModelStore<monaco.Uri, monaco.editor.ITextModel>(editor);
    stores.set(editor, store);
  }
  return store;
}
