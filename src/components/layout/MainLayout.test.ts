import { Children, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type ScrollRef = {
  current: { scrollTop: number };
};

async function importMainLayoutForRoute(
  pathname: string,
  mainScrollRef: ScrollRef,
  fileTransferScrollRef: ScrollRef
) {
  vi.resetModules();
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    const refs = [mainScrollRef, fileTransferScrollRef];

    return {
      ...actual,
      useLayoutEffect: (effect: () => void) => effect(),
      useRef: () => {
        const ref = refs.shift();
        if (!ref) throw new Error("Unexpected useRef call");
        return ref;
      },
    };
  });
  vi.doMock("react-router-dom", () => ({
    Outlet: () => null,
    useLocation: () => ({ pathname }),
  }));
  vi.doMock("./Sidebar", () => ({
    Sidebar: () => null,
  }));
  vi.doMock("./Header", () => ({
    Header: () => null,
  }));
  vi.doMock("@/components/ui/tooltip", () => ({
    TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
  vi.doMock("@/pages/TerminalPage", () => ({
    TerminalPage: () => null,
  }));
  vi.doMock("@/pages/FileTransferWorkspace", () => ({
    FileTransferWorkspace: () => null,
  }));

  return import("./MainLayout");
}

function getPersistentWorkspaceMains(layout: ReactElement): {
  terminalMain: ReactElement;
  workspaceMain: ReactElement;
} {
  const appShell = layout.props.children as ReactElement;
  const contentColumn = Children.toArray(appShell.props.children)[1] as ReactElement;
  const contentChildren = Children.toArray(contentColumn.props.children);

  return {
    terminalMain: contentChildren.at(-2) as ReactElement,
    workspaceMain: contentChildren.at(-1) as ReactElement,
  };
}

function getElementRef(element: ReactElement): unknown {
  return (element as ReactElement & { ref?: unknown }).ref;
}

describe("MainLayout scroll restoration", () => {
  afterEach(() => {
    vi.doUnmock("react");
    vi.doUnmock("react-router-dom");
    vi.doUnmock("./Sidebar");
    vi.doUnmock("./Header");
    vi.doUnmock("@/components/ui/tooltip");
    vi.doUnmock("@/pages/TerminalPage");
    vi.doUnmock("@/pages/FileTransferWorkspace");
    vi.resetModules();
  });

  it("resets the reused page scroll container to the top on route changes", async () => {
    const scrollContainer = { scrollTop: 320 };
    const { MainLayout } = await importMainLayoutForRoute(
      "/connections",
      { current: scrollContainer },
      { current: { scrollTop: 0 } }
    );

    MainLayout();

    expect(scrollContainer.scrollTop).toBe(0);
  });

  it("keeps the terminal route from touching the hidden page scroll container", async () => {
    const scrollContainer = { scrollTop: 320 };
    const { MainLayout } = await importMainLayoutForRoute(
      "/terminal",
      { current: scrollContainer },
      { current: { scrollTop: 0 } }
    );

    MainLayout();

    expect(scrollContainer.scrollTop).toBe(320);
  });

  it("进入文件传输连接详情时重置文件传输工作区的滚动位置", async () => {
    const mainScrollContainer = { scrollTop: 320 };
    const fileTransferContainer = { scrollTop: 320 };
    const fileTransferScrollRef = { current: fileTransferContainer };
    const { MainLayout } = await importMainLayoutForRoute(
      "/file-transfer/conn-1",
      { current: mainScrollContainer },
      fileTransferScrollRef
    );

    const { terminalMain, workspaceMain } = getPersistentWorkspaceMains(
      MainLayout() as ReactElement
    );

    expect(fileTransferContainer.scrollTop).toBe(0);
    expect(mainScrollContainer.scrollTop).toBe(320);
    expect(getElementRef(terminalMain)).toBeNull();
    expect(getElementRef(workspaceMain)).toBe(fileTransferScrollRef);
  });

  it("uses the standard scrollable page container for the file-transfer workspace", async () => {
    const { MainLayout } = await importMainLayoutForRoute(
      "/file-transfer",
      { current: { scrollTop: 0 } },
      { current: { scrollTop: 0 } }
    );

    const { workspaceMain } = getPersistentWorkspaceMains(
      MainLayout() as ReactElement
    );
    const className = workspaceMain.props.className as string;

    expect(className).toContain("overflow-auto");
    expect(className).toContain("bg-muted/30");
    expect(className).toContain("p-6");
  });

  it("进入任意文件传输连接详情时重置工作区滚动位置", async () => {
    const { shouldResetFileTransferScroll } = await importMainLayoutForRoute(
      "/file-transfer",
      { current: { scrollTop: 0 } },
      { current: { scrollTop: 0 } }
    );

    expect(shouldResetFileTransferScroll("/file-transfer/conn-1")).toBe(true);
    expect(shouldResetFileTransferScroll("/file-transfer/conn-2")).toBe(true);
    expect(shouldResetFileTransferScroll("/file-transfer")).toBe(false);
  });
});
