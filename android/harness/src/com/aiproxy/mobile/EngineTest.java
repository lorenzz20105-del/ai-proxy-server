package com.aiproxy.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * JVM harness for the on-device proxy engine.
 *
 * <p>Compiles the real app sources against stubbed Android APIs (sqlite-jdbc backs
 * SQLiteOpenHelper) and drives the whole server over HTTP: auth, admin CRUD, routing,
 * model aliases, cache, metrics, and OpenAI ⇄ Anthropic ⇄ Google translation for both
 * buffered and streamed responses.
 */
public final class EngineTest {

    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        startFakeUpstreams();

        Store store = Store.get(new android.content.Context());
        Server server = new Server(new android.content.Context());
        server.start();

        String base = "http://127.0.0.1:" + server.port();
        String key = store.masterKey();

        section("auth");
        expect(401, get(base + "/v1/models", null));
        expect(401, get(base + "/v1/models", "sk-wrong"));
        expect(200, get(base + "/v1/models", key));

        section("accounts CRUD");
        expect(201, post(base + "/admin/accounts", key, account("openai-local",
                "openai", "http://127.0.0.1:9911/v1", "gpt-4o,gpt-4o-mini")));
        expect(201, post(base + "/admin/accounts", key, account("claude-local",
                "anthropic", "http://127.0.0.1:9911/v1", "claude-sonnet-4-20250514")));
        expect(201, post(base + "/admin/accounts", key, account("gemini-local",
                "google", "http://127.0.0.1:9911/v1beta", "gemini-2.5-flash")));
        expect(409, post(base + "/admin/accounts", key, account("openai-local",
                "openai", "http://127.0.0.1:9911/v1", "gpt-4o")));

        JSONObject list = getJson(base + "/admin/accounts", key);
        check("three accounts listed", list.optJSONArray("accounts").length() == 3);
        check("api keys masked",
                !list.toString().contains("sk-secret") && list.toString().contains("api_key_masked"));
        check("proxy urls never leaked", !list.toString().contains("proxy_url"));

        section("models");
        JSONObject models = getJson(base + "/v1/models", key);
        JSONArray ids = models.getJSONArray("data");
        check("union of account models", ids.length() == 4);

        section("chat — openai upstream");
        JSONObject chat = chat(base, key, "gpt-4o", false);
        check("openai passthrough text",
                "openai says hi".equals(chat.optJSONArray("choices").getJSONObject(0)
                        .getJSONObject("message").optString("content")));
        check("usage forwarded", chat.optJSONObject("usage").optInt("total_tokens") == 16);
        check("account header routed", store.account("openai-local") != null);

        section("chat — anthropic upstream (OpenAI in, Messages out)");
        chat = chat(base, key, "claude-sonnet-4-20250514", false);
        check("claude text translated",
                "claude says hi".equals(chat.optJSONArray("choices").getJSONObject(0)
                        .getJSONObject("message").optString("content")));
        check("stop reason mapped",
                "stop".equals(chat.optJSONArray("choices").getJSONObject(0).optString("finish_reason")));
        check("token usage mapped", chat.optJSONObject("usage").optInt("prompt_tokens") == 8);

        section("chat — google upstream");
        chat = chat(base, key, "gemini-2.5-flash", false);
        check("gemini text translated",
                "gemini says hi".equals(chat.optJSONArray("choices").getJSONObject(0)
                        .getJSONObject("message").optString("content")));

        section("unknown model is 503");
        expect(503, post(base + "/v1/chat/completions", key,
                "{\"model\":\"gpt-9000\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}"));

        section("aliases — ordered fallback");
        put(base + "/admin/aliases/smart", key,
                "{\"targets\":[\"gemini-2.5-flash\",\"gpt-4o\"]}");
        chat = chat(base, key, "smart", false);
        check("alias resolved to first target",
                "gemini says hi".equals(chat.optJSONArray("choices").getJSONObject(0)
                        .getJSONObject("message").optString("content")));
        check("aliases listed",
                getJson(base + "/admin/aliases", key).optJSONObject("aliases")
                        .getJSONObject("smart").optJSONArray("targets").length() == 2);

        section("streaming — SSE translation");
        String sse = stream(base, key, "gpt-4o");
        check("openai stream has content", sse.contains("OpenAI "));
        check("exactly one [DONE]", count(sse, "data: [DONE]") == 1);
        check("finish_reason present", sse.contains("\"finish_reason\":\"stop\""));

