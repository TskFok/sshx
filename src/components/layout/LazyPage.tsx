import { Component, Suspense, lazy, type ComponentType } from "react";

/** 每个页面独立处理加载失败；重试创建新的 lazy 实例，清除 React 缓存的拒绝结果。 */
export function createLazyPage(load: () => Promise<{ default: ComponentType }>, label: string) {
  return class LazyPage extends Component {
    state = { failed: false, Page: lazy(load) };

    static getDerivedStateFromError() {
      return { failed: true };
    }

    render() {
      if (this.state.failed) {
        return (
          <div role="alert" className="flex items-center justify-center gap-3 p-6 text-sm">
            <span>{label}加载失败</span>
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 hover:bg-muted"
              onClick={() => this.setState({ failed: false, Page: lazy(load) })}
            >
              重试
            </button>
          </div>
        );
      }
      const Page = this.state.Page;
      return (
        <Suspense fallback={<div role="status" className="p-6 text-sm text-muted-foreground">正在加载{label}…</div>}>
          <Page />
        </Suspense>
      );
    }
  };
}
