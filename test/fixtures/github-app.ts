import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const githubAppEnv = {
  GITHUB_APP_ID: "101",
  GITHUB_APP_INSTALLATION_ID: "202",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};
