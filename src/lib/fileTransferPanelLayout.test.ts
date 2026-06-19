import { describe, expect, it } from "vitest";
import { getFilePanelLayoutClasses } from "./fileTransferPanelLayout";

describe("getFilePanelLayoutClasses", () => {
  it("keeps transfer actions visible when file rows are selected", () => {
    const classes = getFilePanelLayoutClasses();

    expect(classes).toHaveProperty("header");
    expect(classes.header).toContain("pb-3");
    expect(classes.header).toContain("space-y-3");
    expect(classes.content).toContain("flex-col");
    expect(classes.list).toContain("flex-1");
    expect(classes.list).toContain("min-h-0");
    expect(classes.footer).toContain("shrink-0");
  });

  it("keeps transfer action buttons from overflowing narrow panels", () => {
    const classes = getFilePanelLayoutClasses() as Record<string, string>;

    expect(classes).toHaveProperty("card");
    expect(classes.card).toContain("flex");
    expect(classes.card).toContain("min-h-[460px]");
    expect(classes.card).toContain("overflow-hidden");
    expect(classes.content).toContain("flex-1");
    expect(classes.content).not.toContain("h-[330px]");
    expect(classes.footer).toContain("min-w-0");
    expect(classes.footerActions).toContain("min-w-0");
    expect(classes.footerActions).toContain("flex-col");
    expect(classes.footerActions).toContain("sm:flex-row");
    expect(classes.footerActions).toContain("sm:flex-wrap");
    expect(classes.footerActionButton).toContain("w-full");
    expect(classes.footerActionButton).toContain("min-w-0");
    expect(classes.footerActionButton).toContain("sm:w-auto");
  });

  it("keeps the directory info bar in the file panel", () => {
    const classes = getFilePanelLayoutClasses();

    expect(classes.infoBar).toContain("font-mono");
    expect(classes.infoBar).toContain("text-xs");
    expect(classes.content).toContain("min-h-0");
    expect(classes.content).toContain("flex-1");
    expect(classes.content).not.toContain("h-[330px]");
  });

  it("reserves enough page grid height for the fixed panel content and actions", () => {
    const classes = getFilePanelLayoutClasses();

    expect(classes).toHaveProperty("grid");
    expect(classes.grid).toContain("min-h-[460px]");
    expect(classes.grid).not.toContain("min-h-[360px]");
  });
});
