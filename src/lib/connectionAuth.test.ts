import { describe, expect, it } from "vitest";
import {
  authTypeLabel,
  buildConnectionCredentials,
} from "./connectionAuth";

describe("buildConnectionCredentials", () => {
  const base = {
    password: "pwd",
    privateKey: "~/.ssh/id_rsa",
    privateKeyPassphrase: "pp",
  };

  it("password auth keeps password only", () => {
    expect(
      buildConnectionCredentials({ ...base, authType: "password" })
    ).toEqual({
      password: "pwd",
      privateKey: null,
      privateKeyPassphrase: null,
    });
  });

  it("key auth keeps key fields only", () => {
    expect(buildConnectionCredentials({ ...base, authType: "key" })).toEqual({
      password: null,
      privateKey: "~/.ssh/id_rsa",
      privateKeyPassphrase: "pp",
    });
  });

  it("key_password auth keeps both password and key", () => {
    expect(
      buildConnectionCredentials({ ...base, authType: "key_password" })
    ).toEqual({
      password: "pwd",
      privateKey: "~/.ssh/id_rsa",
      privateKeyPassphrase: "pp",
    });
  });

  it("key_password empty passphrase becomes null", () => {
    expect(
      buildConnectionCredentials({
        ...base,
        authType: "key_password",
        privateKeyPassphrase: "",
      })
    ).toEqual({
      password: "pwd",
      privateKey: "~/.ssh/id_rsa",
      privateKeyPassphrase: null,
    });
  });
});

describe("authTypeLabel", () => {
  it("returns labels for all auth types", () => {
    expect(authTypeLabel("password")).toBe("密码");
    expect(authTypeLabel("key")).toBe("密钥");
    expect(authTypeLabel("key_password")).toBe("密钥+密码");
  });
});