        sse = stream(base, key, "claude-sonnet-4-20250514");
        check("anthropic stream deltas", sse.contains("Claude ") && sse.contains("streams"));
        check("anthropic stream one DONE", count(sse, "data: [DONE]") == 1);

        sse = stream(base, key, "gemini-2.5-flash");
        check("gemini stream deltas", sse.contains("Gem") && sse.contains("ini streams"));
        check("gemini stream one DONE", count(sse, "data: [DONE]") == 1);

        section("response cache");
        String cacheBody = "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"cache-me\"}],"
                + "\"temperature\":0}";
        String firstCall = postWithHeader(base + "/v1/chat/completions", key, cacheBody);
        check("first call is a miss", firstCall.contains("x-aiproxy-cache: MISS"));
        String cachedHeader = postWithHeader(base + "/v1/chat/completions", key, cacheBody);
        check("deterministic request cached", cachedHeader.contains("x-aiproxy-cache: HIT"));
        String uncached = postWithHeader(base + "/v1/chat/completions", key,
                "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"y\"}],"
                        + "\"temperature\":0.7}");
        check("sampled request bypasses cache",
                uncached.contains("x-aiproxy-cache: MISS"));

        section("routing config");
        JSONObject routing = getJson(base + "/admin/routing", key);
        check("strategy default", "round_robin".equals(routing.optString("strategy")));
        check("strategies advertised", routing.optJSONArray("strategies").length() == 8);
        put(base + "/admin/routing", key, "{\"strategy\":\"failover\","
                + "\"circuit_breaker\":{\"failure_threshold\":2,\"cooldown_seconds\":30}}");
        check("strategy persisted",
                "failover".equals(getJson(base + "/admin/routing", key).optString("strategy")));

        section("circuit breaker");
        // point claude at a dead port so every attempt fails
        put(base + "/admin/accounts/claude-local", key,
                "{\"base_url\":\"http://127.0.0.1:9/v1\"}");
        for (int i = 0; i < 4; i++) {
            post(base + "/v1/chat/completions", key,
                    "{\"model\":\"claude-sonnet-4-20250514\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}");
        }
        check("breaker tripped",
                Breaker.OPEN.equals(store.account("claude-local").breaker.state()));
        JSONObject stats = getJson(base + "/admin/stats", key);
        check("stats report the open circuit",
                "open".equals(stats.optJSONObject("circuits").optString("claude-local")));
        expect(200, post(base + "/admin/accounts/claude-local/reset", key, "{}"));
        check("manual reset closes it",
                Breaker.CLOSED.equals(store.account("claude-local").breaker.state()));

        section("usage, logs and metrics");
        JSONObject usage = getJson(base + "/admin/usage?range=24h", key);
        check("requests counted", usage.optJSONObject("totals").optInt("requests") > 0);
        check("tokens counted",
                usage.optJSONObject("totals").optInt("tokens_in") > 0);
        check("cost computed", usage.optJSONObject("totals").optDouble("cost_usd") > 0);
        check("by_model populated", usage.optJSONArray("by_model").length() >= 3);
        check("by_account populated", usage.optJSONArray("by_account").length() >= 2);

        JSONObject logs = getJson(base + "/admin/logs?limit=20", key);
        check("log rows returned", logs.optJSONArray("logs").length() > 0);
        check("log has account attribution",
                logs.optJSONArray("logs").getJSONObject(0).has("account"));

        String prometheus = requestWithHeaders(base + "/metrics", "GET", null, null).body;
        check("prometheus counters", prometheus.contains("aiproxy_requests_total")
                && prometheus.contains("aiproxy_account_cost_usd_total"));

        section("keys");
        JSONObject created = postJson(base + "/admin/keys", key,
                "{\"name\":\"laptop\",\"daily_usd\":1.0}");
        String issued = created.optString("key");
        check("key issued once in full", issued.startsWith("sk-dash-") && issued.length() > 20);
        expect(200, get(base + "/v1/models", issued));
        check("issued key listed masked",
                getJson(base + "/admin/keys", key).toString().contains("laptop"));
        check("full key never re-listed",
                !getJson(base + "/admin/keys", key).toString().contains(issued));

