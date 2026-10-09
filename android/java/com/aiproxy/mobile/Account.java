package com.aiproxy.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * One upstream provider account: where to reach it, how to authenticate, which models
 * it serves, and the routing/budget policy attached to it.
 *
 * <p>Secrets live in {@link #apiKey} and {@link #proxyUrl} in memory and are written
 * verbatim to SQLite; {@link #toJSON()} is the only serialiser and always masks them.
 */
public final class Account {

    public String name;
    public String providerType = "openai";
    public String baseUrl = "";
    public String apiKey = "";
    public List<String> models = new ArrayList<String>();
    public boolean modelsExact = true;
    public int weight = 1;
    public int priority = 10;
    public boolean enabled = true;

    public int rpm;
    public int tpm;
    public int burst = 10;
    public boolean rateLimitEnabled = true;

    public double dailyUsd;
    public double monthlyUsd;

    public String strategy;
    public double costMultiplier = 1.0;

    public boolean proxyEnabled;
    public String proxyUrl = "";

    public String location = "";
    public String userAgent = "";
    public JSONObject extraHeaders = new JSONObject();

    /** Explicit outbound exit for this account; empty means "let the pool decide". */
    public String egress = "";

    /** Desktop identity profile id, or empty to derive one from the account name. */
    public String identity = "";

    /** When true this account is preferred by the free-models-only routing filter. */
    public boolean freeOnly = false;

    /**
     * Quota state. A provider that answers "insufficient quota" or a 429 with a reset
     * window is out of budget rather than broken, so it is parked until
     * {@code quotaResetTs} instead of being punished by the circuit breaker.
     */
    public double quotaResetTs = 0;
    public String quotaReason = "";

    /** Anti-ban pacing. */
    public double minIntervalMs = 0;
    public int maxConcurrency = 2;
    public double jitterMs = 0;

    public double lastUsed;
    public long createdTs = System.currentTimeMillis() / 1000L;

    public final Breaker breaker = new Breaker();

    // rolling counters, reset by POST /admin/accounts/{name}/reset
    public final Map<String, Double> counters = new ConcurrentHashMap<String, Double>();

    public Account(String name) {
        this.name = name;
    }

    public Account copy() {
        try {
            return fromJSON(toJSON(true));
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    /** {@code withSecrets=true} is for persistence only — never for API responses. */
    public JSONObject toJSON() throws Exception {
        return toJSON(false);
    }

    public JSONObject toJSON(boolean withSecrets) throws Exception {
        JSONObject out = new JSONObject();
        out.put("name", name);
        out.put("provider_type", providerType);
        out.put("base_url", baseUrl);
        out.put("api_key_masked", mask(apiKey));
        out.put("models", new JSONArray(models));
        out.put("models_exact", modelsExact);
        out.put("weight", weight);
        out.put("priority", priority);
        out.put("enabled", enabled);
        out.put("rate_limit", new JSONObject()
                .put("rpm", rpm).put("tpm", tpm).put("burst", burst)
                .put("enabled", rateLimitEnabled));
        out.put("budget", new JSONObject()
                .put("daily_usd", dailyUsd)
                .put("monthly_usd", monthlyUsd <= 0 ? JSONObject.NULL : monthlyUsd)
                .put("spent_today_usd", spentToday()));
        out.put("routing", new JSONObject()
                .put("strategy", strategy == null ? JSONObject.NULL : strategy)
                .put("cost_multiplier", costMultiplier));
        out.put("proxy", new JSONObject()
                .put("enabled", proxyEnabled)
                .put("url_masked", proxyEnabled ? mask(proxyUrl) : ""));
        out.put("location", location);
        out.put("identity", identityProfile().id);
        out.put("identity_detail", Fingerprint.describe(identityProfile()));
        out.put("egress", Egress.describe(egress.isEmpty() ? "direct" : egress));
        out.put("free_only", freeOnly);
        out.put("stealth", new JSONObject()
                .put("min_interval_ms", minIntervalMs)
                .put("max_concurrency", maxConcurrency)
                .put("jitter_ms", jitterMs));
        out.put("quota", new JSONObject()
                .put("exhausted", quotaExhausted())
                .put("resets_in_s", Math.max(0, Math.round(quotaResetTs - nowSeconds())))
                .put("reason", quotaReason.isEmpty() ? JSONObject.NULL : quotaReason));
        out.put("user_agent", userAgent);
        out.put("extra_headers", extraHeaders);
        out.put("last_used", lastUsed);
        out.put("created_ts", createdTs);

        JSONObject health = new JSONObject()
                .put("circuit", breaker.state())
                .put("consecutive_failures", breaker.consecutiveFailures())
                .put("last_error", breaker.lastError() == null ? JSONObject.NULL : breaker.lastError())
                .put("last_success_ts", breaker.lastSuccessTs())
                .put("avg_latency_ms", breaker.avgLatency())
                .put("success_rate", breaker.successRate())
                .put("in_flight", breaker.inFlight())
                .put("disabled_until", quotaExhausted()
                        ? quotaResetTs : JSONObject.NULL);
        out.put("health", health);

        JSONObject stats = new JSONObject()
                .put("requests", count("requests"))
                .put("errors", count("errors"))
                .put("tokens_in", count("tokens_in"))
                .put("tokens_out", count("tokens_out"))
                .put("cost_usd", count("cost_usd"));
        out.put("counters", stats);

        if (withSecrets) {
            out.put("api_key", apiKey);
            out.put("proxy_url", proxyUrl);
        }
        return out;
    }

    private double count(String key) {
        Double value = counters.get(key);
        return value == null ? 0d : value;
    }

    public void bump(String key, double delta) {
        synchronized (counters) {
            Double current = counters.get(key);
            counters.put(key, (current == null ? 0d : current) + delta);
        }
    }

    private double spentToday() {
        return count("cost_usd");
    }

    public static Account fromJSON(JSONObject in) throws Exception {
        Account account = new Account(in.optString("name"));
        account.providerType = in.optString("provider_type", account.providerType);
        account.baseUrl = in.optString("base_url", account.baseUrl);
        account.apiKey = in.optString("api_key", account.apiKey);
        account.proxyUrl = in.optString("proxy_url", account.proxyUrl);

        JSONArray list = in.optJSONArray("models");
        account.models = new ArrayList<String>();
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                account.models.add(list.optString(i));
            }
        }
        account.modelsExact = in.optBoolean("models_exact", account.modelsExact);
        account.weight = in.optInt("weight", account.weight);
        account.priority = in.optInt("priority", account.priority);
        account.enabled = in.optBoolean("enabled", account.enabled);

        JSONObject rate = in.optJSONObject("rate_limit");
        if (rate != null) {
            account.rpm = rate.optInt("rpm", account.rpm);
            account.tpm = rate.optInt("tpm", account.tpm);
            account.burst = rate.optInt("burst", account.burst);
            account.rateLimitEnabled = rate.optBoolean("enabled", account.rateLimitEnabled);
        }
        JSONObject budget = in.optJSONObject("budget");
        if (budget != null) {
            account.dailyUsd = budget.optDouble("daily_usd", account.dailyUsd);
            account.monthlyUsd = budget.optDouble("monthly_usd", account.monthlyUsd);
        }
        JSONObject routing = in.optJSONObject("routing");
        if (routing != null) {
            account.strategy = routing.isNull("strategy") ? null
                    : routing.optString("strategy", null);
            account.costMultiplier = routing.optDouble("cost_multiplier", account.costMultiplier);
        }
        JSONObject proxy = in.optJSONObject("proxy");
        if (proxy != null) {
            account.proxyEnabled = proxy.optBoolean("enabled", account.proxyEnabled);
            String masked = proxy.optString("url_masked");
            if (masked.length() > 0 && account.proxyUrl.isEmpty()) {
                account.proxyUrl = masked;   // masked only; needs a re-send to change
            }
        }
        account.location = in.optString("location", account.location);
        account.userAgent = in.optString("user_agent", account.userAgent);
        String egress = in.optString("egress", "");
        if (!egress.isEmpty()) {
            try {
                JSONObject parsed = new JSONObject(egress);
                account.egress = parsed.optString("direct", "").isEmpty() ? "" : "";
                account.egress = parsed.optBoolean("direct", true) ? "" : account.egress;
                String host = parsed.optString("host");
                if (!parsed.optBoolean("direct", true) && !host.isEmpty()) {
                    account.egress = parsed.optString("scheme", "http") + "://" + host
                            + ":" + parsed.optInt("port");
                }
            } catch (Exception ignored) {
                // a plain string spec is also accepted
                account.egress = egress.startsWith("{") ? "" : egress;
            }
        }
        account.identity = in.optString("identity", account.identity);
        account.freeOnly = in.optBoolean("free_only", account.freeOnly);
        JSONObject stealth = in.optJSONObject("stealth");
        if (stealth != null) {
            account.minIntervalMs = stealth.optDouble("min_interval_ms", account.minIntervalMs);
            account.maxConcurrency = stealth.optInt("max_concurrency", account.maxConcurrency);
            account.jitterMs = stealth.optDouble("jitter_ms", account.jitterMs);
        }
        JSONObject headers = in.optJSONObject("extra_headers");
        if (headers != null) {
            account.extraHeaders = headers;
        }
        account.lastUsed = in.optDouble("last_used", account.lastUsed);
        account.createdTs = (long) in.optDouble("created_ts", account.createdTs);
        return account;
    }

    /** Patch from a PUT/PATCH body: absent fields are left untouched. */
    public void apply(JSONObject in) throws Exception {
        if (in.has("provider_type")) {
            providerType = in.optString("provider_type", providerType);
        }
        if (in.has("base_url")) {
            baseUrl = in.optString("base_url", baseUrl);
        }
        if (in.has("api_key")) {
            String value = in.optString("api_key");
            if (value.length() > 0) {
                apiKey = value;                 // blank means "keep the existing key"
            }
        }
        if (in.has("proxy_url")) {
            String value = in.optString("proxy_url");
            if (value.length() > 0) {
                proxyUrl = value;
            }
        }
        if (in.has("proxy") && in.optJSONObject("proxy") != null) {
            JSONObject proxy = in.getJSONObject("proxy");
            proxyEnabled = proxy.optBoolean("enabled", proxyEnabled);
            String value = proxy.optString("url");
            if (value.length() > 0) {
                proxyUrl = value;
            }
        }
        if (in.has("models")) {
            JSONArray list = in.optJSONArray("models");
            if (list != null) {
                models = new ArrayList<String>();
                for (int i = 0; i < list.length(); i++) {
                    models.add(list.optString(i));
                }
            }
        }
        if (in.has("models_exact")) {
            modelsExact = in.optBoolean("models_exact", modelsExact);
        }
        if (in.has("weight")) {
            weight = in.optInt("weight", weight);
        }
        if (in.has("priority")) {
            priority = in.optInt("priority", priority);
        }
        if (in.has("enabled")) {
            enabled = in.optBoolean("enabled", enabled);
        }
        if (in.has("rate_limit") && in.optJSONObject("rate_limit") != null) {
            JSONObject rate = in.getJSONObject("rate_limit");
            rpm = rate.optInt("rpm", rpm);
            tpm = rate.optInt("tpm", tpm);
            burst = rate.optInt("burst", burst);
            rateLimitEnabled = rate.optBoolean("enabled", rateLimitEnabled);
        }
        if (in.has("budget") && in.optJSONObject("budget") != null) {
            JSONObject value = in.getJSONObject("budget");
            dailyUsd = value.optDouble("daily_usd", dailyUsd);
            monthlyUsd = value.optDouble("monthly_usd", monthlyUsd);
        }
        if (in.has("routing") && in.optJSONObject("routing") != null) {
            JSONObject value = in.getJSONObject("routing");
            if (!value.isNull("strategy")) {
                strategy = value.optString("strategy");
            }
            costMultiplier = value.optDouble("cost_multiplier", costMultiplier);
        }
        if (in.has("location")) {
            location = in.optString("location", location);
        }
        if (in.has("egress")) {
            Object value = in.opt("egress");
            if (value instanceof JSONObject) {
                JSONObject spec = (JSONObject) value;
                egress = spec.optBoolean("direct", false) ? ""
                        : spec.optString("url", spec.optString("host", egress));
            } else {
                egress = in.optString("egress", egress);
            }
        }
        if (in.has("identity")) {
            identity = in.optString("identity", identity);
        }
        if (in.has("free_only")) {
            freeOnly = in.optBoolean("free_only", freeOnly);
        }
        if (in.has("stealth") && in.optJSONObject("stealth") != null) {
            JSONObject value = in.getJSONObject("stealth");
            minIntervalMs = value.optDouble("min_interval_ms", minIntervalMs);
            maxConcurrency = value.optInt("max_concurrency", maxConcurrency);
            jitterMs = value.optDouble("jitter_ms", jitterMs);
        }
        if (in.has("user_agent")) {
            userAgent = in.optString("user_agent", userAgent);
        }
        if (in.has("extra_headers") && in.optJSONObject("extra_headers") != null) {
            extraHeaders = in.getJSONObject("extra_headers");
        }
    }

    // ------------------------------------------------------------------ new policy

    private static double nowSeconds() {
        return System.currentTimeMillis() / 1000.0;
    }

    /** Park this account until the provider's quota window rolls over. */
    public void markQuotaExhausted(double resetTs, String reason) {
        this.quotaResetTs = resetTs > nowSeconds() ? resetTs : nowSeconds() + 3600;
        this.quotaReason = reason == null ? "quota exhausted" : reason;
    }

    public void clearQuota() {
        quotaResetTs = 0;
        quotaReason = "";
    }

    public boolean quotaExhausted() {
        return quotaResetTs > nowSeconds();
    }

    /** The desktop identity this account presents upstream. */
    public Fingerprint.Profile identityProfile() {
        if (identity != null && !identity.isEmpty()) {
            return Fingerprint.profile(identity);
        }
        return Fingerprint.forAccount(name);
    }

    /** This account's outbound exit, or direct when none was assigned. */
    public Egress.Exit egressExit() {
        return Egress.parse(egress == null || egress.isEmpty() ? "direct" : egress);
    }

    /** Does this account serve the requested model? */
    public boolean serves(String model) {
        if (models.isEmpty()) {
            return true;                 // an account with no list accepts anything
        }
        for (String candidate : models) {
            if (candidate.equals(model)) {
                return true;
            }
            if (!modelsExact && model.startsWith(candidate)) {
                return true;
            }
        }
        return false;
    }

    /** Longest declared model this account can serve for a prefix match. */
    public String resolvePrefix(String model) {
        String best = null;
        for (String candidate : models) {
            if (model.startsWith(candidate) && (best == null || candidate.length() > best.length())) {
                best = candidate;
            }
        }
        return best;
    }

    public static String mask(String secret) {
        if (secret == null || secret.isEmpty()) {
            return "";
        }
        if (secret.length() <= 10) {
            return "****";
        }
        return secret.substring(0, 8) + "…" + secret.substring(secret.length() - 4);
    }
}