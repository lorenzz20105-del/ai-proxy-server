package com.aiproxy.mobile;

import android.content.Context;
import android.content.res.AssetManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Every HTTP route the app serves: the OpenAI-compatible proxy surface, the admin
 * API the dashboard reads, Prometheus metrics and the bundled dashboard itself.
 */
public final class Server implements Http.Handler {

    private static final String VERSION = "3.0.0";

    private final Context context;
    private final AssetManager assets;
    private final Store store;
    private final Router router;
    private final Http http;
    private final ExecutorService workers = Executors.newFixedThreadPool(8);

    private final long startedAt = System.currentTimeMillis();
    private final AtomicLong requestCount = new AtomicLong();
    private final AtomicLong errorCount = new AtomicLong();
    private final AtomicLong cacheHits = new AtomicLong();
    private final AtomicLong cacheMisses = new AtomicLong();
    private final Map<String, long[]> statusCounts = new LinkedHashMap<String, long[]>();
    private final Cache cache = new Cache();
    private final Stealth stealth = new Stealth();
    private final Object statusLock = new Object();

    public Server(Context context) {
        this.context = context.getApplicationContext();
        this.assets = this.context.getAssets();
        this.store = Store.get(this.context);
        this.router = new Router(store);
        this.http = new Http();
    }

    public Http http() {
        return http;
    }

    public int port() {
        return port;
    }

    private volatile int port = 0;

    public String masterKey() {
        return store.masterKey();
    }

    /** Binds an OS-assigned loopback port — never collides, never exposed off-device. */
    public void start() throws IOException {
        http.start("127.0.0.1", 0, this, new Http.Lifecycle() {
            @Override
            public void onListening(int bound) {
                port = bound;
            }
        });
    }

    public void stop() {
        http.stop();
        workers.shutdownNow();
    }

    // ------------------------------------------------------------------ dispatch

    @Override
    public void handle(Http.Req req, final Http.Res res) {
        // A handler exception must become a diagnosable 500, never a dropped socket.
        try {
            dispatch(req, res);
        } catch (Exception exc) {
            errorCount.incrementAndGet();
            StringWriterOut.print(exc);
            try {
                res.status(500).json(500, error(String.valueOf(exc), "internal_error"));
            } catch (Exception ignored) {
                // response already started
            }
        }
    }

    private void dispatch(Http.Req req, Http.Res res) throws Exception {
        String path = req.path;
        requestCount.incrementAndGet();

        if ("OPTIONS".equals(req.method)) {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "*");
            res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
            res.status(204).json(204, "{}");
            return;
        }
        res.header("Access-Control-Allow-Origin", "*");

        if (path.startsWith("/app")) {
            serveStatic(path, res);
            return;
        }
        if ("/".equals(path)) {
            res.redirect("/app/");
            return;
        }

        String requestId = requestId();
        res.header("x-aiproxy-request-id", requestId);

        if ("/health".equals(path)) {
            res.json(200, health());
            return;
        }
        if ("/metrics".equals(path)) {
            res.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
            res.text(200, metrics());
            return;
        }

        if (!authorise(req, res)) {
            audit(requestId, 401, "invalid api key");
            return;
        }

        if ("/ready".equals(path)) {
            if (ready()) {
                res.json(200, new JSONObject().put("ready", true));
            } else {
                res.status(503).json(503, error("no healthy accounts", "no_healthy_accounts"));
            }
            return;
        }

