import { describe, expect, it, vi } from "vitest";
import type * as monaco from "monaco-editor/editor/editor.api";
import { URI } from "monaco-editor/base/common/uri";
// 使用实际 Monaco 0.57 服务，覆盖其延迟返回引用的生命周期。
import { InMemoryTextModelService } from "monaco-editor/editor/common/services/inMemoryTextModelService";
import { DefinitionModelService, type BaseModelService } from "../src/editor/definition-models";
import { ModelStore } from "../src/editor/model-store";
import { pathFromUri } from "../src/editor/file-path";

function setup() {
  const uri = URI.file("D:/rtl/子目录/child%23.sv");
  const live = new Map<string, monaco.editor.ITextModel>();
  const contents = new Map([[pathFromUri(uri), "module child; endmodule"]]);
  const createModel = vi.fn((content: string, _language: unknown, resource: monaco.Uri) => {
    let disposed = false;
    let value = content;
    const model = {
      uri: resource,
      getValue: () => value,
      setValue: (next: string) => { value = next; },
      isDisposed: () => disposed,
      dispose: vi.fn(() => { disposed = true; live.delete(resource.toString()); }),
    } as unknown as monaco.editor.ITextModel;
    live.set(resource.toString(), model);
    return model;
  });
  const editor = { createModel, getModel: (resource: monaco.Uri) => live.get(resource.toString()) ?? null };
  const store = new ModelStore(editor);
  const base: BaseModelService = new InMemoryTextModelService(editor);
  const service = new DefinitionModelService(store, editor.getModel, resource => contents.get(pathFromUri(resource)), () => "verilog", () => base);
  return { uri, live, contents, createModel, store, base, service };
}

