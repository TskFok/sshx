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

  it("keeps the directory info bar in the file panel", () => {
    const classes = getFilePanelLayoutClasses();

    expect(classes.infoBar).toContain("font-mono");
    expect(classes.infoBar).toContain("text-xs");
    expect(classes.content).toContain("h-[330px]");
    expect(classes.content).not.toContain("h-[370px]");
  });

  it("reserves enough page grid height for the fixed panel content and actions", () => {
    const classes = getFilePanelLayoutClasses();

    expect(classes).toHaveProperty("grid");
    expect(classes.grid).toContain("min-h-[460px]");
    expect(classes.grid).not.toContain("min-h-[360px]");
  });
});
