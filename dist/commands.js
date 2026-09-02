import { CLINE_API_BASE, DEFAULT_MODEL } from "./constants.js";
import { findClineAuthProviderEntry, missingApiKeyMessage, readOmpSavedClinePassCredentials, readProviderSettings, resolveProvidersPath, resolveRuntimeApiKey, } from "./auth.js";
import { CLINE_PASS_MODELS, toWireModelId } from "./models.js";
import { unwrapClineResponsePayload } from "./responses.js";
import { camelCase, describeExpiry, normalizeBaseUrl, parseBoolean, safeError, stringValue, tokenize } from "./utils.js";
export async function doctorClinePass(env = process.env) {
    const providersPath = resolveProvidersPath(env);
    const checks = [];
    const envApiKey = stringValue(env.CLINE_PASS_API_KEY) || stringValue(env.CLINE_API_KEY);
    if (envApiKey) {
        checks.push({ name: "api key", ok: true, detail: env.CLINE_PASS_API_KEY ? "CLINE_PASS_API_KEY is set" : "CLINE_API_KEY is set" });
        return { ok: true, command: "doctor", providersPath, checks };
    }
    const envToken = stringValue(env.CLINE_PASS_ACCESS_TOKEN);
    if (envToken) {
        checks.push({ name: "access token", ok: true, detail: "CLINE_PASS_ACCESS_TOKEN is set" });
        return { ok: true, command: "doctor", providersPath, checks };
    }
    const saved = env.CLINE_PASS_IMPORT_LOCAL === "1"
        ? undefined
        : await readOmpSavedClinePassCredentials(env).catch(() => undefined);
    if (saved) {
        checks.push({ name: "OMP /login", ok: true, detail: "saved Cline Pass credential found" });
        const expiry = describeExpiry(saved.expires);
        if (expiry)
            checks.push({ name: "expiry", ok: !expiry.expired, detail: expiry.detail });
        return { ok: checks.every(check => check.ok), command: "doctor", providersPath, checks };
    }
    let settings;
    try {
        settings = await readProviderSettings(providersPath);
        checks.push({ name: "providers.json", ok: true, detail: providersPath });
    }
    catch (error) {
        if (isMissingFile(error)) {
            checks.push({ name: "providers.json", ok: true, detail: "not found (expected before the first Cline login)" });
        }
        else {
            checks.push({ name: "providers.json", ok: false, detail: safeError(error) });
            return { ok: false, command: "doctor", providersPath, checks };
        }
    }
    const provider = findClineAuthProviderEntry(settings);
    checks.push({
        name: "provider",
        ok: Boolean(provider),
        detail: provider
            ? `${provider.settings.provider || provider.key} provider found`
            : "cline/cline-pass provider not found. Run /login and choose Cline Pass.",
    });
    checks.push({
        name: "access token",
        ok: Boolean(stringValue(provider?.auth?.accessToken)),
        detail: stringValue(provider?.auth?.accessToken)
            ? "present"
            : "missing. Run /login and choose Cline Pass, or set CLINE_PASS_API_KEY.",
    });
    const expiry = describeExpiry(provider?.auth?.expiresAt);
    if (expiry) {
        checks.push({
            name: "expiry",
            ok: !expiry.expired,
            detail: expiry.detail,
        });
    }
    return { ok: checks.every(check => check.ok), command: "doctor", providersPath, checks };
}
export async function verifyClinePass(options = {}, env = process.env) {
    const fetchImpl = (options.fetchImpl ?? globalThis.fetch);
    if (typeof fetchImpl !== "function") {
        throw new Error("global fetch is not available; use Node 18+ or a runtime with fetch");
    }
    const model = options.model || env.CLINE_PASS_MODEL || DEFAULT_MODEL;
    const baseUrl = options.baseUrl || env.CLINE_PASS_API_BASE || CLINE_API_BASE;
    const timeoutMs = positiveTimeout(options.timeoutMs);
    let token;
    try {
        token = await resolveRuntimeApiKey({ baseUrl, fetchImpl }, env);
    }
    catch (error) {
        return {
            ok: false,
            command: "verify",
            status: 0,
            detail: safeError(error),
            model,
            baseUrl,
        };
    }
    if (!token) {
        return {
            ok: false,
            command: "verify",
            status: 0,
            detail: missingApiKeyMessage(),
            model,
            baseUrl,
        };
    }
    const sentinel = "CLINE_PASS_EXTENSION_OK";
    let response;
    try {
        response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: toWireModelId(model),
                messages: [{ role: "user", content: `Reply with exactly: ${sentinel}` }],
                stream: false,
                temperature: 0,
                max_tokens: 32,
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (error) {
        return {
            ok: false,
            command: "verify",
            status: 0,
            detail: timedOut(error)
                ? `verification request timed out after ${formatSeconds(timeoutMs)}. Check your network connection and try again.`
                : safeError(error),
            model,
            baseUrl,
        };
    }
    if (!response.ok) {
        return {
            ok: false,
            command: "verify",
            status: response.status,
            detail: response.status === 401
                ? "Cline API returned HTTP 401. Run /login again, refresh an imported Cline app session, or set CLINE_PASS_API_KEY."
                : `Cline API returned HTTP ${response.status}`,
            model,
            baseUrl,
        };
    }
    const rawPayload = await response.json().catch(() => undefined);
    if (rawPayload === undefined) {
        return {
            ok: false,
            command: "verify",
            status: response.status,
            detail: "model responded, but the verification response was not valid JSON",
            model,
            baseUrl,
        };
    }
    let payload;
    try {
        payload = unwrapClineResponsePayload(rawPayload);
    }
    catch (error) {
        return {
            ok: false,
            command: "verify",
            status: response.status,
            detail: safeError(error),
            model,
            baseUrl,
        };
    }
    const content = payload?.choices?.[0]?.message?.content;
    return {
        ok: typeof content === "string" && content.includes(sentinel),
        command: "verify",
        status: response.status,
        detail: typeof content === "string" && content.includes(sentinel)
            ? "model returned the verification sentinel"
            : "model responded, but not with the verification sentinel",
        model,
        baseUrl,
    };
}
export function parseCommandArgs(args) {
    const tokens = tokenize(args || "");
    const command = tokens.shift() || "help";
    const options = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token)
            throw new Error("Missing argument");
        if (!token.startsWith("--"))
            throw new Error(`Unexpected argument: ${token}`);
        const eqIndex = token.indexOf("=");
        const rawKey = eqIndex >= 0 ? token.slice(2, eqIndex) : token.slice(2);
        const key = camelCase(rawKey);
        const inlineValue = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;
        if (!["model", "baseUrl", "json"].includes(key)) {
            throw new Error(`Unknown option: --${rawKey}`);
        }
        if (["json"].includes(key)) {
            options[key] = (inlineValue === undefined ? true : parseBoolean(inlineValue, rawKey));
            continue;
        }
        const value = inlineValue ?? tokens[++index];
        if (!value || value.startsWith("--"))
            throw new Error(`Missing value for --${rawKey}`);
        options[key] = value;
    }
    return { command, options };
}
export async function runClinePassCommand(args, env = process.env) {
    const { command, options } = parseCommandArgs(args);
    let result;
    switch (command) {
        case "doctor":
            result = await doctorClinePass(env);
            break;
        case "verify":
            result = await verifyClinePass(options, env);
            break;
        case "models":
            result = {
                ok: true,
                command: "models",
                models: CLINE_PASS_MODELS.map(model => model.id),
            };
            break;
        case "help":
            result = { ok: true, command: "help", detail: commandUsage() };
            break;
        default:
            throw new Error(`Unknown clinepass command: ${command}`);
    }
    return { ...result, json: Boolean(options.json) };
}
const VERIFY_REQUEST_TIMEOUT_MS = 60_000;
function positiveTimeout(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : VERIFY_REQUEST_TIMEOUT_MS;
}
function timedOut(error) {
    const name = error instanceof Error ? error.name : "";
    return name === "TimeoutError" || name === "AbortError";
}
function formatSeconds(ms) {
    return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms / 1000}s`;
}
function isMissingFile(error) {
    return Boolean(error instanceof Error && error.cause?.code === "ENOENT");
}
export function commandUsage() {
    return [
        "Usage: /clinepass <doctor|verify|models|help> [options]",
        "",
        "Options:",
        "  --model <id>      Verification model",
        "  --base-url <url>  Cline API base URL",
        "  --json            Return JSON",
    ].join("\n");
}
export function formatCommandResult(result, json = false) {
    if (json || result.json)
        return JSON.stringify(toSafeResult(result), null, 2);
    if (result.command === "help")
        return result.detail;
    if (result.command === "doctor") {
        return result.checks.map(check => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
    }
    if (result.command === "models")
        return result.models.join("\n");
    const status = result.ok ? "OK" : "FAIL";
    return `${status} clinepass ${result.command}: ${result.detail}`;
}
function toSafeResult(result) {
    return JSON.parse(JSON.stringify(result, (key, value) => {
        if (/token|secret|apikey|authorization/i.test(key))
            return value ? "[redacted]" : value;
        return value;
    }));
}
//# sourceMappingURL=commands.js.map