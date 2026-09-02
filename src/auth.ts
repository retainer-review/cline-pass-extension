import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLINE_API_BASE,
  CLINE_ACCOUNT_PROVIDER_ID,
  CLINE_API_KEY_ENV_VAR,
  CLINE_PASS_ACCESS_TOKEN_ENV_VAR,
  CLINE_PASS_API_KEY_ENV_VAR,
  CLINE_PASS_OMP_AGENT_DB_ENV_VAR,
  CLINE_WORKOS_ACCESS_TOKEN_PREFIX,
  DEFAULT_SOURCE_PATH,
  PROVIDER_ID,
  TEN_YEARS_MS,
} from "./constants.js";
import type {
  ClineProviderAuth,
  ClineProviderSettings,
  ClineSettings,
  Credentials,
  Env,
  FetchLike,
  FoundClineProvider,
  JsonRecord,
  LoginCallbacks,
  ReadCredentialsOptions,
  RefreshCredentialsOptions,
  ResponseLike,
  RuntimeApiKeyOptions,
} from "./types.js";
import { unwrapClineResponsePayload } from "./responses.js";
import {
  expandHome,
  expiryTimeMs,
  isExpired,
  safeError,
  sanitizeErrorDetail,
  stringValue,
} from "./utils.js";

const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const WORKOS_API_BASE = "https://api.workos.com";
const WORKOS_DEVICE_AUTH_PATH = "/user_management/authorize/device";
const WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";
const CLINE_REGISTER_PATH = "/auth/register";
const CLINE_REFRESH_PATH = "/auth/refresh";
const DEVICE_AUTH_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_AUTH_EXPIRES_SECONDS = 300;
const DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS = 5;
const AUTH_REQUEST_TIMEOUT_MS = 30_000;

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

interface WorkOsTokens {
  accessToken: string;
  refreshToken: string;
}

export function resolveProvidersPath(env: Env = process.env): string {
  if (env.CLINE_PROVIDERS_JSON) return path.resolve(expandHome(env.CLINE_PROVIDERS_JSON, env));
  if (env.CLINE_DATA_DIR) return path.resolve(expandHome(path.join(env.CLINE_DATA_DIR, "settings", "providers.json"), env));
  return path.resolve(expandHome(DEFAULT_SOURCE_PATH, env));
}

export async function readClinePassAccessToken(options: ReadCredentialsOptions = {}): Promise<string> {
  const credentials = await readClinePassCredentials(options);
  return credentials.access;
}

export async function readClinePassCredentials(options: ReadCredentialsOptions = {}): Promise<Credentials> {
  const env = options.env || process.env;
  const envApiKey = stringValue(env.CLINE_PASS_API_KEY) || stringValue(env.CLINE_API_KEY);
  if (envApiKey) return credentialsFromApiKey(envApiKey);

  const envToken = stringValue(env.CLINE_PASS_ACCESS_TOKEN);
  if (envToken) return credentialsFromAuth({ accessToken: envToken });

  const providersPath = options.path || resolveProvidersPath(env);
  const settings = await readProviderSettings(providersPath);
  const provider = findClineAuthProviderEntry(settings);
  const token = stringValue(provider?.auth?.accessToken);
  if (!provider || !token) throw new Error("Cline access token not found. Sign in with Cline first.");
  if (!isClineAccountAuthExpired(provider.auth, token, options.refreshSkewMs ?? 60_000)) {
    return credentialsFromAuth(provider.auth, token);
  }

  throw new Error("Cline Pass access token is expired. Refresh your Cline app session or set CLINE_PASS_API_KEY.");
}

export async function loginClinePass(callbacks: LoginCallbacks = {}): Promise<Credentials> {
  const envApiKey = stringValue(process.env.CLINE_PASS_API_KEY) || stringValue(process.env.CLINE_API_KEY);
  if (envApiKey) return credentialsFromApiKey(envApiKey);

  if (process.env.CLINE_PASS_IMPORT_LOCAL === "1") {
    return readClinePassCredentials();
  }

  const fetchImpl = callbacks.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Cline Pass login requires global fetch (Node 18+).");
  if (typeof callbacks.onAuth !== "function") throw new Error("Cline Pass login requires an interactive /login host.");

  const authorization = await requestDeviceAuthorization(fetchImpl, callbacks.signal);
  await callbacks.onAuth({
    url: authorization.verificationUriComplete ?? authorization.verificationUri,
    instructions: `Enter this code in your browser: ${authorization.userCode}`,
  });
  const workOsTokens = await pollDeviceAuthorization(fetchImpl, authorization, callbacks);
  return registerClineCredentials(fetchImpl, workOsTokens, resolveClineAuthBase(process.env), callbacks.signal);
}

