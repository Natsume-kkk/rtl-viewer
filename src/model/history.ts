export interface NavEntry {
  path: string;
  line: number;
}

/**
 * 编辑器导航历史：跳转前 push 当前位置，后退/前进时不记录。
 * 同一位置连续 push 会去重。
 */
export class NavHistory {
  private backStack: NavEntry[] = [];
  private fwdStack: NavEntry[] = [];
  private capacity: number;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  get canBack(): boolean {
    return this.backStack.length > 0;
  }

  get canForward(): boolean {
    return this.fwdStack.length > 0;
  }

  /** 跳转前记录离开的位置。 */
  push(entry: NavEntry): void {
    const top = this.backStack[this.backStack.length - 1];
    if (top && top.path === entry.path && top.line === entry.line) return;
    this.backStack.push(entry);
    if (this.backStack.length > this.capacity) this.backStack.shift();
    this.fwdStack = [];
  }

  /** 后退：把当前位置压入前进栈，返回要去的位置。 */
  goBack(current: NavEntry): NavEntry | undefined {
    const target = this.backStack.pop();
    if (!target) return undefined;
    this.fwdStack.push(current);
    return target;
  }

  /** 前进：把当前位置压回后退栈，返回要去的位置。 */
  goForward(current: NavEntry): NavEntry | undefined {
    const target = this.fwdStack.pop();
    if (!target) return undefined;
    this.backStack.push(current);
    return target;
  }

  clear(): void {
    this.backStack = [];
    this.fwdStack = [];
  }
}