        section("budget + config + misc");
        put(base + "/admin/budget", key, "{\"daily_usd\":25,\"hard_stop\":true}");
        JSONObject budget = getJson(base + "/admin/budget", key);
        check("daily cap stored", budget.optJSONObject("global").optDouble("daily_usd") == 25.0);
        check("spent tracked", budget.optJSONObject("global").optDouble("spent_today_usd") > 0);
        check("remaining computed",
                budget.optJSONObject("global").optDouble("remaining_today_usd") < 25.0);
        check("config reports the port",
                getJson(base + "/admin/config", key).optJSONObject("server")
                        .optInt("port") == server.port());
        check("locations grouped",
                getJson(base + "/admin/locations", key).has("locations"));
        check("cache status", getJson(base + "/admin/cache", key).optInt("entries") >= 0);
        check("health reports accounts",
                new JSONObject(requestWithHeaders(base + "/health", "GET", null, null).body).optJSONObject("accounts").optInt("total") == 3);
        expect(200, get(base + "/ready", key));
        check("export csv produced",
                requestWithHeaders(base + "/admin/export.csv", "GET", key, null).body.startsWith("ts,"));

        section("account probe + delete");
        JSONObject probe = postJson(base + "/admin/accounts/openai-local/test", key, "{}");
        check("probe succeeded", probe.optBoolean("ok"));
        expect(200, request(base + "/admin/accounts/openai-local", "DELETE", key, null));
        check("account removed",
                getJson(base + "/admin/accounts", key).optJSONArray("accounts").length() == 2);

        section("providers — identity, logos, free models");
        JSONObject catalogue = getJson(base + "/admin/providers", key);
        check("provider catalogue populated",
                catalogue.optJSONArray("providers").length() >= 15);
        JSONObject openaiMeta = null;
        JSONArray prov = catalogue.optJSONArray("providers");
        for (int i = 0; i < prov.length(); i++) {
            if ("openai".equals(prov.getJSONObject(i).optString("id"))) {
                openaiMeta = prov.getJSONObject(i);
            }
        }
        check("openai present with a name", openaiMeta != null
                && "OpenAI".equals(openaiMeta.optString("name")));
        check("provider ships an inline logo", openaiMeta != null
                && openaiMeta.optString("logo").startsWith("<svg"));

        JSONObject openaiKey = new JSONObject(requestWithHeaders(base + "/admin/identify", "POST",
                key, "{\"api_key\":\"sk-proj-abcdefghij1234567890\"}").body);
        check("openai key detected", "openai".equals(openaiKey.optString("id")));
        check("openai key naming OpenAI", "OpenAI".equals(openaiKey.optString("name")));
        check("openai key carries a logo",
                openaiKey.optString("logo").startsWith("<svg"));
        check("openai key confidence exact",
                "exact".equals(openaiKey.optString("confidence")));
        check("openai key is masked, never full", !openaiKey.toString().contains("abcdefghij1234567890"));

        JSONObject anthropicKey = new JSONObject(requestWithHeaders(base + "/admin/identify",
                "POST", key, "{\"api_key\":\"sk-ant-api03-abcdefghij1234567890\"}").body);
        check("anthropic key detected", "anthropic".equals(anthropicKey.optString("id")));
        check("anthropic shows account guidance",
                anthropicKey.optString("account_hint").contains("console.anthropic.com"));

        // AIza + exactly 35 characters, the real Google key shape
        String googleKey = "AIza" + "0123456789abcdefghijklmnopqrstuvwxy";
        JSONObject googleIdent = new JSONObject(requestWithHeaders(base + "/admin/identify",
                "POST", key, "{\"api_key\":\"" + googleKey + "\"}").body);
        check("google key detected", "google".equals(googleIdent.optString("id")));
        check("google logo present", googleIdent.optString("logo").startsWith("<svg"));

        JSONObject groqKey = new JSONObject(requestWithHeaders(base + "/admin/identify",
                "POST", key, "{\"api_key\":\"gsk_abcdefghijklmnopqrstuvwxyz0123456789abcd\"}").body);
        check("groq key detected", "groq".equals(groqKey.optString("id")));

        check("free model recognised", Providers.isFreeModel("llama-3.3-70b-versatile"));
        check("free suffix recognised", Providers.isFreeModel("some-model:free"));
        check("paid model rejected", !Providers.isFreeModel("gpt-4o"));
        check("claude rejected as paid", !Providers.isFreeModel("claude-sonnet-4-20250514"));
        check("gpt-4o classified as openai",
                "openai".equals(Providers.providerOfModel("gpt-4o")));

        // Two keys on one provider: the first one is already out of quota upstream,
        // the second is healthy. Both serve gpt-4o, so a shared model can fail over.
        section("same provider, two keys, quota exhausted");
        expect(201, post(base + "/admin/accounts", key, account("openai-quota",
                "openai", "http://127.0.0.1:9911/v1", "gpt-4o,gpt-4o-2024-08-06")));
        expect(201, post(base + "/admin/accounts", key, account("openai-ok",
                "openai", "http://127.0.0.1:9911/v1", "gpt-4o,llama-3.3-70b-versatile")));
        put(base + "/admin/accounts/openai-quota", key, "{\"api_key\":\"sk-quota-aaaa\",\"priority\":1}");
        put(base + "/admin/accounts/openai-ok", key, "{\"api_key\":\"sk-ok-bbbb\",\"priority\":2}");
        put(base + "/admin/routing", key, "{\"strategy\":\"failover\"}");

