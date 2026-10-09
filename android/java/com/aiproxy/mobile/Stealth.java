package com.aiproxy.mobile;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;

/**
 * Account-preservation layer: pacing, concurrency ceilings and quota interpretation.
 *
 * <p>Most account bans are not caused by a single request but by a shape: a burst far
 * above a human cadence, several requests in flight on one key, perfectly even gaps, or a
 * retry storm against an account that just said "quota exceeded". This class removes each
 * of those shapes.
 *
 * <ul>
 *   <li><b>Pacing</b> — a minimum interval between requests per account, with jitter so
 *       the resulting gaps are not a metronome.</li>
 *   <li><b>Concurrency</b> — a hard ceiling on in-flight requests per account.</li>
 *   <li><b>Quota quarantine</b> — a 429/quota response parks the account until the
 *       provider's own reset window, instead of hammering it.</li>
 *   <li><b>Retry-after</b> — when the provider states a wait, that wait is obeyed.</li>
 * </ul>
 */
public final class Stealth {

    private final Random random = new Random();
    private final Map<String, Long> lastRequestAt = new LinkedHashMap<String, Long>();
    private final Map<String, Integer> inFlight = new LinkedHashMap<String, Integer>();
    private final Map<String, Integer> consecutiveQuotaHits = new LinkedHashMap<String, Integer>();

    public static final class Pacing {
        public final long waitMs;
        public final int reason;         // 0 = clear, 1 = interval, 2 = concurrency

        Pacing(long waitMs, int reason) {
            this.waitMs = waitMs;
            this.reason = reason;
        }

        public boolean allowed() {
            return reason == 0;
        }

        public String describe() {
            switch (reason) {
                case 1:
                    return "pacing: waiting " + waitMs + "ms to keep this account's cadence human";
                case 2:
                    return "concurrency: " + waitMs + " requests already in flight on this account";
                default:
                    return "clear";
            }
        }
    }

    /** May this account be called right now? */
    public synchronized Pacing check(Account account, JSONObject stealthConfig) {
        int maxConcurrency = account.maxConcurrency;
        long minInterval = (long) account.minIntervalMs;
        boolean enabled = true;
        double jitter = account.jitterMs;

        if (stealthConfig != null) {
            enabled = stealthConfig.optBoolean("enabled", true);
            maxConcurrency = stealthConfig.optInt("max_concurrency", maxConcurrency);
            minInterval = (long) stealthConfig.optDouble("min_interval_ms", minInterval);
            jitter = stealthConfig.optDouble("jitter_ms", jitter);
        }
        if (!enabled) {
            return new Pacing(0, 0);
        }

        Integer active = inFlight.get(account.name);
        if (active != null && maxConcurrency > 0 && active >= maxConcurrency) {
            return new Pacing(active, 2);
        }

        Long last = lastRequestAt.get(account.name);
        if (last != null && minInterval > 0) {
            long elapsed = System.currentTimeMillis() - last;
            long required = minInterval + (jitter > 0 ? (long) (random.nextDouble() * jitter) : 0);
            if (elapsed < required) {
                return new Pacing(required - elapsed, 1);
            }
        }
        return new Pacing(0, 0);
    }

    /** Reserve a slot; call before dispatching. */
    public synchronized void enter(Account account) {
        lastRequestAt.put(account.name, System.currentTimeMillis());
        Integer active = inFlight.get(account.name);
        inFlight.put(account.name, active == null ? 1 : active + 1);
        account.breaker.allow();
    }

    /** Release a slot; call from a finally block. */
    public synchronized void leave(Account account) {
        Integer active = inFlight.get(account.name);
        if (active == null) {
            return;
        }
        if (active <= 1) {
            inFlight.remove(account.name);
        } else {
            inFlight.put(account.name, active - 1);
        }
    }