export async function refreshClinePassCredentials(
  credentials: Partial<Credentials> | undefined,
  options: RefreshCredentialsOptions = {},
): Promise<Credentials> {
  const access = stringValue(credentials?.access);
  const refresh = stringValue(credentials?.refresh);
  if (access && refresh === access) return credentialsFromApiKey(access);
  if (!refresh) throw new Error("Cline Pass refresh token is missing. Run /login again.");

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Cline Pass token refresh requires global fetch (Node 18+).");
  const response = await fetchImpl(`${resolveClineAuthBase(process.env, options.baseUrl)}${CLINE_REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh, grantType: "refresh_token" }),
    signal: requestSignal(options.signal),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`Cline Pass token refresh failed: HTTP ${response.status}${apiErrorSuffix(payload)}`);
  return credentialsFromClineAuthResponse(payload, credentials);
}

export function getClinePassApiKey(credentials?: Partial<Credentials>): string {
  const access = stringValue(credentials?.access);
  const refresh = stringValue(credentials?.refresh);
  return access && refresh && refresh !== access ? formatClineAccountAccessToken(access) : access;
}

async function requestDeviceAuthorization(fetchImpl: FetchLike, signal?: AbortSignal): Promise<DeviceAuthorization> {
  const response = await fetchImpl(`${WORKOS_API_BASE}${WORKOS_DEVICE_AUTH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }).toString(),
    signal: requestSignal(signal),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`Cline device authorization failed: HTTP ${response.status}${apiErrorSuffix(payload)}`);

  const deviceCode = stringValue(payload.device_code);
  const userCode = stringValue(payload.user_code);
  const verificationUri = stringValue(payload.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) throw new Error("Cline returned an invalid device authorization response.");
  const verificationUriComplete = stringValue(payload.verification_uri_complete) || undefined;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresInSeconds: positiveSeconds(payload.expires_in, DEFAULT_DEVICE_AUTH_EXPIRES_SECONDS),
    pollIntervalSeconds: positiveSeconds(payload.interval, DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS),
  };
}