        section("free-only routing");
        put(base + "/admin/routing", key, "{\"models\":{\"free_only\":true}}");
        expect(402, post(base + "/v1/chat/completions", key,
                "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"temperature\":1.5}"));
        JSONObject freeChat = chat(base, key, "llama-3.3-70b-versatile", false);
        check("free model still served",
                freeChat.optJSONArray("choices").getJSONObject(0).getJSONObject("message")
                        .optString("content").length() > 0);
        put(base + "/admin/routing", key, "{\"models\":{\"free_only\":false}}");

        // only the quota key serves this model: nothing left to fall over to -> 429
        Response restricted = requestWithHeaders(
                base + "/v1/chat/completions", "POST", key,
                "{\"model\":\"gpt-4o-2024-08-06\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"temperature\":1.5}");
        expect(429, restricted.status);
        check("quota 429 advertises a wait", restricted.headers.contains("Retry-After:"));
        check("quota 429 sets the quota header",
                restricted.headers.contains("x-aiproxy-quota-exhausted: true"));
        check("quota 429 is typed for clients", restricted.body.contains("quota_exhausted"));
        JSONObject quotaState = getJson(base + "/admin/quota", key);
        boolean quotaParked = false;
        JSONArray quotaRows = quotaState.optJSONArray("quota");
        for (int i = 0; i < quotaRows.length(); i++) {
            JSONObject row = quotaRows.getJSONObject(i);
            if ("openai-quota".equals(row.optString("name")) && row.optBoolean("exhausted")) {
                quotaParked = true;
                check("parked account reports a reset window", row.optInt("resets_in_s") > 0);
                check("parked account explains why",
                        row.optString("reason").toLowerCase(java.util.Locale.US).contains("quota"));
            }
        }
        check("quota-exhausted account is parked", quotaParked);

        // The shared model still works: the exhausted key is skipped and the healthy
        // key on the same provider answers instead.
        JSONObject fallback = chat(base, key, "gpt-4o", false);
        check("request succeeds via the second key",
                "openai says hi".equals(fallback.optJSONArray("choices").getJSONObject(0)
                        .getJSONObject("message").optString("content")));
        quotaState = getJson(base + "/admin/quota", key);
        quotaRows = quotaState.optJSONArray("quota");
        boolean stillParked = false;
        for (int i = 0; i < quotaRows.length(); i++) {
            if ("openai-quota".equals(quotaRows.getJSONObject(i).optString("name"))
                    && quotaRows.getJSONObject(i).optBoolean("exhausted")) {
                stillParked = true;
            }
        }
        check("exhausted key stays parked while the other serves",
                stillParked);

        // A model only the parked key has: nothing left to fall back to, so the caller
        // is told the real reason rather than a generic upstream failure.
        expect(429, post(base + "/v1/chat/completions", key,
                "{\"model\":\"gpt-4o-2024-08-06\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"temperature\":1.5}"));

        // clearing the quarantine brings the key back
        expect(200, post(base + "/admin/quota/clear/openai-quota", key, "{}"));
        quotaState = getJson(base + "/admin/quota", key);
        quotaRows = quotaState.optJSONArray("quota");
        boolean cleared = false;
        for (int i = 0; i < quotaRows.length(); i++) {
            JSONObject row = quotaRows.getJSONObject(i);
            if ("openai-quota".equals(row.optString("name")) && !row.optBoolean("exhausted")) {
                cleared = true;
            }
        }
        check("quota cleared on request", cleared);

        section("stealth — anti-ban pacing and concurrency");
        JSONObject stealth = getJson(base + "/admin/stealth", key);
        check("stealth config served", stealth.optJSONObject("config") != null);
        check("stealth enabled by default", stealth.optJSONObject("config").optBoolean("enabled"));
        put(base + "/admin/stealth", key,
                "{\"min_interval_ms\":400,\"jitter_ms\":120,\"max_concurrency\":1}");
        check("stealth config persisted",
                getJson(base + "/admin/stealth", key).optJSONObject("config")
                        .optInt("min_interval_ms") == 400);