    /** Block until the pacing gate opens, or give up after a bounded wait. */
    public boolean awaitTurn(Account account, JSONObject stealthConfig, long maxWaitMs)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxWaitMs;
        while (System.currentTimeMillis() < deadline) {
            Pacing pacing = check(account, stealthConfig);
            if (pacing.allowed()) {
                return true;
            }
            long sleep = Math.max(5, Math.min(pacing.waitMs, 250));
            Thread.sleep(sleep);
        }
        return false;
    }

    public synchronized int inFlight(String account) {
        Integer active = inFlight.get(account);
        return active == null ? 0 : active;
    }

    public synchronized JSONObject snapshot() {
        try {
            JSONObject out = new JSONObject();
            for (Map.Entry<String, Integer> entry : inFlight.entrySet()) {
                out.put(entry.getKey(), entry.getValue());
            }
            return new JSONObject().put("in_flight", out);
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    // ------------------------------------------------------------------ quota reading

    /** What an upstream error means for the account's future, not just this request. */
    public static final class Verdict {
        public final boolean quotaExhausted;
        public final long retryAfterMs;
        public final boolean accountProblem;    // the key/account itself, vs. this request

        Verdict(boolean quotaExhausted, long retryAfterMs, boolean accountProblem) {
            this.quotaExhausted = quotaExhausted;
            this.retryAfterMs = retryAfterMs;
            this.accountProblem = accountProblem;
        }
    }

    /**
     * Read a provider error the way the provider means it.
     *
     * <p>"insufficient_quota" / "exceeded your current quota" / "billing" mean the account
     * has no budget left: park it. The reset window is taken from {@code retry-after},
     * or from a stated "try again in Xs" / "resets at" hint, and defaults to an hour.
     */
    public static Verdict interpret(int status, String body) {
        String text = body == null ? "" : body.toLowerCase(java.util.Locale.US);

        boolean quota = status == 402
                || text.contains("insufficient_quota")
                || text.contains("insufficient quota")
                || text.contains("exceeded your current quota")
                || text.contains("quota exceeded")
                || text.contains("out of credits")
                || text.contains("no credit")
                || text.contains("billing hard limit")
                || text.contains("exceeded your current usage")
                || text.contains("free tier")
                || text.contains("daily limit")
                || text.contains("token limit")
                || text.contains("limit reached");

        boolean rateLimited = status == 429;

        boolean accountProblem = quota
                || rateLimited
                || text.contains("invalid api key")
                || text.contains("incorrect api key")
                || text.contains("invalid_api_key")
                || text.contains("authentication")
                || text.contains("unauthorized")
                || text.contains("account deactivated")
                || text.contains("account suspended")
                || text.contains("organization has been disabled")
                || text.contains("no longer active");

        long retryAfter = parseRetryAfter(text);
        if (retryAfter == 0 && (quota || rateLimited)) {
            retryAfter = 3600_000L;    // provider gave no window: assume the hourly bucket
        }
        return new Verdict(quota, retryAfter, accountProblem);
    }

    /** Pull a wait out of "retry after 30", "try again in 12.5s", or "resets in 2m". */
    static long parseRetryAfter(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("(?:retry[- ]?after|try again in|resets? in|available in)[^0-9]{0,12}"
                        + "([0-9]+(?:\\.[0-9]+)?)\\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hours)?")
                .matcher(text);
        if (matcher.find()) {
            double value = Double.parseDouble(matcher.group(1));
            String unit = matcher.group(2);
            if (unit == null) {
                return (long) (value * 1000);          // bare number: seconds, per Retry-After
            }
            if (unit.startsWith("ms")) {
                return (long) value;
            }
            if (unit.startsWith("m") && !unit.startsWith("min")) {
                return (long) (value * 60_000);
            }
            if (unit.startsWith("min")) {
                return (long) (value * 60_000);
            }
            if (unit.startsWith("h")) {
                return (long) (value * 3_600_000);
            }
            return (long) (value * 1000);
        }
        java.util.regex.Matcher bare = java.util.regex.Pattern
                .compile("^\\s*([0-9]+)\\s*$").matcher(text.trim());
        if (bare.find()) {
            return Long.parseLong(bare.group(1)) * 1000L;
        }
        return 0;
    }

    /**
     * Escalating quarantine: an account that keeps hitting quota gets parked longer each
     * time, so a chronically exhausted key stops burning attempts.
     */
    public synchronized long escalate(String accountName, long baseMs) {
        Integer hits = consecutiveQuotaHits.get(accountName);
        int count = hits == null ? 1 : hits + 1;
        consecutiveQuotaHits.put(accountName, count);
        long multiplier = Math.min(count, 6);
        return baseMs * multiplier;
    }

    public synchronized void clearEscalation(String accountName) {
        consecutiveQuotaHits.remove(accountName);
    }

    public synchronized int quotaHits(String accountName) {
        Integer hits = consecutiveQuotaHits.get(accountName);
        return hits == null ? 0 : hits;
    }
}