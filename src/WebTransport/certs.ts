import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { Slokr } from "../index.js";

function checkForOpenSSL(): boolean {
  try {
    return execSync(`openssl version`).toString().startsWith("OpenSSL");
  } catch {
    return false;
  }
}

export function genCerts(): genCerts.returns {
  if (!checkForOpenSSL()) {
    throw new Slokr.Error(
      "OpenSSL not found!",
    );
  }

  if (!existsSync("./certs")) mkdirSync("./certs");

  const certPath = "./certs/cert.pem";
  const keyPath = "./certs/key.pem";

  let isExpired = true;
  if (existsSync(certPath)) {
    const stats = statSync(certPath);
    const ageInDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageInDays < 13) isExpired = false;
  }

  if (isExpired) {
    execSync(
      `openssl req -new -x509 -nodes -out ${certPath} -keyout ${keyPath} -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -subj "/CN=127.0.0.1" -days 14`,
    );
  }

  const binaryHash = execSync(
    `openssl x509 -pubkey -noout -in ${certPath} | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary`
);

const hash = binaryHash.toString('base64');

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  return {
    cert,
    key,
    hash,
    certPath,
    keyPath,
  };
}
export namespace genCerts {
  export interface returns {
    cert: Buffer;
    key: Buffer;
    hash: string;
    certPath: string;
    keyPath: string;
  }
}