        Account paced = store.account("openai-ok");
        paced.minIntervalMs = 60000;
        paced.maxConcurrency = 1;
        Stealth engine = new Stealth();
        check("first call is clear", engine.check(paced, null).allowed());
        engine.enter(paced);
        check("cadence gate closes after a request", !engine.check(paced, null).allowed());
        check("concurrency ceiling holds",
                engine.check(paced, new org.json.JSONObject().put("min_interval_ms", 0)
                        .put("max_concurrency", 1)).reason == 2);
        engine.leave(paced);
        check("slot released on leave",
                engine.check(paced, new org.json.JSONObject().put("min_interval_ms", 0))
                        .allowed());
        paced.minIntervalMs = 0;
        paced.maxConcurrency = 2;

        check("quota wording detected",
                Stealth.interpret(400, "insufficient_quota: you exceeded your current quota").quotaExhausted);
        check("billing wording detected",
                Stealth.interpret(402, "out of credits").quotaExhausted);
        check("usage wording detected",
                Stealth.interpret(429, "free tier daily limit reached").quotaExhausted);
        check("auth failure counts as account problem",
                Stealth.interpret(401, "Incorrect API key provided").accountProblem);
        check("ordinary 500 is not a quota event",
                !Stealth.interpret(500, "internal error").quotaExhausted);
        check("retry-after parsed from prose",
                Stealth.parseRetryAfter("please retry after 120 seconds") == 120_000);
        check("bare retry-after is seconds",
                Stealth.parseRetryAfter("30") == 30_000);
        check("escalation lengthens the quarantine",
                engine.escalate("acct", 1000) == 1000
                        && engine.escalate("acct", 1000) == 2000);
        engine.clearEscalation("acct");
        check("escalation reset", engine.escalate("acct", 1000) == 1000);

        section("egress — same provider must not share an IP");
        JSONArray pool = new JSONArray();
        for (int i = 1; i <= 5; i++) {
            pool.put("http://user:proxysecret" + i + "@10.0.0." + i + ":8080");
        }
        put(base + "/admin/egress/pool", key, pool.toString());
        check("pool stored", getJson(base + "/admin/egress", key).optInt("pool_size") == 5);

        final String spotBase = "http://127.0.0.1:9912/v1";
        expect(201, post(base + "/admin/accounts", key, account("spot-a",
                "openai", spotBase, "gpt-4o")));
        expect(201, post(base + "/admin/accounts", key, account("spot-b",
                "openai", spotBase, "gpt-4o")));
        expect(201, post(base + "/admin/accounts", key, account("spot-c",
                "openai", spotBase, "gpt-4o")));
        expect(201, post(base + "/admin/accounts", key, account("spot-d",
                "openai", spotBase, "gpt-4o")));
        expect(201, post(base + "/admin/accounts", key, account("spot-e",
                "openai", spotBase, "gpt-4o")));

        JSONObject report = getJson(base + "/admin/egress", key);
        check("same-provider accounts get distinct exits",
                report.optJSONObject("spread").optBoolean("clean"));
        check("spread score is 1.0 when clean",
                report.optJSONObject("spread").optDouble("score") == 1.0);
        check("proxy password never leaks", !report.toString().contains("proxysecret"));
        JSONArray assignments = report.optJSONArray("assignments");
        java.util.Set<String> seen = new java.util.HashSet<String>();
        int spotExits = 0;
        for (int i = 0; i < assignments.length(); i++) {
            JSONObject row = assignments.getJSONObject(i);
            if (row.optString("account").startsWith("spot-")) {
                spotExits++;
                seen.add(row.optJSONObject("egress").optString("id"));
            }
        }
        check("all five spot accounts assigned", spotExits == 5);
        check("all five leave through different addresses", seen.size() == 5);
        check("group collisions reported", report.optJSONObject("spread").has("groups"));

        expect(200, post(base + "/admin/egress/assign", key, "{}"));
        check("assignment persisted to accounts",
                !store.account("spot-a").egress.isEmpty()
                        && !store.account("spot-a").egress.equals(store.account("spot-b").egress));
        // restore direct egress so later traffic is not routed to a fake proxy
        for (String name : new String[]{"spot-a", "spot-b", "spot-c", "spot-d", "spot-e"}) {
            put(base + "/admin/accounts/" + name, key, "{\"egress\":\"\"}");
        }
        put(base + "/admin/egress/pool", key, "{\"pool\":[]}");

