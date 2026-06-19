export function getFilePanelLayoutClasses() {
  const gridMinHeight = "min-h-[460px]";

  return {
    grid: `grid ${gridMinHeight} flex-1 gap-4 lg:grid-cols-2`,
    card: `flex ${gridMinHeight} min-w-0 flex-col overflow-hidden`,
    header: "space-y-3 pb-3",
    infoBar: "truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground",
    content: "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden",
    list: "min-h-0 flex-1 pr-3",
    footer: "min-w-0 shrink-0",
    footerActions: "flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center",
    footerActionButton: "w-full min-w-0 sm:w-auto",
  };
}

export function getFileTransferHistoryLayoutClasses() {
  return {
    card: "min-h-[220px] min-w-0 shrink-0 overflow-hidden",
    content: "min-w-0 overflow-hidden",
    scrollArea: "h-[400px] min-w-0 overflow-hidden pr-3",
    list: "min-w-0 space-y-2",
    row: "min-h-[72px] min-w-0 overflow-hidden rounded-md border bg-background p-3",
    rowBody:
      "flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between",
    details: "min-w-0 flex-1 overflow-hidden",
    summary: "flex min-w-0 flex-wrap items-center gap-2 overflow-hidden",
    fileName: "min-w-0 max-w-full flex-1 truncate font-mono text-sm",
    fileSize: "shrink-0 text-xs text-muted-foreground",
    pathGrid: "mt-2 grid min-w-0 gap-1 text-xs text-muted-foreground lg:grid-cols-2",
    pathButton:
      "block w-full min-w-0 truncate rounded-md border-0 bg-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    error: "mt-1 min-w-0 break-all text-xs text-destructive",
    progress: "w-full min-w-0 shrink-0 lg:w-56",
    progressMeta:
      "mb-1 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground",
    progressText: "min-w-0 truncate",
    progressSpeed: "min-w-0 truncate text-right",
  };
}
