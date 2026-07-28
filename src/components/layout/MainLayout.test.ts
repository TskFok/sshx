import { Children, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importMainLayoutForRoute(
  pathname: string,
  scrollContainer: { scrollTop: number }
) {
  vi.resetModules();
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");

    return {
      ...actual,
      useLayoutEffect: (effect: () => void) => effect(),
      useRef: () => ({ current: scrollContainer }),
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

function getWorkspaceMainClassName(layout: ReactElement): string {
  const appShell = layout.props.children as ReactElement;
  const contentColumn = Children.toArray(appShell.props.children)[1] as ReactElement;
  const workspaceMain = Children.toArray(contentColumn.props.children).at(
    -1
  ) as ReactElement;

  return workspaceMain.props.className as string;
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
      scrollContainer
    );

    MainLayout();

    expect(scrollContainer.scrollTop).toBe(0);
  });

  it("keeps the terminal route from touching the hidden page scroll container", async () => {
    const scrollContainer = { scrollTop: 320 };
    const { MainLayout } = await importMainLayoutForRoute(
      "/terminal",
      scrollContainer
    );

    MainLayout();

    expect(scrollContainer.scrollTop).toBe(320);
  });

  it("keeps the file-transfer workspace route from touching the hidden page scroll container", async () => {
    const scrollContainer = { scrollTop: 320 };
    const { MainLayout } = await importMainLayoutForRoute(
      "/file-transfer/conn-1",
      scrollContainer
    );

    MainLayout();

    expect(scrollContainer.scrollTop).toBe(320);
  });

  it("uses the standard scrollable page container for the file-transfer workspace", async () => {
    const { MainLayout } = await importMainLayoutForRoute("/file-transfer", {
      scrollTop: 0,
    });

    const className = getWorkspaceMainClassName(MainLayout() as ReactElement);

    expect(className).toContain("overflow-auto");
    expect(className).toContain("bg-muted/30");
    expect(className).toContain("p-6");
  });
});