        section("desktop identity");
        Fingerprint.Profile win = Fingerprint.profile("win11");
        check("windows profile has a real chrome UA",
                win.userAgent().contains("Chrome/") && win.userAgent().contains("Windows NT"));
        Fingerprint.Profile mac = Fingerprint.profile("mac14");
        check("mac profile has a matching UA",
                mac.userAgent().contains("Macintosh") && mac.userAgent().contains("Mac OS X"));
        check("identities differ per platform", !win.userAgent().equals(mac.userAgent()));
        check("accept-language matches the locale",
                win.acceptLanguage.startsWith("en-US"));
        java.util.Map<String, String> headers = Fingerprint.xhrHeaders(win);
        check("xhr headers carry client hints", headers.containsKey("sec-ch-ua"));
        check("xhr headers carry fetch metadata", headers.containsKey("Sec-Fetch-Mode"));
        check("xhr headers mark a browser origin", headers.containsKey("Origin"));
        check("profile pinned per account",
                store.account("spot-a").identityProfile() != null);
        check("describe exposes the active UA",
                Fingerprint.describe(win).optString("user_agent").contains("Chrome"));

        section("unit: pricing + breaker + request translation");
        check("gpt-4o pricing", Math.abs(Pricing.cost("gpt-4o", 1_000_000, 0) - 2.50) < 0.001);
        check("claude pricing", Math.abs(Pricing.cost("claude-sonnet-4-20250514",
                1_000_000, 1_000_000) - 18.00) < 0.001);
        check("bedrock prefix normalisation",
                Math.abs(Pricing.cost("anthropic.claude-3-5-haiku-20241022-v2:0",
                        1_000_000, 0) - 0.80) < 0.001);
        check("unknown model costs nothing", Pricing.cost("totally-unknown", 1000, 1000) == 0);

        Breaker breaker = new Breaker();
        breaker.configure(new JSONObject().put("failure_threshold", 3)
                .put("success_threshold", 2).put("cooldown_seconds", 3600));
        check("breaker starts closed", Breaker.CLOSED.equals(breaker.state()));
        check("closed breaker admits traffic", breaker.allow());
        breaker.onFailure(1, "x");
        check("below threshold stays closed", Breaker.CLOSED.equals(breaker.state()));
        breaker.onFailure(1, "x");
        check("still closed at two failures", Breaker.CLOSED.equals(breaker.state()));
        breaker.onFailure(1, "x");
        check("threshold trips the breaker", Breaker.OPEN.equals(breaker.state()));
        check("open breaker refuses traffic", !breaker.allow());
        breaker.allow(); breaker.onClientError();
        check("client error does not trip", Breaker.OPEN.equals(breaker.state()));

        Breaker halfOpen = new Breaker();
        halfOpen.configure(new JSONObject().put("failure_threshold", 2)
                .put("success_threshold", 2).put("cooldown_seconds", 0));
        halfOpen.allow(); halfOpen.onFailure(1, "x");
        halfOpen.allow(); halfOpen.onFailure(1, "x");
        check("half-open after cooldown", Breaker.HALF_OPEN.equals(halfOpen.state()));
        halfOpen.allow(); halfOpen.onSuccess(5);
        check("one success not enough", Breaker.HALF_OPEN.equals(halfOpen.state()));
        halfOpen.allow(); halfOpen.onSuccess(5);
        check("two successes close it", Breaker.CLOSED.equals(halfOpen.state()));

        JSONObject oaRequest = new JSONObject()
                .put("messages", new JSONArray()
                        .put(new JSONObject().put("role", "system").put("content", "be brief"))
                        .put(new JSONObject().put("role", "user").put("content", "hi")))
                .put("max_tokens", 64);
        JSONObject anthropic = Proxy.openAIToAnthropic(oaRequest, "claude-x", false);
        check("system extracted to top level", "be brief".equals(anthropic.optString("system")));
        check("max_tokens forwarded", anthropic.optInt("max_tokens") == 64);
        check("user message kept", anthropic.optJSONArray("messages").length() == 1);

        JSONObject google = Proxy.openAIToGoogle(oaRequest, "gemini-x", false);
        check("systemInstruction built",
                "be brief".equals(google.getJSONObject("systemInstruction")
                        .getJSONArray("parts").getJSONObject(0).optString("text")));
        check("contents role mapped",
                "user".equals(google.getJSONArray("contents").getJSONObject(0).optString("role")));

        check("multipart content flattened",
                "hello world".equals(Proxy.flatten(new JSONArray()
                        .put(new JSONObject().put("type", "text").put("text", "hello"))
                        .put(new JSONObject().put("type", "text").put("text", "world")))));

