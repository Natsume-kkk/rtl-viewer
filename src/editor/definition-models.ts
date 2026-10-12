import type * as monaco from "monaco-editor/editor/editor.api";
import { ModelStore } from "./model-store";

export interface ModelReference {
  object: { textEditorModel: monaco.editor.ITextModel };
  dispose(): void;
}

export interface BaseModelService {
  createModelReference(resource: monaco.Uri): Promise<ModelReference>;
  createSyntheticDocument(value: string, languageSelection: unknown): Promise<ModelReference>;
}

/** 保留 Monaco 原服务的模型包装；只为尚未打开的定义目标建立有界租用。 */
export class DefinitionModelService implements BaseModelService {
  constructor(
    private readonly store: ModelStore<monaco.Uri, monaco.editor.ITextModel>,
    private readonly existingModel: (resource: monaco.Uri) => monaco.editor.ITextModel | null,
    private readonly content: (resource: monaco.Uri) => string | undefined,
    private readonly language: (resource: monaco.Uri) => string,
    private readonly base: () => BaseModelService,
  ) {}

  async createModelReference(resource: monaco.Uri): Promise<ModelReference> {
    const content = this.existingModel(resource)?.getValue() ?? this.content(resource);
    if (content === undefined) throw new Error("Definition source unavailable");
    this.store.acquire(resource, content, this.language(resource), "preview");
    try {
      const reference = await this.base().createModelReference(resource);
      let released = false;
      return {
        object: reference.object,
        dispose: () => {
          if (released) return;
          released = true;
          try { reference.dispose(); }
          finally { this.store.release(resource.toString(), "preview"); }
        },
      };
    } catch (error) {
      this.store.release(resource.toString(), "preview");
      throw error;
    }
  }

  createSyntheticDocument(value: string, languageSelection: unknown): Promise<ModelReference> {
    return this.base().createSyntheticDocument(value, languageSelection);
  }
}
