import { describe, expect, it } from "vitest";
import { getFileTransferHistoryLayoutClasses } from "./fileTransferPanelLayout";

describe("getFileTransferHistoryLayoutClasses", () => {
  it("prevents long transfer history content from expanding the page", () => {
    const classes = getFileTransferHistoryLayoutClasses();

    expect(classes.card).toContain("min-w-0");
    expect(classes.card).toContain("overflow-hidden");
    expect(classes.scrollArea).toContain("min-w-0");
    expect(classes.row).toContain("min-w-0");
    expect(classes.row).toContain("overflow-hidden");
    expect(classes.details).toContain("min-w-0");
    expect(classes.summary).toContain("min-w-0");
    expect(classes.fileName).toContain("flex-1");
    expect(classes.fileName).toContain("truncate");
    expect(classes.pathGrid).toContain("min-w-0");
    expect(classes.pathButton).toContain("min-w-0");
    expect(classes.progress).toContain("min-w-0");
    expect(classes.progressMeta).toContain("min-w-0");
    expect(classes.progressText).toContain("truncate");
  });

  it("reserves enough scroll height for five compact history rows", () => {
    const classes = getFileTransferHistoryLayoutClasses();

    expect(classes.card).toContain("shrink-0");
    expect(classes.scrollArea).toContain("h-[400px]");
    expect(classes.row).toContain("min-h-[72px]");
  });

  it("styles local and remote path buttons as full-width ghost actions", () => {
    const classes = getFileTransferHistoryLayoutClasses();

    expect(classes.pathButton).toContain("w-full");
    expect(classes.pathButton).toContain("rounded-md");
    expect(classes.pathButton).toContain("bg-transparent");
    expect(classes.pathButton).toContain("px-2");
    expect(classes.pathButton).toContain("py-1.5");
    expect(classes.pathButton).toContain("transition-colors");
    expect(classes.pathButton).toContain("hover:bg-muted");
    expect(classes.pathButton).toContain("focus-visible:ring-2");
    expect(classes.pathButton).toContain("disabled:cursor-not-allowed");
    expect(classes.pathButton).toContain("disabled:opacity-50");
  });
});
