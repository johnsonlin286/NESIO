import type { AppConfig } from "../config/env.js";
import { createGuestAuthenticator } from "./guest.js";
import { createJwtAuthenticator } from "./jwt.js";
import type { Authenticator } from "./types.js";

export type { Authenticator, AuthInput, AuthResult } from "./types.js";
export { createGuestAuthenticator } from "./guest.js";
export { createJwtAuthenticator } from "./jwt.js";

export function createAuthenticatorFromConfig(auth: AppConfig["auth"]): Authenticator {
  return auth.mode === "guest" ? createGuestAuthenticator(auth.sessionSecret) : createJwtAuthenticator(auth);
}
