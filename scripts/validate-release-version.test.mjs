import { describe, expect, it } from "vitest";
import {
  assertProjectVersionsMatch,
  parseCargoPackageVersion,
  parseReleaseVersion,
} from "./validate-release-version.mjs";

describe("validate-release-version", () => {
  it("parses a plain semver release version and derives the tag", () => {
    expect(parseReleaseVersion("0.1.0")).toEqual({
      version: "0.1.0",
      tag: "v0.1.0",
    });
  });

  it("rejects versions that already include the tag prefix", () => {
    expect(() => parseReleaseVersion("v0.1.0")).toThrow(
      "Version must not start with v",
    );
  });

  it("rejects build metadata because release tags must be stable", () => {
    expect(() => parseReleaseVersion("0.1.0+build.1")).toThrow(
      "Version must be SemVer",
    );
  });

  it("parses the version from the Cargo package section only", () => {
    const cargoToml = `
[package]
name = "sshx"
version = "0.1.0"

[dependencies]
some-crate = { version = "9.9.9" }
`;

    expect(parseCargoPackageVersion(cargoToml)).toBe("0.1.0");
  });

  it("accepts matching project versions", () => {
    expect(() =>
      assertProjectVersionsMatch("0.1.0", {
        packageJson: "0.1.0",
        tauriConfig: "0.1.0",
        cargoToml: "0.1.0",
      }),
    ).not.toThrow();
  });

  it("reports every mismatched project version", () => {
    expect(() =>
      assertProjectVersionsMatch("0.2.0", {
        packageJson: "0.1.0",
        tauriConfig: "0.2.0",
        cargoToml: "0.3.0",
      }),
    ).toThrow(
      "Version mismatch: package.json=0.1.0, src-tauri/Cargo.toml=0.3.0",
    );
  });
});
