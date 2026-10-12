import * as monaco from "monaco-editor/editor/editor.api";

const editors = new Set<monaco.editor.IStandaloneCodeEditor>();
const registrations = new Set<{ attach(editor: monaco.editor.IStandaloneCodeEditor): void; detach(editor: monaco.editor.IStandaloneCodeEditor): void }>();

/** 在 standalone 编辑器构造完毕后安装；创建事件早于其键位服务初始化。 */
export function installEditorActions(editor: monaco.editor.IStandaloneCodeEditor): void {
  editors.add(editor);
  registrations.forEach(registration => registration.attach(editor));
  editor.onDidDispose(() => {
    registrations.forEach(registration => registration.detach(editor));
    editors.delete(editor);
  });
}

/** 保留全局键位分发，同时将动作加入每个编辑器的命令面板。 */
export function registerEditorAction(descriptor: monaco.editor.IActionDescriptor): monaco.IDisposable {
  const command = monaco.editor.addEditorAction(descriptor);
  const bindings = new Map<monaco.editor.IStandaloneCodeEditor, monaco.IDisposable>();
  const attach = (editor: monaco.editor.IStandaloneCodeEditor) => {
    if (bindings.has(editor)) return;
    // addAction 会生成 editorId:id。这里只注册面板入口，避免重复键位和菜单项。
    const action = editor.addAction({
      id: descriptor.id, label: descriptor.label, precondition: descriptor.precondition,
      run: descriptor.run,
    });
    bindings.set(editor, action);
  };
  const registration = { attach, detach(editor: monaco.editor.IStandaloneCodeEditor) {
    bindings.get(editor)?.dispose(); bindings.delete(editor);
  } };
  registrations.add(registration);
  editors.forEach(attach);
  return { dispose() {
    registrations.delete(registration);
    bindings.forEach(binding => binding.dispose());
    bindings.clear();
    command.dispose();
  } };
}