async function pollDeviceAuthorization(
  fetchImpl: FetchLike,
  authorization: DeviceAuthorization,
  callbacks: LoginCallbacks,
): Promise<WorkOsTokens> {
  const deadline = Date.now() + authorization.expiresInSeconds * 1000;
  let intervalSeconds = authorization.pollIntervalSeconds;
  let progressReported = false;

  while (Date.now() <= deadline) {
    const response = await fetchImpl(`${WORKOS_API_BASE}${WORKOS_AUTHENTICATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_AUTH_GRANT,
        device_code: authorization.deviceCode,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }).toString(),
      signal: requestSignal(callbacks.signal),
    });
    const payload = await responseJson(response);
    if (response.ok) {
      const accessToken = stringValue(payload.access_token);
      const refreshToken = stringValue(payload.refresh_token);
      if (!accessToken || !refreshToken) throw new Error("Cline returned an invalid device token response.");
      return { accessToken, refreshToken };
    }

    const error = stringValue(payload.error);
    if (error === "authorization_pending" || error === "slow_down") {
      if (error === "slow_down") intervalSeconds += 5;
      if (!progressReported) {
        await callbacks.onProgress?.("Waiting for browser authentication confirmation...");
        progressReported = true;
      }
      await wait(intervalSeconds * 1000, callbacks.signal);
      continue;
    }
    if (error === "access_denied") {
      throw new Error("Cline device authorization was denied in the browser. Run /login again if that was unexpected.");
    }
    if (error === "expired_token" || error === "expired_code") {
      throw new Error("The Cline verification code expired before the browser sign-in finished. Run /login again.");
    }
    throw new Error(`Cline device authentication failed: HTTP ${response.status}${apiErrorSuffix(payload)}`);
  }

  throw new Error(`Cline device authorization timed out after ${authorization.expiresInSeconds} seconds. Run /login again.`);
}

async function registerClineCredentials(
  fetchImpl: FetchLike,
  tokens: WorkOsTokens,
  authBase: string,
  signal?: AbortSignal,
): Promise<Credentials> {
  const response = await fetchImpl(`${authBase}${CLINE_REGISTER_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    signal: requestSignal(signal),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`Cline account registration failed: HTTP ${response.status}${apiErrorSuffix(payload)}`);
  return credentialsFromClineAuthResponse(payload);
}

function credentialsFromClineAuthResponse(payload: JsonRecord, fallback: Partial<Credentials> = {}): Credentials {
  const data = unwrapClineResponsePayload(payload);
  const access = stringValue(data.accessToken);
  const refresh = stringValue(data.refreshToken) || stringValue(fallback.refresh);
  const expires = expiryTimeMs(data.expiresAt);
  if (!access || !refresh || expires === undefined) throw new Error("Cline returned an invalid authentication response.");
  const userInfo = data?.userInfo && typeof data.userInfo === "object" ? data.userInfo as JsonRecord : undefined;
  const accountId = stringValue(userInfo?.clineUserId) || stringValue(fallback.accountId) || undefined;
  const email = stringValue(userInfo?.email) || stringValue(fallback.email) || undefined;
  return {
    access: formatClineAccountAccessToken(access),
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

function resolveClineAuthBase(env: Env, override?: string): string {
  const configured = stringValue(override) || stringValue(env.CLINE_PASS_API_BASE) || stringValue(env.CLINE_API_BASE_URL) || CLINE_API_BASE;
  const base = configured.replace(/\/+$/, "");
  return /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseJson(response: ResponseLike): Promise<JsonRecord> {
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonRecord : {};
}

function apiErrorSuffix(payload: JsonRecord): string {
  const detail = stringValue(payload.error_description) || stringValue(payload.message) || stringValue(payload.error);
  return detail ? ` - ${sanitizeErrorDetail(detail)}` : "";
}

function positiveSeconds(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Cline device authentication was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Cline device authentication was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readProviderSettings(providersPath: string): Promise<ClineSettings> {
  let data: string;
  try {
    data = await fs.readFile(providersPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Cline providers.json at ${providersPath}: ${safeError(error)}`, { cause: error });
  }

  try {
    return JSON.parse(data) as ClineSettings;
  } catch (error) {
    throw new Error(`Unable to parse Cline providers.json at ${providersPath}: ${safeError(error)}`, { cause: error });
  }
}

export function findClinePassProvider(settings: ClineSettings): (ClineProviderSettings & { auth?: ClineProviderAuth }) | undefined {
  const provider = findClinePassProviderEntry(settings);
  if (!provider) return undefined;
  const result: ClineProviderSettings & { auth?: ClineProviderAuth } = {
    ...provider.settings,
  };
  if (provider.auth) result.auth = provider.auth;
  return result;
}

function findClinePassProviderEntry(settings?: ClineSettings): FoundClineProvider | undefined {
  return findClineProviderEntry(settings, [PROVIDER_ID]);
}

export function findClineAuthProviderEntry(settings?: ClineSettings): FoundClineProvider | undefined {
  return findClineProviderEntry(settings, [CLINE_ACCOUNT_PROVIDER_ID, PROVIDER_ID]);
}

function findClineProviderEntry(settings: ClineSettings | undefined, providerIds: string[]): FoundClineProvider | undefined {
  const providers = settings?.providers;
  if (!providers || typeof providers !== "object") return undefined;
  const normalizedProviderIds = providerIds.map(providerId => providerId.trim().toLowerCase());

  for (const expectedProviderId of normalizedProviderIds) {
    for (const [key, value] of Object.entries(providers)) {
      const entry = value && typeof value === "object" ? value : {};
      const providerSettings = entry.settings && typeof entry.settings === "object" ? entry.settings : entry;
      const providerId = stringValue(providerSettings.provider) || key;
      if (providerId.trim().toLowerCase() !== expectedProviderId) continue;
      const auth = providerSettings.auth && typeof providerSettings.auth === "object"
        ? providerSettings.auth
        : entry.auth && typeof entry.auth === "object"
          ? entry.auth
          : undefined;
      return { key, entry, settings: providerSettings, auth };
    }
  }

  return undefined;
}

export async function resolveRuntimeApiKey(options: RuntimeApiKeyOptions = {}, env: Env = process.env): Promise<string> {
  const optionKey = stringValue(options.apiKey);
  if (optionKey && !isEnvVarReference(optionKey)) {
    return accessTokenFromRuntimeOption(optionKey) || optionKey;
  }
  const envApiKey = stringValue(env.CLINE_PASS_API_KEY) || stringValue(env.CLINE_API_KEY);
  if (envApiKey) return envApiKey;
  const envAccessToken = stringValue(env.CLINE_PASS_ACCESS_TOKEN);
  if (envAccessToken) return formatClineAccountAccessToken(envAccessToken);
  if (env.CLINE_PASS_IMPORT_LOCAL === "1") {
    const readOptions: ReadCredentialsOptions = {
      env,
      persist: false,
    };
    if (options.baseUrl) readOptions.baseUrl = options.baseUrl;
    if (options.fetchImpl) readOptions.fetchImpl = options.fetchImpl;
    try {
      return await readClinePassAccessToken(readOptions);
    } catch (error) {
      throw new Error(`Unable to resolve imported local Cline credential: ${safeError(error)}`);
    }
  }
  const stored = await readOmpSavedClinePassCredentials(env).catch(() => undefined);
  if (stored) {
    if (!isExpired(stored.expires, 60_000)) return stored.access;
    throw new Error("Saved Cline Pass credential is expired. Run /login again or set CLINE_PASS_API_KEY.");
  }
  return "";
}

export function missingApiKeyMessage(): string {
  return "No Cline Pass credential. Run /login for browser sign-in, set CLINE_PASS_API_KEY, or set CLINE_PASS_IMPORT_LOCAL=1 to read an existing local Cline app token.";
}

function isEnvVarReference(value: string): boolean {
  return [CLINE_PASS_API_KEY_ENV_VAR, CLINE_API_KEY_ENV_VAR, CLINE_PASS_ACCESS_TOKEN_ENV_VAR].some(
    key => value === key || value === `$${key}` || value === `\${${key}}`,
  );
}

function accessTokenFromRuntimeOption(value: string): string {
  if (!value.startsWith("{")) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const record = parsed as JsonRecord;
  const key = stringValue(record.key);
  if (key) return key;
  return credentialsFromStoredOAuthData(record)?.access || "";
}

export async function readOmpSavedClinePassCredentials(env: Env = process.env): Promise<Credentials | undefined> {
  for (const dbPath of resolveOmpAgentDbPathCandidates(env)) {
    if (!(await fileExists(dbPath))) continue;
    const raw = await readOmpAuthCredentialData(dbPath);
    const credentials = raw ? credentialsFromStoredOAuthData(raw) : undefined;
    if (credentials?.access) return credentials;
  }
  return undefined;
}

function resolveOmpAgentDbPathCandidates(env: Env = process.env): string[] {
  const explicit = stringValue(env[CLINE_PASS_OMP_AGENT_DB_ENV_VAR]);
  if (explicit) return [path.resolve(expandHome(explicit, env))];

  const candidates = new Set<string>();
  const home = env.HOME || os.homedir();
  const agentDir = stringValue(env.PI_CODING_AGENT_DIR) || stringValue(env.OMP_AGENT_DIR);
  if (agentDir) candidates.add(path.resolve(expandHome(path.join(agentDir, "agent.db"), env)));

  const configDir = stringValue(env.PI_CONFIG_DIR) || ".omp";
  const profile = normalizeOmpProfileName(stringValue(env.OMP_PROFILE) || stringValue(env.PI_PROFILE));
  const xdgDataHome = stringValue(env.XDG_DATA_HOME);
  if (profile) {
    candidates.add(path.join(home, configDir, "profiles", profile, "agent", "agent.db"));
    if (xdgDataHome) candidates.add(path.join(expandHome(xdgDataHome, env), "omp", "profiles", profile, "agent.db"));
  } else if (xdgDataHome) {
    candidates.add(path.join(expandHome(xdgDataHome, env), "omp", "agent.db"));
  }
  candidates.add(path.join(home, configDir, "agent", "agent.db"));

  return [...candidates];
}

function normalizeOmpProfileName(value: string): string {
  if (!value || value === "default") return "";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : "";
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(stat => stat.isFile())
    .catch(() => false);
}

const OMP_AUTH_SQL = [
  "SELECT data FROM auth_credentials",
  "WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL",
  "ORDER BY updated_at DESC, id DESC LIMIT 1",
].join(" ");

const OMP_AUTH_SQLITE_CLI_SQL = `${OMP_AUTH_SQL.replace("provider = ?", `provider = '${PROVIDER_ID}'`)};`;

async function readOmpAuthCredentialData(dbPath: string): Promise<string> {
  return (await readOmpAuthCredentialDataWithBunSqlite(dbPath)) || readOmpAuthCredentialDataWithSqliteCli(dbPath);
}

interface BunSqliteStatement {
  get(...params: unknown[]): unknown;
}

interface BunSqliteDatabase {
  query(sql: string): BunSqliteStatement;
  close(): void;
}

type BunSqliteDatabaseConstructor = new (dbPath: string, options?: { readonly?: boolean }) => BunSqliteDatabase;

async function readOmpAuthCredentialDataWithBunSqlite(dbPath: string): Promise<string> {
  try {
    if (!("Bun" in globalThis)) return "";
    // bun:sqlite is only resolvable in Bun; keep Node from statically resolving it.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const mod = await dynamicImport("bun:sqlite") as { Database?: BunSqliteDatabaseConstructor };
    if (typeof mod.Database !== "function") return "";
    const db = new mod.Database(dbPath, { readonly: true });
    try {
      const row = db.query(OMP_AUTH_SQL).get(PROVIDER_ID) as { data?: unknown } | undefined;
      return stringValue(row?.data);
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

function readOmpAuthCredentialDataWithSqliteCli(dbPath: string): string {
  try {
    const result = spawnSync("sqlite3", ["-batch", "-noheader", "-readonly", dbPath, OMP_AUTH_SQLITE_CLI_SQL], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return "";
    return stringValue(result.stdout);
  } catch {
    return "";
  }
}

function credentialsFromAuth(auth?: ClineProviderAuth, accessOverride?: string): Credentials {
  const rawAccess = stringValue(accessOverride) || stringValue(auth?.accessToken);
  const access = formatClineAccountAccessToken(rawAccess);
  const refresh = stringValue(auth?.refreshToken) || access;
  return {
    access,
    refresh,
    expires: clineAccountExpiryTimeMs(auth, access) ?? Date.now() + TEN_YEARS_MS,
  };
}

function credentialsFromStoredOAuthData(data: string | JsonRecord): Credentials | undefined {
  let record: JsonRecord;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      record = parsed as JsonRecord;
    } catch {
      return undefined;
    }
  } else {
    record = data;
  }

  const access = stringValue(record.access) || stringValue(record.accessToken);
  if (!access) return undefined;
  const refresh = stringValue(record.refresh) || stringValue(record.refreshToken) || access;
  if (refresh === access) return credentialsFromApiKey(access);

  return credentialsFromAuth({
    accessToken: access,
    refreshToken: refresh,
    expiresAt: record.expires ?? record.expiresAt,
    accountId: stringValue(record.accountId),
  });
}

function credentialsFromApiKey(apiKey: string): Credentials {
  return {
    access: apiKey,
    refresh: apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  };
}

function formatClineAccountAccessToken(token: unknown): string {
  const value = stringValue(token);
  if (!value) return "";
  return value.toLowerCase().startsWith(CLINE_WORKOS_ACCESS_TOKEN_PREFIX) ? value : `${CLINE_WORKOS_ACCESS_TOKEN_PREFIX}${value}`;
}

function stripClineAccountAccessTokenPrefix(token: unknown): string {
  const value = stringValue(token);
  if (!value) return "";
  return value.toLowerCase().startsWith(CLINE_WORKOS_ACCESS_TOKEN_PREFIX)
    ? value.slice(CLINE_WORKOS_ACCESS_TOKEN_PREFIX.length)
    : value;
}

function isClineAccountAuthExpired(auth: ClineProviderAuth | undefined, accessToken: string, skewMs = 0): boolean {
  const expiry = clineAccountExpiryTimeMs(auth, accessToken);
  return expiry !== undefined && expiry <= Date.now() + skewMs;
}

function clineAccountExpiryTimeMs(auth: ClineProviderAuth | undefined, accessToken: string): number | undefined {
  return expiryTimeMs(auth?.expiresAt) ?? jwtExpiryTimeMs(stripClineAccountAccessTokenPrefix(accessToken));
}

function jwtExpiryTimeMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JsonRecord;
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