        server.stop();
        report();
    }

    // ------------------------------------------------------------------ fake upstream

    private static void startFakeUpstreams() throws Exception {
        final ServerSocket socket = new ServerSocket(9911);
        Thread thread = new Thread(() -> {
            while (true) {
                try {
                    Socket client = socket.accept();
                    new Thread(() -> handleUpstream(client)).start();
                } catch (IOException e) {
                    return;
                }
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    private static void handleUpstream(Socket client) {
        try {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), "UTF-8"));
            String requestLine = in.readLine();
            String line;
            int length = 0;
            String auth = "";
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    length = Integer.parseInt(line.split(":")[1].trim());
                } else if (line.toLowerCase().startsWith("authorization:")) {
                    auth = line;
                }
            }
            StringBuilder body = new StringBuilder();
            for (int i = 0; i < length; i++) {
                body.append((char) in.read());
            }
            String path = requestLine.split(" ")[1];
            boolean stream = body.toString().contains("\"stream\":true");
            String payload;
            String contentType;
            int httpStatus = 200;

            if (auth.contains("sk-quota")) {
                // A key whose provider account has run out of budget.
                contentType = "application/json";
                httpStatus = 400;
                payload = "{\"error\":{\"type\":\"insufficient_quota\","
                        + "\"code\":\"insufficient_quota\","
                        + "\"message\":\"You exceeded your current quota, please check your "
                        + "plan and billing details. retry after 120 seconds\"}}";
            } else if (path.contains(":streamGenerateContent")) {
                contentType = "text/event-stream";
                payload = sse("",
                        "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gem\"}]}}]}") +
                        sse("", "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ini streams\"}]},"
                                + "\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":9,"
                                + "\"candidatesTokenCount\":3,\"totalTokenCount\":12}}");
            } else if (path.endsWith("/messages") && stream) {
                contentType = "text/event-stream";
                payload = sse("message_start",
                        "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_s\",\"model\":\"c\","
                                + "\"usage\":{\"input_tokens\":13,\"output_tokens\":1}}}") +
                        sse("content_block_delta", "{\"type\":\"content_block_delta\","
                                + "\"delta\":{\"type\":\"text_delta\",\"text\":\"Claude \"}}") +
                        sse("content_block_delta", "{\"type\":\"content_block_delta\","
                                + "\"delta\":{\"type\":\"text_delta\",\"text\":\"streams\"}}") +
                        sse("message_delta", "{\"type\":\"message_delta\","
                                + "\"delta\":{\"stop_reason\":\"end_turn\"},"
                                + "\"usage\":{\"output_tokens\":6}}") +
                        sse("message_stop", "{\"type\":\"message_stop\"}");
            } else if (path.endsWith("/messages")) {
                contentType = "application/json";
                payload = "{\"id\":\"msg_live\",\"type\":\"message\",\"role\":\"assistant\","
                        + "\"model\":\"claude\",\"content\":[{\"type\":\"text\",\"text\":\"claude says hi\"}],"
                        + "\"stop_reason\":\"end_turn\","
                        + "\"usage\":{\"input_tokens\":8,\"output_tokens\":4}}";
            } else if (path.contains(":generateContent")) {
                contentType = "application/json";
                payload = "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini says hi\"}]},"
                        + "\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":7,"
                        + "\"candidatesTokenCount\":3,\"totalTokenCount\":10}}";
            } else if (stream) {
                contentType = "text/event-stream";
                payload = sse("", "{\"id\":\"1\",\"object\":\"chat.completion.chunk\","
                        + "\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\","
                        + "\"content\":\"OpenAI \"},\"finish_reason\":null}]}") +
                        sse("", "{\"id\":\"1\",\"object\":\"chat.completion.chunk\","
                                + "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"streams\"},"
                                + "\"finish_reason\":null}]}") +
                        sse("", "{\"id\":\"1\",\"object\":\"chat.completion.chunk\","
                                + "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],"
                                + "\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":4,"
                                + "\"total_tokens\":25}}");
            } else {
                contentType = "application/json";
                payload = "{\"id\":\"chatcmpl-live\",\"object\":\"chat.completion\","
                        + "\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\","
                        + "\"content\":\"openai says hi\"},\"finish_reason\":\"stop\"}],"
                        + "\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":5,\"total_tokens\":16}}";
            }

            OutputStream out = client.getOutputStream();
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 " + httpStatus + " " + reason(httpStatus)
                    + "\r\nContent-Type: " + contentType + "\r\nContent-Length: "
                    + bytes.length + "\r\nConnection: close\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
            client.close();
        } catch (Exception ignored) {
            // fake upstream: a dropped socket is not interesting
        }
    }

    private static String reason(int status) {
        if (status == 400) return "Bad Request";
        if (status == 401) return "Unauthorized";
        if (status == 402) return "Payment Required";
        if (status == 429) return "Too Many Requests";
        if (status == 500) return "Internal Server Error";
        return "OK";
    }

    private static String sse(String event, String data) {
        return (event.isEmpty() ? "" : "event: " + event + "\n") + "data: " + data + "\n\n";
    }

    // ------------------------------------------------------------------ http helpers

    private static String account(String name, String type, String baseUrl, String models)
            throws Exception {
        return new JSONObject()
                .put("name", name)
                .put("provider_type", type)
                .put("base_url", baseUrl)
                .put("api_key", "sk-secret-" + name)
                .put("models", new JSONArray(List.of(models.split(","))))
                .put("priority", name.equals("openai-local") ? 1 : 2)
                .toString();
    }

    private static int get(String url, String key) throws Exception {
        return request(url, "GET", key, null);
    }

    private static int post(String url, String key, String body) throws Exception {
        return request(url, "POST", key, body);
    }

    private static int put(String url, String key, String body) throws Exception {
        return request(url, "PUT", key, body);
    }

    private static JSONObject getJson(String url, String key) throws Exception {
        return new JSONObject(requestWithHeaders(url, "GET", key, null).body);
    }

    private static JSONObject postJson(String url, String key, String body) throws Exception {
        return new JSONObject(requestWithHeaders(url, "POST", key, body).body);
    }

    private static int request(String url, String method, String key, String body)
            throws Exception {
        return requestWithHeaders(url, method, key, body).status;
    }

    private static final class Response {
        int status;
        String body;
        String headers;
    }

    private static Response requestWithHeaders(String url, String method, String key, String body)
            throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(30000);
        if (key != null) {
            connection.setRequestProperty("x-api-key", key);
        }
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.getOutputStream().write(payload);
        }
        Response response = new Response();
        response.status = connection.getResponseCode();
        StringBuilder headers = new StringBuilder();
        for (java.util.Map.Entry<String, java.util.List<String>> e
                : connection.getHeaderFields().entrySet()) {
            headers.append(e.getKey()).append(": ").append(e.getValue().get(0)).append('\n');
        }
        response.headers = headers.toString();
        java.io.InputStream stream = response.status >= 400
                ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder text = new StringBuilder();
        if (stream != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) {
                text.append(line).append('\n');
            }
        }
        response.body = text.toString();
        connection.disconnect();
        return response;
    }

    private static String postWithHeader(String url, String key, String body) throws Exception {
        return requestWithHeaders(url, "POST", key, body).headers;
    }

    private static JSONObject chat(String base, String key, String model, boolean stream)
            throws Exception {
        return postJson(base + "/v1/chat/completions", key,
                "{\"model\":\"" + model + "\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],"
                        + "\"stream\":" + stream + ",\"temperature\":1.5}");
    }

    private static String stream(String base, String key, String model) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(
                base + "/v1/chat/completions").openConnection();
        connection.setRequestMethod("POST");
        connection.setRequestProperty("x-api-key", key);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(30000);
        connection.setDoOutput(true);
        byte[] payload = ("{\"model\":\"" + model + "\",\"messages\":[{\"role\":\"user\","
                + "\"content\":\"hi\"}],\"stream\":true}").getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        connection.getOutputStream().write(payload);
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), "UTF-8"));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            out.append(line).append('\n');
        }
        connection.disconnect();
        return out.toString();
    }

    private static int count(String haystack, String needle) {
        int total = 0;
        int at = haystack.indexOf(needle);
        while (at >= 0) {
            total++;
            at = haystack.indexOf(needle, at + needle.length());
        }
        return total;
    }

    // ------------------------------------------------------------------ assertions

    private static void section(String name) {
        System.out.println("\n[1m── " + name + "[0m");
    }

    private static void expect(int want, int got) {
        check("expected HTTP " + want + ", got " + got, want == got);
    }

    private static void check(String label, boolean ok) {
        if (ok) {
            passed++;
            System.out.println("  [32mPASS[0m " + label);
        } else {
            failures.add(label);
            System.out.println("  [31mFAIL[0m " + label);
        }
    }

    private static void report() {
        System.out.println("\n" + "=".repeat(60));
        System.out.println(passed + " passed, " + failures.size() + " failed");
        for (String failure : failures) {
            System.out.println("  FAILED: " + failure);
        }
        System.exit(failures.isEmpty() ? 0 : 1);
    }
}