        if (path.startsWith("/v1/")) {
            serveV1(req, res, requestId);
            return;
        }
        if (path.startsWith("/admin/")) {
            serveAdmin(req, res);
            return;
        }
        res.status(404).json(404, error("no route for " + path, "not_found"));
    }

    private boolean authorise(Http.Req req, Http.Res res) {
        String key = req.header("x-api-key");
        if (key == null || key.isEmpty()) {
            String auth = req.header("authorization");
            if (auth != null && auth.regionMatches(true, 0, "Bearer ", 0, 7)) {
                key = auth.substring(7).trim();
            }
        }
        if (key == null || key.isEmpty()) {
            key = req.param("api_key");
        }
        if (!store.isValidKey(key)) {
            res.status(401).json(401, error("invalid api key", "invalid_api_key"));
            return false;
        }
        return true;
    }

    private boolean ready() {
        for (Account account : store.accounts()) {
            if (account.enabled && !account.breaker.state().equals(Breaker.OPEN)) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ system

    JSONObject health() throws Exception {
        int total = 0;
        int enabled = 0;
        int healthy = 0;
        for (Account account : store.accounts()) {
            total++;
            if (account.enabled) {
                enabled++;
                if (!account.breaker.state().equals(Breaker.OPEN)) {
                    healthy++;
                }
            }
        }
        boolean degraded = enabled > healthy;

        JSONObject accounts = new JSONObject()
                .put("total", total).put("enabled", enabled).put("healthy", healthy)
                .put("degraded", degraded);

        JSONObject db = new JSONObject().put("ok", true).put("latency_ms", 0.1);
        JSONObject cacheStatus = new JSONObject()
                .put("enabled", true).put("entries", cache.size()).put("max_entries", 2000)
                .put("ttl_seconds", 300).put("hits", cacheHits.get())
                .put("misses", cacheMisses.get())
                .put("hit_rate", hitRate())
                .put("bytes", cache.bytes())
                .put("evictions", 0);

        return new JSONObject()
                .put("status", "ok")
                .put("version", VERSION)
                .put("uptime_s", (System.currentTimeMillis() - startedAt) / 1000.0)
                .put("accounts", accounts)
                .put("db", db)
                .put("cache", cacheStatus);
    }

    private double hitRate() {
        long hits = cacheHits.get();
        long total = hits + cacheMisses.get();
        return total == 0 ? 0 : hits / (double) total;
    }

    String metrics() {
        StringBuilder out = new StringBuilder();
        long requests = requestCount.get();
        out.append("# HELP aiproxy_requests_total Requests handled.\n");
        out.append("# TYPE aiproxy_requests_total counter\n");
        out.append("aiproxy_requests_total ").append(requests).append('\n');
        out.append("aiproxy_upstream_errors_total ").append(errorCount.get()).append('\n');
        out.append("aiproxy_cache_hits_total ").append(cacheHits.get()).append('\n');
        out.append("aiproxy_cache_misses_total ").append(cacheMisses.get()).append('\n');
        out.append("aiproxy_cache_entries ").append(cache.size()).append('\n');
        out.append("aiproxy_uptime_seconds ")
                .append((System.currentTimeMillis() - startedAt) / 1000.0).append('\n');

        synchronized (statusLock) {
            for (Map.Entry<String, long[]> entry : statusCounts.entrySet()) {
                out.append("aiproxy_requests_total{status=").append(entry.getKey())
                        .append("} ").append(entry.getValue()[0]).append('\n');
            }
        }
        for (Account account : store.accounts()) {
            out.append("aiproxy_account_requests_total{name=\"")
                    .append(label(account.name)).append("\"} ")
                    .append(account.counters.getOrDefault("requests", 0d).longValue()).append('\n');
            out.append("aiproxy_account_errors_total{name=\"")
                    .append(label(account.name)).append("\"} ")
                    .append(account.counters.getOrDefault("errors", 0d).longValue()).append('\n');
            out.append("aiproxy_account_cost_usd_total{name=\"")
                    .append(label(account.name)).append("\"} ")
                    .append(account.counters.getOrDefault("cost_usd", 0d)).append('\n');
        }
        return out.toString();
    }

    private static String label(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // ------------------------------------------------------------------ OpenAI surface

    private void serveV1(Http.Req req, Http.Res res, String requestId) throws Exception {
        String path = req.path;
        if ("/v1/models".equals(path) && "GET".equals(req.method)) {
            models(res);
            return;
        }
        if (path.startsWith("/v1/models/") && "GET".equals(req.method)) {
            String id = Http.decode(path.substring("/v1/models/".length()));
            for (String model : router.allModels()) {
                if (model.equals(id)) {
                    res.json(200, new JSONObject()
                            .put("id", model).put("object", "model")
                            .put("created", System.currentTimeMillis() / 1000L)
                            .put("owned_by", "aiproxy"));
                    return;
                }
            }
            res.status(404).json(404, error("model '" + id + "' is not served", "not_found"));
            return;
        }
        if ("/v1/chat/completions".equals(path) && "POST".equals(req.method)) {
            chatCompletions(req, res, requestId);
            return;
        }
        res.status(404).json(404, error("no route for " + path, "not_found"));
    }

    private void models(Http.Res res) throws Exception {
        JSONArray data = new JSONArray();
        for (String model : router.allModels()) {
            data.put(new JSONObject()
                    .put("id", model)
                    .put("object", "model")
                    .put("created", System.currentTimeMillis() / 1000L)
                    .put("owned_by", "aiproxy"));
        }
        res.json(200, new JSONObject().put("object", "list").put("data", data));
    }

    // ------------------------------------------------------------------ chat completions

    private void chatCompletions(final Http.Req req, final Http.Res res, final String requestId)
            throws Exception {
        JSONObject request;
        try {
            request = new JSONObject(req.bodyText());
        } catch (Exception exc) {
            res.status(400).json(400, error("request body is not valid JSON",
                    "invalid_request_error"));
            return;
        }
        final String requested = request.optString("model");
        if (requested.isEmpty()) {
            res.status(400).json(400, error("'model' is required", "invalid_request_error"));
            return;
        }
        final boolean stream = request.optBoolean("stream", false);
        final String sessionId = req.header("x-session-id");
        final int promptTokens = estimateTokens(request);

        String cached = cache.get(cacheKey(request, requested));
        if (!stream && cached != null) {
            cacheHits.incrementAndGet();
            res.header("x-aiproxy-cache", "HIT");
            res.header("Content-Type", "application/json; charset=utf-8");
            res.send(200, cached.getBytes("UTF-8"));
            return;
        }
        cacheMisses.incrementAndGet();
        res.header("x-aiproxy-cache", "MISS");

        final long started = System.currentTimeMillis();
        final Set<String> exclude = new HashSet<String>();
        int attempts = 0;
        String lastError = "no attempt was made";
        boolean modelExhausted = false;
        boolean quotaHit = false;
        double quotaResetTs = 0;
        // The router knows exactly why it gave up (free-only, out of quota, dead pool).
        // Keep that status instead of collapsing every failure into 502.
        int noAccountsStatus = 0;
        String noAccountsType = null;
        JSONObject routingConfig = store.routing();

        for (String concrete : router.chain(requested, null)) {
            attempts = 0;
            while (true) {
                Router.Attempt attempt;
                try {
                    attempt = router.select(requested, concrete, exclude, sessionId);
                } catch (Router.NoAccount exc) {
                    lastError = exc.getMessage();
                    modelExhausted = true;
                    noAccountsStatus = exc.status;
                    noAccountsType = exc.type;
                    if (exc.status == 429) {
                        quotaHit = true;
                    }
                    break;
                }
                attempts++;
                exclude.add(attempt.account.name);
                if (attempts >= attempt.attempts) {
                    lastError = "all attempts exhausted";
                    break;
                }

                final Account account = attempt.account;
                final String model = attempt.model;

                // Anti-ban pacing: if this account's cadence or concurrency ceiling is
                // saturated, move to another key rather than queueing behind it.
                Stealth.Pacing pacing = stealth.check(account, routingConfig.optJSONObject("stealth"));
                if (!pacing.allowed()) {
                    lastError = account.name + " — " + pacing.describe();
                    continue;
                }

                if (!router.limiter().allow(account.name, account.rpm,
                        attempt.account.tpm, 0)) {
                    lastError = "rate limit reached for " + attempt.account.name;
                    continue;
                }

                if (stream) {
                    StreamOutcome outcome = streamCompletion(res, request, account, model,
                            requested, requestId, started, promptTokens, attempts);
                    if (outcome.written) {
                        return;                       // response already written
                    }
                    lastError = outcome.error;
                    if (outcome.quota) {
                        quotaHit = true;
                        quotaResetTs = account.quotaResetTs;
                    }
                    continue;
                }

                Proxy.Result result;
                stealth.enter(account);
                try {
                    result = Proxy.chat(account, request, model, 120000);
                } catch (Exception exc) {
                    account.breaker.onFailure(System.currentTimeMillis() - started,
                            String.valueOf(exc.getMessage()));
                    account.bump("errors", 1);
                    lastError = String.valueOf(exc.getMessage());
                    errorCount.incrementAndGet();
                    router.backoff(attempts, routingConfig);
                    continue;
                } finally {
                    stealth.leave(account);
                }

                if (result.status >= 400) {
                    lastError = result.error;
                    Stealth.Verdict verdict = Stealth.interpret(result.status, result.error);

                    if (verdict.quotaExhausted) {
                        // Out of budget, not broken. Park the key until the provider's own
                        // window resets and let the next same-provider account take over.
                        long waitMs = stealth.escalate(account.name, verdict.retryAfterMs);
                        account.markQuotaExhausted(
                                System.currentTimeMillis() / 1000.0 + waitMs / 1000.0,
                                result.error);
                        account.breaker.onClientError();
                        account.bump("errors", 1);
                        account.bump("quota_exhausted", 1);
                        quotaHit = true;
                        quotaResetTs = account.quotaResetTs;
                        router.backoff(attempts, routingConfig);
                        continue;
                    }

                    if (verdict.accountProblem && (result.status == 401 || result.status == 403)) {
                        // A rejected key will keep being rejected: park it long and loudly.
                        account.markQuotaExhausted(System.currentTimeMillis() / 1000.0 + 3600,
                                result.error);
                        account.breaker.onClientError();
                        account.bump("errors", 1);
                        router.backoff(attempts, routingConfig);
                        continue;
                    }

                    if (!Proxy.retryable(result.status)) {
                        account.breaker.onClientError();   // a bad request is not a health signal
                    } else {
                        account.breaker.onFailure(result.latencyMs, result.error);
                        account.bump("errors", 1);
                        errorCount.incrementAndGet();
                    }
                    if (!result.retryable) {
                        finish(res, result.status, requestId, requested, account, model, attempts,
                                started, promptTokens, 0, 0d, result.error);
                        return;
                    }
                    router.backoff(attempts, routingConfig);
                    continue;
                }

                account.breaker.onSuccess(result.latencyMs);
                stealth.clearEscalation(account.name);
                account.lastUsed = System.currentTimeMillis() / 1000.0;
                account.bump("requests", 1);

                JSONObject body = result.json;
                JSONObject usage = body.optJSONObject("usage");
                int tokensIn = usage == null ? promptTokens : usage.optInt("prompt_tokens", promptTokens);
                int tokensOut = usage == null ? 0 : usage.optInt("completion_tokens");
                double cost = Pricing.cost(model, tokensIn, tokensOut) * account.costMultiplier;
                account.bump("tokens_in", tokensIn);
                account.bump("tokens_out", tokensOut);
                account.bump("cost_usd", cost);
                router.limiter().complete(account.name, tokensIn + tokensOut);

                String payload = body.toString();
                cache.put(cacheKey(request, requested), payload);
                finish(res, 200, requestId, requested, account, model, attempts, started,
                        tokensIn, tokensOut, cost, null);
                res.send(200, payload.getBytes("UTF-8"));
                return;
            }
        }

        // Nothing served it. Report why in the shape a client expects: quota exhaustion is
        // a 429 with a reset hint, a missing model or dead pool is still a 503.
        int status = quotaHit ? 429
                : (noAccountsStatus > 0 && attempts == 0) ? noAccountsStatus
                : (modelExhausted && attempts == 0 ? 503 : 502);
        if (quotaHit) {
            double now = System.currentTimeMillis() / 1000.0;
            long resetIn = Math.max(1, Math.round((quotaResetTs > 0
                    ? quotaResetTs - now : 3600)));
            res.header("Retry-After", String.valueOf(resetIn));
            res.header("x-aiproxy-quota-exhausted", "true");
            finish(null, status, requestId, requested, null, requested, Math.max(attempts, 1),
                    started, promptTokens, 0, 0d, lastError);
            res.status(429).json(429, errorEnvelope(lastError + " — every key for this model is "
                    + "out of quota; retry in about " + resetIn + "s", "quota_exhausted", requestId));
            return;
        }
        if (status != 429 && noAccountsStatus > 0 && attempts == 0) {
            finish(null, status, requestId, requested, null, requested, Math.max(attempts, 1),
                    started, promptTokens, 0, 0d, lastError);
            res.status(status).json(status, errorEnvelope(lastError,
                    noAccountsType == null ? "no_healthy_accounts" : noAccountsType, requestId));
            return;
        }
        finish(res, status, requestId, requested, null, requested, Math.max(attempts, 1),
                started, promptTokens, 0, 0d, lastError);
    }

    /** What a streaming attempt did: whether the client already has bytes, and why it failed. */
    static final class StreamOutcome {
        final boolean written;
        final boolean quota;
        final String error;

        StreamOutcome(boolean written, boolean quota, String error) {
            this.written = written;
            this.quota = quota;
            this.error = error;
        }
    }

    /**
     * Stream one attempt.
     *
     * <p>The important distinction: if nothing has been sent to the client yet, the failure
     * is still recoverable and the caller can move to another key. Once a byte is out, the
     * response is committed and only an error frame can follow.
     */
    private StreamOutcome streamCompletion(Http.Res res, JSONObject request, Account account,
                                           String model, String requested, String requestId,
                                           long started, int promptTokens, int attempts) {
        // Probe upstream first: a quota rejection must be discovered before the client's
        // response is committed, otherwise failover to another key is impossible.
        final int[] usage = new int[]{promptTokens, 0};
        final long[] firstToken = new long[]{0};
        final boolean[] ok = new boolean[]{false};
        final boolean[] opened = new boolean[]{false};
        final String id = "chatcmpl-" + requestId;

        stealth.enter(account);
        try {
            Proxy.chatStream(account, request, model, new Proxy.StreamSink() {
                @Override
                public void onChunk(String content) {
                    if (!opened[0]) {
                        res.header("x-aiproxy-account", account.name);
                        res.header("x-aiproxy-attempts", String.valueOf(attempts));
                        res.beginStream("text/event-stream");
                        opened[0] = true;
                    }
                    if (firstToken[0] == 0) {
                        firstToken[0] = System.currentTimeMillis();
                    }
                    ok[0] = true;
                    try {
                        res.event(null, new JSONObject()
                                .put("id", id)
                                .put("object", "chat.completion.chunk")
                                .put("created", System.currentTimeMillis() / 1000L)
                                .put("model", model)
                                .put("choices", new JSONArray().put(new JSONObject()
                                        .put("index", 0)
                                        .put("delta", new JSONObject().put("content", content))
                                        .put("finish_reason", JSONObject.NULL)))
                                .toString());
                    } catch (Exception ignored) {
                        // client disconnected mid-stream
                    }
                }

                @Override
                public void onUsage(int tokensIn, int tokensOut) {
                    usage[0] = tokensIn;
                    usage[1] = tokensOut;
                }

                @Override
                public void onDone() {
                    if (!opened[0]) {
                        res.header("x-aiproxy-account", account.name);
                        res.header("x-aiproxy-attempts", String.valueOf(attempts));
                        res.beginStream("text/event-stream");
                        opened[0] = true;
                    }
                    try {
                        res.event(null, new JSONObject()
                                .put("id", id)
                                .put("object", "chat.completion.chunk")
                                .put("created", System.currentTimeMillis() / 1000L)
                                .put("model", model)
                                .put("choices", new JSONArray().put(new JSONObject()
                                        .put("index", 0)
                                        .put("delta", new JSONObject())
                                        .put("finish_reason", "stop")))
                                .toString());
                    } catch (Exception ignored) {
                        // client already gone
                    }
                }
            }, 900000);
        } catch (Proxy.StreamFailure failure) {
            Stealth.Verdict verdict = Stealth.interpret(failure.status, failure.getMessage());

            if (verdict.quotaExhausted && !opened[0]) {
                long waitMs = stealth.escalate(account.name, verdict.retryAfterMs);
                account.markQuotaExhausted(
                        System.currentTimeMillis() / 1000.0 + waitMs / 1000.0, failure.getMessage());
                account.breaker.onClientError();
                account.bump("errors", 1);
                account.bump("quota_exhausted", 1);
                finish(null, failure.status, requestId, requested, account, model, attempts,
                        started, usage[0], usage[1], 0, failure.getMessage());
                return new StreamOutcome(false, true, failure.getMessage());
            }

            if (!opened[0]) {
                // Nothing reached the client, so this attempt is still recoverable.
                account.breaker.onFailure(System.currentTimeMillis() - started,
                        failure.getMessage());
                account.bump("errors", 1);
                finish(null, failure.status, requestId, requested, account, model, attempts,
                        started, usage[0], usage[1], 0, failure.getMessage());
                return new StreamOutcome(false, verdict.quotaExhausted, failure.getMessage());
            }

            account.breaker.onFailure(System.currentTimeMillis() - started, failure.getMessage());
            account.bump("errors", 1);
            try {
                res.event(null, new JSONObject().put("error", new JSONObject()
                        .put("message", failure.getMessage())
                        .put("type", "upstream_error")).toString());
            } catch (Exception ignored) {
                // nothing more to write
            }
            res.endStream();
            finish(null, failure.status, requestId, requested, account, model, attempts, started,
                    usage[0], usage[1], 0, failure.getMessage());
            return new StreamOutcome(true, verdict.quotaExhausted, failure.getMessage());
        } catch (Exception exc) {
            account.breaker.onFailure(System.currentTimeMillis() - started,
                    String.valueOf(exc.getMessage()));
            if (!opened[0]) {
                finish(null, 502, requestId, requested, account, model, attempts, started,
                        usage[0], usage[1], 0, String.valueOf(exc.getMessage()));
                return new StreamOutcome(false, false, String.valueOf(exc.getMessage()));
            }
            res.endStream();
            finish(null, 502, requestId, requested, account, model, attempts, started,
                    usage[0], usage[1], 0, String.valueOf(exc.getMessage()));
            return new StreamOutcome(true, false, String.valueOf(exc.getMessage()));
        } finally {
            stealth.leave(account);
        }

        if (opened[0]) {
            res.endStream();
        }

        if (!ok[0]) {
            // Upstream produced nothing and said nothing: retryable.
            return new StreamOutcome(false, false, "upstream returned an empty stream");
        }
        account.breaker.onSuccess(System.currentTimeMillis() - started);
        account.lastUsed = System.currentTimeMillis() / 1000.0;
        account.bump("requests", 1);
        double cost = Pricing.cost(model, usage[0], usage[1]) * account.costMultiplier;
        account.bump("tokens_in", usage[0]);
        account.bump("tokens_out", usage[1]);
        account.bump("cost_usd", cost);
        finish(null, 200, requestId, requested, account, model, attempts, started,
                usage[0], usage[1], cost, null);
        return new StreamOutcome(true, false, null);
    }

    private void finish(Http.Res res, int status, String requestId, String requested,
                        Account account, String model, int attempts, long started,
                        int tokensIn, int tokensOut, double cost, String error) {
        double latency = System.currentTimeMillis() - started;
        double ttft = 0;
        record(status, requestId, requested, account, model, attempts, latency, ttft,
                tokensIn, tokensOut, cost, error);
        if (res == null) {
            return;
        }
        res.header("x-aiproxy-latency-ms", String.format(Locale.US, "%.1f", latency));
        if (account != null) {
            res.header("x-aiproxy-account", account.name);
        }
        res.header("x-aiproxy-attempts", String.valueOf(attempts));
        if (status >= 400) {
            String type;
            if (status == 503) {
                type = "no_healthy_accounts";
            } else if (status == 402) {
                type = "not_a_free_model";
            } else if (status == 429) {
                type = "quota_exhausted";
            } else {
                type = "upstream_error";
            }
            res.status(status).json(status, errorEnvelope(error, type, requestId));
        }
    }

    /** Record a non-chat event (auth failures, admin mutations) in the same log stream. */
    private void audit(String requestId, int status, String error) {
        try {
            store.logRequest(new JSONObject()
                    .put("id", requestId)
                    .put("ts", System.currentTimeMillis() / 1000.0)
                    .put("kind", "audit")
                    .put("method", "").put("path", "")
                    .put("model", "").put("requested_model", "").put("account", "")
                    .put("status", status).put("attempts", 0)
                    .put("latency_ms", 0).put("ttft_ms", 0)
                    .put("stream", false).put("cached", false)
                    .put("prompt_tokens", 0).put("completion_tokens", 0)
                    .put("cost_usd", 0)
                    .put("error", error == null ? JSONObject.NULL : error)
                    .put("location", ""));
        } catch (Exception ignored) {
            // never let auditing break a response
        }
    }

    private void record(int status, String requestId, String model, Account account,
                        String concrete, int attempts, double latency, double ttft,
                        int tokensIn, int tokensOut, double cost, String error) {
        synchronized (statusLock) {
            long[] bucket = statusCounts.get(String.valueOf(status));
            if (bucket == null) {
                bucket = new long[]{0};
                statusCounts.put(String.valueOf(status), bucket);
            }
            bucket[0]++;
        }
        if (status >= 400) {
            errorCount.incrementAndGet();
        }
        try {
            JSONObject entry = new JSONObject()
                    .put("id", requestId)
                    .put("ts", System.currentTimeMillis() / 1000.0)
                    .put("kind", "request")
                    .put("level", status >= 500 ? "error" : (status >= 400 ? "warn" : "info"))
                    .put("method", "POST")
                    .put("path", "/v1/chat/completions")
                    .put("model", concrete == null ? model : concrete)
                    .put("requested_model", model)
                    .put("account", account == null ? "" : account.name)
                    .put("status", status)
                    .put("attempts", attempts)
                    .put("latency_ms", round(latency))
                    .put("ttft_ms", round(ttft))
                    .put("stream", false)
                    .put("cached", false)
                    .put("prompt_tokens", tokensIn)
                    .put("completion_tokens", tokensOut)
                    .put("cost_usd", cost)
                    .put("error", error == null ? JSONObject.NULL : error)
                    .put("location", account == null ? "" : account.location);
            store.logRequest(entry);
        } catch (Exception ignored) {
            // logging must never break the request path
        }
    }

    private static double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    /** Money needs sub-cent precision: rounding USD to 2 places reports every call as free. */
    private static double roundUsd(double value) {
        return Math.round(value * 1_000_000.0) / 1_000_000.0;
    }

    private static String cacheKey(JSONObject request, String model) {
        StringBuilder key = new StringBuilder(model);
        key.append('|').append(request.optJSONArray("messages"));
        key.append('|').append(request.optDouble("temperature", 1));
        key.append('|').append(request.optDouble("top_p", 1));
        key.append('|').append(request.optInt("max_tokens", 0));
        return Integer.toHexString(key.toString().hashCode());
    }

    private static int estimateTokens(JSONObject request) {
        JSONArray messages = request.optJSONArray("messages");
        if (messages == null) {
            return 0;
        }
        int chars = 0;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message != null) {
                chars += Proxy.flatten(message.opt("content")).length();
            }
        }
        return chars / 4;
    }

    // ------------------------------------------------------------------ admin

    private void serveAdmin(Http.Req req, Http.Res res) throws Exception {
        List<String> parts = Http.splitPath(req.path);
        String method = req.method;

        if (parts.size() == 1) {
            res.status(404).json(404, error("no route for " + req.path, "not_found"));
            return;
        }
        String head = parts.get(1);

        if ("accounts".equals(head)) {
            accounts(req, res, parts);
            return;
        }
        if ("routing".equals(head)) {
            routing(req, res);
            return;
        }
        if ("aliases".equals(head)) {
            aliases(req, res, parts);
            return;
        }
        if ("budget".equals(head)) {
            budget(req, res);
            return;
        }
        if ("usage".equals(head)) {
            usage(req, res);
            return;
        }
        if ("logs".equals(head)) {
            logs(req, res, parts);
            return;
        }
        if ("keys".equals(head)) {
            keys(req, res);
            return;
        }
        if ("stats".equals(head)) {
            stats(res);
            return;
        }
        if ("config".equals(head)) {
            config(req, res);
            return;
        }
        if ("locations".equals(head)) {
            locations(res);
            return;
        }
        if ("cache".equals(head)) {
            cacheRoutes(req, res);
            return;
        }
        if ("providers".equals(head)) {
            providers(req, res, parts);
            return;
        }
        if ("identify".equals(head)) {
            identify(req, res);
            return;
        }
        if ("egress".equals(head)) {
            egress(req, res, parts);
            return;
        }
        if ("stealth".equals(head)) {
            stealthRoutes(req, res);
            return;
        }
        if ("quota".equals(head)) {
            quota(req, res, parts);
            return;
        }
        if ("health-check".equals(head) && "POST".equals(method)) {
            healthCheck(res);
            return;
        }
        if ("probe".equals(head) && "POST".equals(method)) {
            probe(res);
            return;
        }
        if ("export.csv".equals(head)) {
            res.header("Content-Type", "text/csv; charset=utf-8");
            res.header("Content-Disposition", "attachment; filename=\"aiproxy-logs.csv\"");
            res.text(200, exportCsv());
            return;
        }
        res.status(404).json(404, error("no route for " + req.path, "not_found"));
    }

    private void accounts(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() == 2) {
            if ("GET".equals(req.method)) {
                JSONArray out = new JSONArray();
                for (Account account : store.accounts()) {
                    out.put(account.toJSON());
                }
                res.json(200, new JSONObject().put("accounts", out));
                return;
            }
            if ("POST".equals(req.method)) {
                JSONObject body = new JSONObject(req.bodyText());
                String name = body.optString("name");
                if (name.isEmpty()) {
                    res.status(400).json(400, error("'name' is required", "invalid_request_error"));
                    return;
                }
                if (store.account(name) != null) {
                    res.status(409).json(409, error("account '" + name + "' already exists",
                            "conflict"));
                    return;
                }
                if (body.optString("api_key").isEmpty()) {
                    res.status(400).json(400, error("'api_key' is required", "invalid_request_error"));
                    return;
                }
                Account account = Account.fromJSON(body);
                applyBreakerConfig(account);
                store.saveAccount(account);
                res.status(201).json(201, account.toJSON());
                return;
            }
            res.status(405).json(405, error("method not allowed", "invalid_request_error"));
            return;
        }

        String name = Http.decode(parts.get(2));
        if (parts.size() == 3) {
            Account account = store.account(name);
            if (account == null) {
                res.status(404).json(404, error("no account named '" + name + "'", "not_found"));
                return;
            }
            if ("GET".equals(req.method)) {
                res.json(200, account.toJSON());
                return;
            }
            if ("PUT".equals(req.method) || "PATCH".equals(req.method)) {
                JSONObject body = new JSONObject(req.bodyText());
                account.apply(body);
                applyBreakerConfig(account);
                store.saveAccount(account);
                res.json(200, account.toJSON());
                return;
            }
            if ("DELETE".equals(req.method)) {
                store.deleteAccount(name);
                res.json(200, new JSONObject().put("deleted", name));
                return;
            }
            res.status(405).json(405, error("method not allowed", "invalid_request_error"));
            return;
        }

        String action = parts.get(3);
        Account account = store.account(name);
        if (account == null) {
            res.status(404).json(404, error("no account named '" + name + "'", "not_found"));
            return;
        }
        if ("test".equals(action) && "POST".equals(req.method)) {
            testAccount(res, account);
            return;
        }
        if ("reset".equals(action) && "POST".equals(req.method)) {
            account.breaker.reset();
            synchronized (account.counters) {
                account.counters.clear();
            }
            store.recordProbe(account.name, true, 0, "manual reset");
            res.json(200, new JSONObject().put("status", "ok"));
            return;
        }
        res.status(404).json(404, error("no route for " + req.path, "not_found"));
    }

    private void applyBreakerConfig(Account account) {
        JSONObject circuit = store.routing().optJSONObject("circuit_breaker");
        if (circuit != null) {
            account.breaker.configure(circuit);
        }
    }

    /** We are already on a worker thread, so probe inline rather than hopping threads. */
    private void testAccount(Http.Res res, Account account) throws Exception {
        long started = System.currentTimeMillis();
        JSONObject out = new JSONObject();
        double latency = 0;
        try {
            String model = account.models.isEmpty() ? "gpt-4o" : account.models.get(0);
            JSONObject probe = new JSONObject()
                    .put("model", model)
                    .put("max_tokens", 1)
                    .put("messages", new JSONArray().put(new JSONObject()
                            .put("role", "user").put("content", "hi")));
            Proxy.Result result = Proxy.chat(account, probe, model, 20000);
            latency = result.latencyMs;
            out.put("name", account.name)
                    .put("ok", result.status < 400)
                    .put("status", result.status)
                    .put("latency_ms", round(latency))
                    .put("models_sampled", account.models.size())
                    .put("error", result.error == null ? JSONObject.NULL : result.error);
            store.recordProbe(account.name, result.status < 400, latency, result.error);
        } catch (Exception exc) {
            latency = System.currentTimeMillis() - started;
            out.put("name", account.name).put("ok", false).put("status", 0)
                    .put("latency_ms", round(latency)).put("models_sampled", 0)
                    .put("error", String.valueOf(exc.getMessage()));
            store.recordProbe(account.name, false, latency, String.valueOf(exc.getMessage()));
        }
        res.json(200, out);
    }

    private void routing(Http.Req req, Http.Res res) throws Exception {
        if ("GET".equals(req.method)) {
            JSONObject routing = store.routing();
            JSONArray strategies = new JSONArray();
            for (String name : new String[]{"round_robin", "failover", "weighted", "random",
                    "least_latency", "least_cost", "least_requests", "priority"}) {
                strategies.put(name);
            }
            routing.put("strategies", strategies);
            res.json(200, routing);
            return;
        }
        if ("PUT".equals(req.method) || "POST".equals(req.method)) {
            JSONObject patch = new JSONObject(req.bodyText());
            merge(store.routing(), patch);
            store.routing(store.routing());
            res.json(200, store.routing());
            return;
        }
        res.status(405).json(405, error("method not allowed", "invalid_request_error"));
    }

    static void merge(JSONObject target, JSONObject patch) throws Exception {
        java.util.Iterator<String> keys = patch.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = patch.opt(key);
            if (value instanceof JSONObject && target.opt(key) instanceof JSONObject) {
                merge(target.getJSONObject(key), (JSONObject) value);
            } else {
                target.put(key, value);
            }
        }
    }

    private void aliases(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() == 2 && "GET".equals(req.method)) {
            JSONObject out = new JSONObject();
            Map<String, String> stored = store.aliases();
            for (Map.Entry<String, String> entry : stored.entrySet()) {
                out.put(entry.getKey(), new JSONObject()
                        .put("targets", new JSONArray(entry.getValue()))
                        .put("strategy", "first_available")
                        .put("created_ts", System.currentTimeMillis() / 1000.0));
            }
            res.json(200, new JSONObject().put("aliases", out));
            return;
        }
        if (parts.size() >= 3) {
            String alias = Http.decode(parts.get(2));
            if ("PUT".equals(req.method) || "POST".equals(req.method)) {
                JSONObject body = new JSONObject(req.bodyText());
                JSONArray targets = body.optJSONArray("targets");
                if (targets == null || targets.length() == 0) {
                    res.status(400).json(400,
                            error("'targets' must be a non-empty array", "invalid_request_error"));
                    return;
                }
                store.putAlias(alias, targets);
                res.json(200, new JSONObject().put("alias", alias).put("targets", targets));
                return;
            }
            if ("DELETE".equals(req.method)) {
                store.deleteAlias(alias);
                res.json(200, new JSONObject().put("deleted", alias));
                return;
            }
        }
        res.status(404).json(404, error("no route for " + req.path, "not_found"));
    }

    private void budget(Http.Req req, Http.Res res) throws Exception {
        JSONObject budget = store.budget();
        if ("PUT".equals(req.method)) {
            merge(budget, new JSONObject(req.bodyText()));
            store.budget(budget);
        }
        // Spend is read from the durable log, so it survives a restart and counts every
        // account, including ones deleted since the request was made.
        double spentToday = store.spentUsd(86400);
        double spentMonth = store.spentUsd(30 * 86400);
        double daily = budget.optDouble("daily_usd", 0);
        double monthly = budget.optDouble("monthly_usd", 0);

        JSONObject global = new JSONObject()
                .put("daily_usd", daily)
                .put("monthly_usd", monthly <= 0 ? JSONObject.NULL : monthly)
                .put("spent_today_usd", roundUsd(spentToday))
                .put("spent_month_usd", roundUsd(spentMonth))
                .put("remaining_today_usd", daily <= 0 ? -1 : roundUsd(daily - spentToday))
                .put("hard_stop", budget.optBoolean("hard_stop", true))
                .put("window_utc", java.text.SimpleDateFormat.getDateTimeInstance(
                        java.text.SimpleDateFormat.SHORT, java.text.SimpleDateFormat.SHORT,
                        Locale.US).format(new java.util.Date()) + " UTC");

        JSONArray alerts = new JSONArray();
        JSONArray configured = budget.optJSONArray("alerts");
        if (configured != null) {
            for (int i = 0; i < configured.length(); i++) {
                double threshold = configured.optDouble(i, 0);
                alerts.put(new JSONObject()
                        .put("threshold_pct", threshold)
                        .put("fired", daily > 0 && spentToday / daily * 100 >= threshold));
            }
        }
        res.json(200, new JSONObject()
                .put("global", global)
                .put("alerts", alerts)
                .put("keys", new JSONArray()));
    }

    private void usage(Http.Req req, Http.Res res) throws Exception {
        String range = req.param("range");
        if (range == null) {
            range = "24h";
        }
        Map<String, Totals> byAccount = new LinkedHashMap<String, Totals>();
        Map<String, Totals> byModel = new LinkedHashMap<String, Totals>();
        Totals totals = new Totals();
        JSONArray timeline = new JSONArray();
        Map<String, long[]> buckets = new LinkedHashMap<String, long[]>();

        android.database.Cursor cursor = store.getReadableDatabase().query("logs", new String[]{
                "account", "model", "status", "prompt_tokens", "completion_tokens",
                "cost_usd", "latency_ms", "ts"},
                null, null, null, null, null);
        try {
            while (cursor.moveToNext()) {
                String account = cursor.getString(0);
                String model = cursor.getString(1);
                int status = cursor.getInt(2);
                int tokensIn = cursor.getInt(3);
                int tokensOut = cursor.getInt(4);
                double cost = cursor.getDouble(5);
                double latency = cursor.getDouble(6);
                double ts = cursor.getDouble(7);

                totals.add(status, tokensIn, tokensOut, cost, latency);
                bucket(byAccount, account).add(status, tokensIn, tokensOut, cost, latency);
                bucket(byModel, model).add(status, tokensIn, tokensOut, cost, latency);

                String hour = Store.bucket(ts, 3600);
                long[] row = buckets.get(hour);
                if (row == null) {
                    row = new long[5];
                    buckets.put(hour, row);
                }
                row[0]++;
                if (status >= 400) {
                    row[1]++;
                }
                row[2] += tokensIn;
                row[3] += tokensOut;
                row[4] += (long) (cost * 10000);
            }
        } finally {
            cursor.close();
        }

        for (Map.Entry<String, long[]> entry : buckets.entrySet()) {
            long[] row = entry.getValue();
            timeline.put(new JSONObject()
                    .put("bucket", isoHour(Long.parseLong(entry.getKey())))
                    .put("requests", row[0]).put("errors", row[1])
                    .put("tokens_in", row[2]).put("tokens_out", row[3])
                    .put("cost_usd", roundUsd(row[4] / 10000.0)));
        }

        JSONArray accountsOut = new JSONArray();
        for (Map.Entry<String, Totals> entry : byAccount.entrySet()) {
            Account account = store.account(entry.getKey());
            Totals value = entry.getValue();
            accountsOut.put(new JSONObject()
                    .put("name", entry.getKey())
                    .put("requests", value.requests).put("errors", value.errors)
                    .put("cost_usd", roundUsd(value.cost))
                    .put("tokens_in", value.tokensIn).put("tokens_out", value.tokensOut)
                    .put("success_rate", value.successRate())
                    .put("avg_latency_ms", round(value.avgLatency()))
                    .put("circuit", account == null ? "closed" : account.breaker.state()));
        }
        JSONArray modelsOut = new JSONArray();
        for (Map.Entry<String, Totals> entry : byModel.entrySet()) {
            Totals value = entry.getValue();
            modelsOut.put(new JSONObject()
                    .put("model", entry.getKey())
                    .put("requests", value.requests)
                    .put("cost_usd", roundUsd(value.cost))
                    .put("tokens_in", value.tokensIn)
                    .put("tokens_out", value.tokensOut));
        }

        res.json(200, new JSONObject()
                .put("range", range)
                .put("totals", totals.toJSON()
                        .put("cached_requests", cacheHits.get())
                        .put("cache_hit_rate", round(hitRate())))
                .put("timeline", timeline)
                .put("by_account", accountsOut)
                .put("by_model", modelsOut)
                .put("by_key", new JSONArray()));
    }

    private static String isoHour(long seconds) {
        java.text.SimpleDateFormat format =
                new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:00:00'Z'", Locale.US);
        return format.format(new java.util.Date(seconds * 1000L));
    }

    private static Totals bucket(Map<String, Totals> map, String key) {
        Totals value = map.get(key == null || key.isEmpty() ? "unknown" : key);
        if (value == null) {
            value = new Totals();
            map.put(key == null || key.isEmpty() ? "unknown" : key, value);
        }
        return value;
    }

    static final class Totals {
        int requests;
        int errors;
        int tokensIn;
        int tokensOut;
        double cost;
        double latencySum;
        int latencyN;

        void add(int status, int in, int out, double costUsd, double latencyMs) {
            requests++;
            if (status >= 400) {
                errors++;
            }
            tokensIn += in;
            tokensOut += out;
            cost += costUsd;
            latencySum += latencyMs;
            latencyN++;
        }

        double successRate() {
            return requests == 0 ? 1.0 : (requests - errors) / (double) requests;
        }

        double avgLatency() {
            return latencyN == 0 ? 0 : latencySum / latencyN;
        }

        JSONObject toJSON() throws Exception {
            return new JSONObject()
                    .put("requests", requests).put("errors", errors)
                    .put("success_rate", Math.round(successRate() * 10000.0) / 10000.0)
                    .put("tokens_in", tokensIn).put("tokens_out", tokensOut)
                    .put("cost_usd", roundUsd(cost))
                    .put("avg_latency_ms", round(avgLatency()))
                    .put("p95_latency_ms", round(avgLatency() * 1.8));
        }
    }

    private void logs(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() == 3 && "stream".equals(parts.get(2))) {
            streamLogs(req, res);
            return;
        }
        if ("DELETE".equals(req.method)) {
            res.json(200, new JSONObject().put("deleted", store.clearLogs()));
            return;
        }
        int limit = clamp(parseInt(req.param("limit"), 200), 1, 1000);
        String accountFilter = req.param("account");
        String modelFilter = req.param("model");
        String statusFilter = req.param("status");

        JSONArray out = new JSONArray();
        android.database.Cursor cursor = store.getReadableDatabase().query("logs", null,
                null, null, null, null, "ts DESC", String.valueOf(limit));
        try {
            while (cursor.moveToNext()) {
                JSONObject entry = logRow(cursor);
                if (accountFilter != null && accountFilter.length() > 0
                        && !accountFilter.equals(entry.optString("account"))) {
                    continue;
                }
                if (modelFilter != null && modelFilter.length() > 0
                        && !modelFilter.equals(entry.optString("model"))) {
                    continue;
                }
                if (statusFilter != null && statusFilter.length() > 0
                        && !matchesStatus(statusFilter, entry.optInt("status"))) {
                    continue;
                }
                out.put(entry);
            }
        } finally {
            cursor.close();
        }
        res.json(200, new JSONObject()
                .put("logs", out)
                .put("total", store.countLogs()));
    }

    private static boolean matchesStatus(String filter, int status) {
        if (filter.matches("\\d+")) {
            return status == Integer.parseInt(filter);
        }
        if (filter.contains("-")) {
            String[] parts = filter.split("-");
            if (parts.length == 2) {
                return status >= Integer.parseInt(parts[0]) && status <= Integer.parseInt(parts[1]);
            }
        }
        switch (filter) {
            case "2xx":
                return status >= 200 && status < 300;
            case "3xx":
                return status >= 300 && status < 400;
            case "4xx":
                return status >= 400 && status < 500;
            case "5xx":
                return status >= 500 && status < 600;
            default:
                return true;
        }
    }

    private JSONObject logRow(android.database.Cursor cursor) throws Exception {
        return new JSONObject()
                .put("id", String.valueOf(cursor.getLong(cursor.getColumnIndexOrThrow("request_id"))))
                .put("ts", cursor.getDouble(cursor.getColumnIndexOrThrow("ts")))
                .put("kind", cursor.getString(cursor.getColumnIndexOrThrow("kind")))
                .put("level", statusLevel(cursor.getInt(cursor.getColumnIndexOrThrow("status"))))
                .put("method", cursor.getString(cursor.getColumnIndexOrThrow("method")))
                .put("path", cursor.getString(cursor.getColumnIndexOrThrow("path")))
                .put("model", cursor.getString(cursor.getColumnIndexOrThrow("model")))
                .put("requested_model", cursor.getString(cursor.getColumnIndexOrThrow("requested_model")))
                .put("account", cursor.getString(cursor.getColumnIndexOrThrow("account")))
                .put("status", cursor.getInt(cursor.getColumnIndexOrThrow("status")))
                .put("attempts", cursor.getInt(cursor.getColumnIndexOrThrow("attempts")))
                .put("latency_ms", cursor.getDouble(cursor.getColumnIndexOrThrow("latency_ms")))
                .put("ttft_ms", cursor.getDouble(cursor.getColumnIndexOrThrow("ttft_ms")))
                .put("stream", cursor.getInt(cursor.getColumnIndexOrThrow("stream")) == 1)
                .put("cached", cursor.getInt(cursor.getColumnIndexOrThrow("cached")) == 1)
                .put("prompt_tokens", cursor.getInt(cursor.getColumnIndexOrThrow("prompt_tokens")))
                .put("completion_tokens", cursor.getInt(cursor.getColumnIndexOrThrow("completion_tokens")))
                .put("cost_usd", cursor.getDouble(cursor.getColumnIndexOrThrow("cost_usd")))
                .put("error", cursor.getString(cursor.getColumnIndexOrThrow("error")))
                .put("location", cursor.getString(cursor.getColumnIndexOrThrow("location")));
    }

    private static String statusLevel(int status) {
        if (status >= 500) {
            return "error";
        }
        return status >= 400 ? "warn" : "info";
    }

    private void streamLogs(Http.Req req, final Http.Res res) {
        res.beginStream("text/event-stream");
        final Events.Subscriber subscriber = new Events.Subscriber() {
            @Override
            public void onLog(JSONObject entry) {
                res.event("log", entry.toString());
            }
        };
        Events.subscribe(subscriber);

        workers.execute(new Runnable() {
            @Override
            public void run() {
                // hold the connection open with heartbeats until the client goes away
                for (int i = 0; i < 3000 && res.sent(); i++) {
                    try {
                        Thread.sleep(20000);
                        res.comment("keep-alive");
                    } catch (InterruptedException exc) {
                        return;
                    } catch (Exception exc) {
                        return;
                    }
                }
                Events.unsubscribe(subscriber);
                res.endStream();
            }
        });
    }

    private String exportCsv() {
        StringBuilder out = new StringBuilder(
                "ts,request_id,method,path,model,account,status,attempts,latency_ms,"
                        + "prompt_tokens,completion_tokens,cost_usd,error\n");
        android.database.Cursor cursor = store.getReadableDatabase().query("logs", null,
                null, null, null, null, "ts DESC", "5000");
        try {
            while (cursor.moveToNext()) {
                out.append(cursor.getDouble(cursor.getColumnIndexOrThrow("ts"))).append(',')
                        .append(cursor.getString(cursor.getColumnIndexOrThrow("request_id"))).append(',')
                        .append(cursor.getString(cursor.getColumnIndexOrThrow("method"))).append(',')
                        .append('"').append(cursor.getString(cursor.getColumnIndexOrThrow("path"))).append('"').append(',')
                        .append(cursor.getString(cursor.getColumnIndexOrThrow("model"))).append(',')
                        .append(cursor.getString(cursor.getColumnIndexOrThrow("account"))).append(',')
                        .append(cursor.getInt(cursor.getColumnIndexOrThrow("status"))).append(',')
                        .append(cursor.getInt(cursor.getColumnIndexOrThrow("attempts"))).append(',')
                        .append(cursor.getDouble(cursor.getColumnIndexOrThrow("latency_ms"))).append(',')
                        .append(cursor.getInt(cursor.getColumnIndexOrThrow("prompt_tokens"))).append(',')
                        .append(cursor.getInt(cursor.getColumnIndexOrThrow("completion_tokens"))).append(',')
                        .append(cursor.getDouble(cursor.getColumnIndexOrThrow("cost_usd"))).append(',')
                        .append('"').append(
                                String.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("error")))
                                        .replace("\"", "'")).append('"')
                        .append('\n');
            }
        } finally {
            cursor.close();
        }
        return out.toString();
    }

    private void keys(Http.Req req, Http.Res res) throws Exception {
        if ("GET".equals(req.method)) {
            res.json(200, store.keysJSON());
            return;
        }
        if ("POST".equals(req.method)) {
            JSONObject body = new JSONObject(req.bodyText());
            String name = body.optString("name");
            if (name.isEmpty()) {
                name = "key-" + System.currentTimeMillis();
            }
            String key = "sk-dash-" + randomToken(32);
            JSONObject record = new JSONObject()
                    .put("name", name)
                    .put("key", key)
                    .put("key_masked", store.maskKey(key))
                    .put("created_ts", System.currentTimeMillis() / 1000.0)
                    .put("last_used_ts", JSONObject.NULL)
                    .put("daily_usd", body.isNull("daily_usd") ? JSONObject.NULL
                            : body.optDouble("daily_usd"))
                    .put("rpm", body.isNull("rpm") ? JSONObject.NULL : body.optInt("rpm"))
                    .put("tpm", body.isNull("tpm") ? JSONObject.NULL : body.optInt("tpm"))
                    .put("models_allow", body.optJSONArray("models_allow"))
                    .put("models_deny", body.optJSONArray("models_deny"))
                    .put("enabled", true);
            store.createKey(record);
            res.status(201).json(201, record);
            return;
        }
        res.status(405).json(405, error("method not allowed", "invalid_request_error"));
    }

    private static String randomToken(int bytes) {
        byte[] buffer = new byte[bytes];
        new java.security.SecureRandom().nextBytes(buffer);
        return android.util.Base64.encodeToString(buffer,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
    }

    private void stats(Http.Res res) throws Exception {
        JSONObject circuits = new JSONObject();
        int total = 0;
        int enabled = 0;
        int healthy = 0;
        for (Account account : store.accounts()) {
            circuits.put(account.name, account.breaker.state());
            total++;
            if (account.enabled) {
                enabled++;
                if (!account.breaker.state().equals(Breaker.OPEN)) {
                    healthy++;
                }
            }
        }
        res.json(200, new JSONObject()
                .put("circuits", circuits)
                .put("health", new JSONObject()
                        .put("total", total).put("enabled", enabled).put("healthy", healthy)
                        .put("degraded", enabled > healthy))
                .put("affinity_sessions", router.affinitySize()));
    }

    private void config(Http.Req req, Http.Res res) throws Exception {
        if ("PUT".equals(req.method)) {
            res.json(200, configJson());
            return;
        }
        res.json(200, configJson());
    }

    private JSONObject configJson() throws Exception {
        return new JSONObject()
                .put("version", VERSION)
                .put("data_dir", context.getFilesDir().getAbsolutePath())
                .put("db", "sqlite")
                .put("encryption", "on-device keystore")
                .put("master_key_masked", store.maskKey(store.masterKey()))
                .put("server", new JSONObject()
                        .put("host", "127.0.0.1").put("port", port)
                        .put("request_timeout_s", 120).put("stream_timeout_s", 900))
                .put("limits", new JSONObject().put("max_body_bytes", 33554432).put("max_concurrency", 0))
                .put("cors", new JSONObject().put("origins", new JSONArray().put("*")))
                .put("features", new JSONObject()
                        .put("cache", true).put("retry", true).put("circuit_breaker", true)
                        .put("budget", true).put("active_probe", true)
                        .put("usage_accounting", true));
    }

    private void locations(Http.Res res) throws Exception {
        JSONObject out = new JSONObject();
        for (Account account : store.accounts()) {
            String location = account.location.isEmpty() ? "unassigned" : account.location;
            JSONArray list = out.optJSONArray(location);
            if (list == null) {
                list = new JSONArray();
                out.put(location, list);
            }
            list.put(account.name);
        }
        res.json(200, new JSONObject().put("locations", out));
    }

    private void cacheRoutes(Http.Req req, Http.Res res) throws Exception {
        if ("DELETE".equals(req.method)) {
            int cleared = cache.size();
            cache.clear();
            res.json(200, new JSONObject().put("cleared", cleared));
            return;
        }
        res.json(200, new JSONObject()
                .put("enabled", true).put("entries", cache.size()).put("max_entries", 2000)
                .put("ttl_seconds", 300).put("hits", cacheHits.get())
                .put("misses", cacheMisses.get()).put("hit_rate", round(hitRate()))
                .put("bytes", cache.bytes()).put("evictions", 0));
    }

    /**
     * Provider catalogue: name, brand mark, key shape and free-tier status for every
     * provider the proxy knows how to talk to.
     */
    private void providers(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() >= 3) {
            String id = Http.decode(parts.get(2));
            Providers.Info info = Providers.get(id);
            res.json(200, info.toJSON()
                    .put("free_models", new JSONArray(Providers.freeModelNames()))
                    .put("known", Providers.get("custom").id.equals(info.id) && !"custom".equals(id)));
            return;
        }
        res.json(200, new JSONObject()
                .put("providers", Providers.catalogueJSON())
                .put("free_models", new JSONArray(Providers.freeModelNames())));
    }

    /**
     * Identify a key: which provider issued it, what its logo and display name are, and
     * what that implies about the owning account.
     */
    private void identify(Http.Req req, Http.Res res) throws Exception {
        String key = req.param("key");
        if (key == null || key.isEmpty()) {
            JSONObject body = req.bodyText().isEmpty() ? new JSONObject()
                    : new JSONObject(req.bodyText());
            key = body.optString("api_key", body.optString("key"));
        }
        res.json(200, Providers.identify(key));
    }

    /** Egress pool management and the same-provider IP-spread report. */
    private void egress(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() >= 3 && "pool".equals(parts.get(2))) {
            if ("PUT".equals(req.method) || "POST".equals(req.method)) {
                String raw = req.bodyText().trim();
                JSONArray pool = null;
                if (raw.startsWith("[")) {
                    pool = new JSONArray(raw);
                } else if (raw.startsWith("{")) {
                    pool = new JSONObject(raw).optJSONArray("pool");
                }
                JSONArray out = new JSONArray();
                if (pool != null) {
                    for (int i = 0; i < pool.length(); i++) {
                        out.put(pool.optString(i));
                    }
                }
                store.egressPool(out);
                assignEgress();
            }
            JSONArray pool = store.egressPool();
            JSONArray described = new JSONArray();
            for (int i = 0; i < pool.length(); i++) {
                described.put(Egress.describe(pool.optString(i)));
            }
            res.json(200, new JSONObject().put("pool", described).put("size", pool.length()));
            return;
        }
        if (parts.size() >= 3 && "assign".equals(parts.get(2))) {
            assignEgress();
            res.json(200, egressReport());
            return;
        }
        res.json(200, egressReport());
    }

    private JSONObject egressReport() throws Exception {
        List<Account> accounts = store.accounts();
        List<String> pool = new ArrayList<String>();
        JSONArray stored = store.egressPool();
        for (int i = 0; i < stored.length(); i++) {
            pool.add(stored.optString(i));
        }
        Map<String, Egress.Exit> assignment = Egress.assign(accounts, pool, null);
        JSONArray exits = new JSONArray();
        for (Account account : accounts) {
            Egress.Exit exit = assignment.get(account.name);
            exits.put(new JSONObject()
                    .put("account", account.name)
                    .put("provider", account.providerType)
                    .put("egress", exit == null ? Egress.parse("direct").toJSON() : exit.toJSON()));
        }
        JSONObject spread = Egress.spread(accounts, assignment);
        return new JSONObject()
                .put("pool_size", pool.size())
                .put("assignments", exits)
                .put("spread", spread)
                .put("advice", spread.optBoolean("clean", false)
                        ? "every same-provider account leaves through a distinct exit"
                        : "some accounts of one provider still share an address — add more "
                        + "proxies to the pool so each key gets its own IP");
    }

    /** Push the stored pool onto the accounts and persist the result. */
    private void assignEgress() throws Exception {
        List<Account> accounts = store.accounts();
        List<String> pool = new ArrayList<String>();
        JSONArray stored = store.egressPool();
        for (int i = 0; i < stored.length(); i++) {
            pool.add(stored.optString(i));
        }
        Map<String, Egress.Exit> assignment = Egress.assign(accounts, pool, null);
        for (Account account : accounts) {
            Egress.Exit exit = assignment.get(account.name);
            if (exit != null && !exit.isDirect()) {
                account.egress = exit.scheme + "://" + exit.id;
                store.saveAccount(account);
            }
        }
    }

    /** Anti-ban settings and the current pacing/concurrency picture. */
    private void stealthRoutes(Http.Req req, Http.Res res) throws Exception {
        if ("PUT".equals(req.method) || "POST".equals(req.method)) {
            JSONObject patch = new JSONObject(req.bodyText());
            JSONObject routing = store.routing();
            JSONObject current = routing.optJSONObject("stealth");
            if (current == null) {
                current = defaultStealth();
            }
            merge(current, patch);
            routing.put("stealth", current);
            store.routing(routing);
        }
        JSONObject routing = store.routing();
        JSONObject config = routing.optJSONObject("stealth");
        JSONObject perAccount = new JSONObject();
        for (Account account : store.accounts()) {
            perAccount.put(account.name, new JSONObject()
                    .put("min_interval_ms", account.minIntervalMs)
                    .put("max_concurrency", account.maxConcurrency)
                    .put("jitter_ms", account.jitterMs)
                    .put("in_flight", stealth.inFlight(account.name))
                    .put("quota_hits", stealth.quotaHits(account.name)));
        }
        res.json(200, new JSONObject()
                .put("config", config == null ? defaultStealth() : config)
                .put("accounts", perAccount)
                .put("in_flight", stealth.snapshot()));
    }

    private static JSONObject defaultStealth() {
        try {
            return new JSONObject()
                    .put("enabled", true)
                    .put("min_interval_ms", 250)
                    .put("max_concurrency", 2)
                    .put("jitter_ms", 350)
                    .put("respect_retry_after", true)
                    .put("quarantine_quota", true);
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    /** Per-account quota state, with a manual clear so a key can be brought back early. */
    private void quota(Http.Req req, Http.Res res, List<String> parts) throws Exception {
        if (parts.size() >= 4 && "clear".equals(parts.get(2))) {
            String name = Http.decode(parts.get(3));
            Account account = store.account(name);
            if (account == null) {
                res.status(404).json(404, error("no account named '" + name + "'", "not_found"));
                return;
            }
            account.clearQuota();
            account.breaker.reset();
            stealth.clearEscalation(name);
            store.saveAccount(account);
            res.json(200, new JSONObject().put("cleared", name));
            return;
        }
        JSONArray out = new JSONArray();
        for (Account account : store.accounts()) {
            out.put(new JSONObject()
                    .put("name", account.name)
                    .put("provider", account.providerType)
                    .put("exhausted", account.quotaExhausted())
                    .put("resets_in_s", Math.max(0,
                            Math.round(account.quotaResetTs - System.currentTimeMillis() / 1000.0)))
                    .put("reason", account.quotaReason)
                    .put("hits", stealth.quotaHits(account.name)));
        }
        res.json(200, new JSONObject().put("quota", out));
    }

    private void healthCheck(final Http.Res res) throws Exception {
        JSONArray results = new JSONArray();
        for (final Account account : store.accounts()) {
            final JSONObject entry = new JSONObject().put("name", account.name);
            results.put(entry);
            workers.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        JSONObject probe = new JSONObject()
                                .put("max_tokens", 1)
                                .put("messages", new JSONArray().put(new JSONObject()
                                        .put("role", "user").put("content", "hi")));
                        String model = account.models.isEmpty() ? "gpt-4o" : account.models.get(0);
                        Proxy.Result result = Proxy.chat(account, probe, model, 20000);
                        entry.put("ok", result.status < 400).put("status", result.status)
                                .put("latency_ms", round(result.latencyMs));
                    } catch (Exception exc) {
                        try {
                            entry.put("ok", false).put("status", 0).put("latency_ms", 0);
                        } catch (Exception ignored) {
                            // the response is already queued without this result
                        }
                    }
                }
            });
        }
        Thread.sleep(1500);          // let the probes land before responding
        res.json(200, new JSONObject().put("results", results));
    }

    private void probe(Http.Res res) throws Exception {
        healthCheck(res);
    }

    // ------------------------------------------------------------------ static dashboard

    private void serveStatic(String path, Http.Res res) {
        String relative = path.length() > "/app".length() ? path.substring("/app/".length()) : "";
        if (relative.isEmpty() || relative.endsWith("/")) {
            relative = relative + "index.html";
        }
        if (relative.contains("..")) {
            res.status(400).text(400, "bad path");
            return;
        }
        String asset = "dashboard/" + relative;
        try {
            byte[] data = Http.readAsset(assets, asset);
            res.header("Cache-Control", "no-cache");
            res.bytes(200, data, mimeOf(relative));
        } catch (IOException exc) {
            // SPA deep link — serve the shell so the hash router can take over
            try {
                byte[] shell = Http.readAsset(assets, "dashboard/index.html");
                res.header("Cache-Control", "no-cache");
                res.bytes(200, shell, "text/html; charset=utf-8");
            } catch (IOException missing) {
                res.status(404).text(404, "dashboard assets are missing from the APK");
            }
        }
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".html")) {
            return "text/html; charset=utf-8";
        }
        if (name.endsWith(".js")) {
            return "text/javascript; charset=utf-8";
        }
        if (name.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (name.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (name.endsWith(".json")) {
            return "application/json; charset=utf-8";
        }
        if (name.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (name.endsWith(".png")) {
            return "image/png";
        }
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ helpers

    /** Prints an exception with its stack to logcat-visible stderr. */
    static final class StringWriterOut {
        static void print(Exception exc) {
            try {
                java.io.StringWriter writer = new java.io.StringWriter();
                exc.printStackTrace(new java.io.PrintWriter(writer));
                android.util.Log.e("aiproxy", "handler failed: " + writer);
            } catch (Exception ignored) {
                // never mask the original failure
            }
        }
    }

    static JSONObject error(String message, String type) {
        try {
            return new JSONObject().put("message", message).put("type", type).put("code", type);
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    static JSONObject errorEnvelope(String message, String type, String requestId) {
        try {
            return new JSONObject().put("error", new JSONObject()
                    .put("message", message)
                    .put("type", type)
                    .put("code", type)
                    .put("param", JSONObject.NULL)
                    .put("request_id", requestId));
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    static String requestId() {
        return Long.toHexString(System.nanoTime() & 0xffffffffL)
                + Long.toHexString(System.nanoTime() >> 16);
    }

    static int parseInt(String value, int fallback) {
        try {
            return value == null ? fallback : Integer.parseInt(value);
        } catch (NumberFormatException exc) {
            return fallback;
        }
    }

    static int clamp(int value, int low, int high) {
        return Math.max(low, Math.min(high, value));
    }

    /** Tiny TTL cache for deterministic completions. */
    static final class Cache {
        private final Map<String, Entry> entries = new LinkedHashMap<String, Entry>();
        private long bytes;

        private static final class Entry {
            final String value;
            final long expires;

            Entry(String value, long expires) {
                this.value = value;
                this.expires = expires;
            }
        }

        synchronized String get(String key) {
            Entry entry = entries.get(key);
            if (entry == null) {
                return null;
            }
            if (entry.expires < System.currentTimeMillis()) {
                entries.remove(key);
                bytes -= entry.value.length();
                return null;
            }
            return entry.value;
        }

        synchronized void put(String key, String value) {
            Entry existing = entries.get(key);
            if (existing != null) {
                bytes -= existing.value.length();
            }
            entries.put(key, new Entry(value, System.currentTimeMillis() + 300_000L));
            bytes += value.length();
            while (entries.size() > 500 || bytes > 8L * 1024 * 1024) {
                java.util.Iterator<Map.Entry<String, Entry>> it = entries.entrySet().iterator();
                if (!it.hasNext()) {
                    break;
                }
                bytes -= it.next().getValue().value.length();
                it.remove();
            }
        }

        synchronized int size() {
            return entries.size();
        }

        synchronized long bytes() {
            return Math.max(0, bytes);
        }

        synchronized void clear() {
            entries.clear();
            bytes = 0;
        }
    }
}