describe("definition target models", () => {
  it("路径大小写别名预览引用实际共享模型 URI，释放后保留标签", async () => {
    const { uri, contents, store, service, createModel } = setup();
    const alias = URI.file(pathFromUri(uri).toUpperCase());
    contents.set(pathFromUri(alias), "disk content");
    const model = store.acquire(uri, "unsaved content", "verilog");
    const reference = await service.createModelReference(alias);
    expect(reference.object.textEditorModel).toBe(model);
    expect(model.getValue()).toBe("unsaved content");
    expect(createModel).toHaveBeenCalledTimes(1);
    reference.dispose();
    expect(model.isDisposed()).toBe(false);
    store.release(alias.toString());
    expect(model.isDisposed()).toBe(true);
  });
  it("previews an unopened definition on demand and releases the model", async () => {
    const { uri, live, createModel, service } = setup();
    expect(live.size).toBe(0);
    const reference = await service.createModelReference(uri);
    expect(reference.object.textEditorModel.getValue()).toBe("module child; endmodule");
    expect(createModel).toHaveBeenCalledTimes(1);
    reference.dispose();
    expect(live.size).toBe(0);
    expect(reference.object.textEditorModel.isDisposed()).toBe(true);
    reference.dispose();
    expect(createModel.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses the unsaved tab buffer without replacing its content", async () => {
    const { uri, store, service, createModel } = setup();
    const model = store.acquire(uri, "module unsaved; endmodule", "verilog");
    const reference = await service.createModelReference(uri);
    expect(reference.object.textEditorModel).toBe(model);
    expect(model.getValue()).toBe("module unsaved; endmodule");
    reference.dispose();
    expect(model.isDisposed()).toBe(false);
    expect(createModel).toHaveBeenCalledTimes(1);
    store.release(uri.toString());
    expect(model.isDisposed()).toBe(true);
  });

  it("shares concurrent previews until the last reference is released", async () => {
    const { uri, live, createModel, service } = setup();
    const [left, right] = await Promise.all([service.createModelReference(uri), service.createModelReference(uri)]);
    expect(left.object.textEditorModel).toBe(right.object.textEditorModel);
    expect(createModel).toHaveBeenCalledTimes(1);
    left.dispose();
    expect(live.size).toBe(1);
    right.dispose();
    expect(live.size).toBe(0);
  });

  it("lets a tab take over a preview model and retains it for both views", async () => {
    const { uri, service, store } = setup();
    const preview = await service.createModelReference(uri);
    const left = store.acquire(uri, "disk content", "verilog");
    const right = store.acquire(uri, "other content", "verilog");
    expect(left).toBe(preview.object.textEditorModel);
    expect(right).toBe(left);
    preview.dispose();
    store.release(uri.toString());
    expect(left.isDisposed()).toBe(false);
    store.release(uri.toString());
    expect(left.isDisposed()).toBe(true);
  });

  it("protects a preview while its tab closes and creates fresh content when reopened", async () => {
    const { uri, contents, service, store, createModel } = setup();
    const tab = store.acquire(uri, "old content", "verilog");
    const preview = await service.createModelReference(uri);
    store.release(uri.toString());
    expect(tab.isDisposed()).toBe(false);
    preview.dispose();
    contents.set(pathFromUri(uri), "new content");
    const reopened = await service.createModelReference(uri);
    expect(reopened.object.textEditorModel).not.toBe(tab);
    expect(reopened.object.textEditorModel.getValue()).toBe("new content");
    expect(createModel).toHaveBeenCalledTimes(2);
    reopened.dispose();
  });

  it("uses freshly read disk content when reopening a discarded tab during a preview", async () => {
    const { uri, service, store } = setup();
    const tab = store.acquire(uri, "unsaved change", "verilog");
    const preview = await service.createModelReference(uri);
    store.release(uri.toString());
    expect(tab.isDisposed()).toBe(false);
    const reopened = store.acquire(uri, "saved disk content", "verilog");
    expect(reopened.getValue()).toBe("saved disk content");
    expect(preview.object.textEditorModel).toBe(reopened);
    preview.dispose();
    expect(reopened.isDisposed()).toBe(false);
    store.release(uri.toString());
    expect(reopened.isDisposed()).toBe(true);
  });

  it("refreshes a preview-only model when the first tab opens after a disk change", async () => {
    const { uri, service, store } = setup();
    const [left, right] = await Promise.all([service.createModelReference(uri), service.createModelReference(uri)]);
    const tab = store.acquire(uri, "fresh disk content", "verilog");
    expect(tab.getValue()).toBe("fresh disk content");
    tab.setValue("new unsaved edit");
    const otherTab = store.acquire(uri, "older disk content", "verilog");
    expect(otherTab.getValue()).toBe("new unsaved edit");
    left.dispose();
    right.dispose();
    store.release(uri.toString());
    expect(tab.isDisposed()).toBe(false);
    store.release(uri.toString());
    expect(tab.isDisposed()).toBe(true);
  });

  it("releases a canceled preview as soon as its pending reference arrives", async () => {
    const { uri, live, service } = setup();
    const pending = service.createModelReference(uri);
    const reference = await pending;
    reference.dispose();
    expect(live.size).toBe(0);
  });

  it("does not create a fake model when the source disappears", async () => {
    const { uri, contents, live, service, createModel } = setup();
    contents.clear();
    await expect(service.createModelReference(uri)).rejects.toThrow("Definition source unavailable");
    expect(createModel).not.toHaveBeenCalled();
    expect(live.size).toBe(0);
  });

  it("keeps an open unsaved buffer usable after its project source disappears", async () => {
    const { uri, contents, service, store } = setup();
    const tab = store.acquire(uri, "unsaved", "verilog");
    contents.clear();
    const reference = await service.createModelReference(uri);
    expect(reference.object.textEditorModel).toBe(tab);
    reference.dispose();
    store.release(uri.toString());
  });

  it("allows empty source content and preserves external model ownership", async () => {
    const { uri, contents, service, createModel, live } = setup();
    contents.set(pathFromUri(uri), "");
    const empty = await service.createModelReference(uri);
    expect(empty.object.textEditorModel.getValue()).toBe("");
    empty.dispose();
    const external = createModel("external", "verilog", uri);
    const borrowed = await service.createModelReference(uri);
    borrowed.dispose();
    expect(external.isDisposed()).toBe(false);
    expect(live.size).toBe(1);
    external.dispose();
  });

  it("releases its lease if the base service rejects", async () => {
    const { uri, service, base, live } = setup();
    vi.spyOn(base, "createModelReference").mockRejectedValue(new Error("failed"));
    await expect(service.createModelReference(uri)).rejects.toThrow("failed");
    expect(live.size).toBe(0);
  });

  it("releases its lease even if disposing the base reference throws", async () => {
    const { uri, service, base, live } = setup();
    const create = base.createModelReference.bind(base);
    vi.spyOn(base, "createModelReference").mockImplementation(async resource => {
      const reference = await create(resource);
      return { object: reference.object, dispose: () => { reference.dispose(); throw new Error("dispose failed"); } };
    });
    const reference = await service.createModelReference(uri);
    expect(() => reference.dispose()).toThrow("dispose failed");
    expect(live.size).toBe(0);
  });

  it("preserves the base synthetic-document lifecycle", async () => {
    const { service, live } = setup();
    const reference = await service.createSyntheticDocument("synthetic", null);
    expect(reference.object.textEditorModel.getValue()).toBe("synthetic");
    expect(live.size).toBe(1);
    reference.dispose();
    expect(live.size).toBe(0);
  });
});
