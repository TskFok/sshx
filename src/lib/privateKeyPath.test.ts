import { describe, expect, it } from "vitest";
import {
  pathFromOpenDialogSelection,
  privateKeyFileDialogOptions,
} from "./privateKeyPath";

describe("pathFromOpenDialogSelection", () => {
  it("returns null when selection is cancelled or empty", () => {
    expect(pathFromOpenDialogSelection(null)).toBeNull();
    expect(pathFromOpenDialogSelection(undefined)).toBeNull();
    expect(pathFromOpenDialogSelection("")).toBeNull();
    expect(pathFromOpenDialogSelection([])).toBeNull();
    expect(pathFromOpenDialogSelection([""])).toBeNull();
  });

  it("returns a single path string", () => {
    expect(pathFromOpenDialogSelection("/Users/me/.ssh/id_ed25519")).toBe(
      "/Users/me/.ssh/id_ed25519"
    );
  });

  it("returns the first path when multiple files are selected", () => {
    expect(
      pathFromOpenDialogSelection(["/a/id_rsa", "/b/id_ed25519"])
    ).toBe("/a/id_rsa");
  });
});

describe("privateKeyFileDialogOptions", () => {
  it("opens a single file with a Chinese title and no extension filters", () => {
    expect(privateKeyFileDialogOptions("")).toEqual({
      multiple: false,
      directory: false,
      title: "选择私钥文件",
    });
  });

  it("omits defaultPath for blank or tilde paths", () => {
    expect(privateKeyFileDialogOptions("   ")).not.toHaveProperty("defaultPath");
    expect(privateKeyFileDialogOptions("~/.ssh/id_rsa")).not.toHaveProperty(
      "defaultPath"
    );
  });

  it("uses an existing absolute path as defaultPath", () => {
    expect(privateKeyFileDialogOptions("/Users/me/.ssh/id_ed25519")).toEqual({
      multiple: false,
      directory: false,
      title: "选择私钥文件",
      defaultPath: "/Users/me/.ssh/id_ed25519",
    });
  });
});
