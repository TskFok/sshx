export type ConnectionAuthType = "password" | "key" | "key_password";

export interface ConnectionCredentialFields {
  password: string | null;
  privateKey: string | null;
  privateKeyPassphrase: string | null;
}

export interface ConnectionCredentialInput {
  authType: ConnectionAuthType;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
}

/** 按认证方式组装保存/测试连接时提交的凭据字段。 */
export function buildConnectionCredentials(
  input: ConnectionCredentialInput
): ConnectionCredentialFields {
  switch (input.authType) {
    case "password":
      return {
        password: input.password,
        privateKey: null,
        privateKeyPassphrase: null,
      };
    case "key":
      return {
        password: null,
        privateKey: input.privateKey,
        privateKeyPassphrase: input.privateKeyPassphrase || null,
      };
    case "key_password":
      return {
        password: input.password,
        privateKey: input.privateKey,
        privateKeyPassphrase: input.privateKeyPassphrase || null,
      };
  }
}

export function buildEditedConnectionCredentials(
  input: ConnectionCredentialInput,
  stored: Partial<ConnectionCredentialFields>
): ConnectionCredentialFields {
  return buildConnectionCredentials({
    ...input,
    password: input.password || stored.password || "",
    privateKey: input.privateKey || stored.privateKey || "",
    privateKeyPassphrase: input.privateKeyPassphrase || stored.privateKeyPassphrase || "",
  });
}

export function authTypeLabel(authType: ConnectionAuthType): string {
  switch (authType) {
    case "password":
      return "密码";
    case "key":
      return "密钥";
    case "key_password":
      return "密钥+密码";
  }
}
