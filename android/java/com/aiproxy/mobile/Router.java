package com.aiproxy.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Account selection, retry and failover.
 *
 * <p>Strategy resolution is {@code account override → alias strategy → global
 * strategy}. Each candidate is checked against the circuit breaker before it is
 * attempted, so an open account costs nothing.
 */
public final class Router {

    public static final class Attempt {
        public final Account account;
        public final String model;
        public final int attempts;

        Attempt(Account account, String model, int attempts) {
            this.account = account;
            this.model = model;
            this.attempts = attempts;
        }
    }

    public static final class NoAccount extends Exception {
        public final int status;
        public final String type;

        NoAccount(String message, int status, String type) {
            super(message);
            this.status = status;
            this.type = type;
        }
    }

    private final Store store;
    private final Map<String, String> affinity = new LinkedHashMap<String, String>();
    private final AtomicLong roundRobin = new AtomicLong();
    private final RateLimiter limiter = new RateLimiter();

    public Router(Store store) {
        this.store = store;
    }

    public RateLimiter limiter() {
        return limiter;
    }

    public void forgetSession(String sessionId) {
        synchronized (affinity) {
            affinity.remove(sessionId);
        }
    }

    public int affinitySize() {
        synchronized (affinity) {
            return affinity.size();
        }
    }

    /**
     * Resolve a requested model to an ordered chain of concrete models: aliases expand
     * to their fallback list, a prefix match narrows to the account's declared model.
     */
    public List<String> chain(String requested, String accountHint) {
        List<String> out = new ArrayList<String>();
        Map<String, String> aliases = store.aliases();
        if (aliases.containsKey(requested)) {
            try {
                JSONArray targets = new JSONArray(aliases.get(requested));
                for (int i = 0; i < targets.length(); i++) {
                    out.add(targets.optString(i));
                }
            } catch (Exception ignored) {
                // corrupt alias falls through to literal matching
            }
            return out;
        }
        out.add(requested);
        return out;
    }

    /** All distinct models any enabled account serves, sorted. */
    public List<String> allModels() {
        Set<String> models = new java.util.TreeSet<String>();
        for (Account account : store.accounts()) {
            if (account.enabled) {
                models.addAll(account.models);
            }
        }
        return new ArrayList<String>(models);
    }

    /**
     * Pick the next account for {@code model}, or throw {@link NoAccount} when the
     * pool is exhausted.
     */
    public Attempt select(String requested, String model, Set<String> exclude, String sessionId)
            throws NoAccount {
        JSONObject routing = store.routing();
        JSONObject circuit = routing.optJSONObject("circuit_breaker");
        JSONObject retry = routing.optJSONObject("retry");
        int maxAttempts = retry == null ? 3 : retry.optInt("max_attempts", 3);
        String globalStrategy = routing.optString("strategy", "round_robin");
        boolean prefixMatch = "prefix".equals(routing.optString("model_matching", "exact"));
        JSONObject modelsConfig = routing.optJSONObject("models");
        boolean freeOnly = modelsConfig != null && modelsConfig.optBoolean("free_only", false);

        List<Account> candidates = new ArrayList<Account>();
        Set<String> quotaParked = new HashSet<String>();
        Set<String> freeFiltered = new HashSet<String>();
        for (Account account : store.accounts()) {
            if (!account.enabled || exclude.contains(account.name)) {
                continue;
            }
            if (circuit != null) {
                account.breaker.configure(circuit);
            }
            // An account out of quota is not unhealthy, it is out of budget: skip it
            // silently until the provider's own window rolls over.
            if (account.quotaExhausted()) {
                quotaParked.add(account.name);
                continue;
            }
            // The free-only filter: when the routing config asks for it, or the account
            // itself is flagged, only serve models that cost nothing.
            if ((freeOnly || account.freeOnly) && !Providers.isFreeModel(model)) {
                freeFiltered.add(account.name);
                continue;
            }
            if (!account.breaker.state().equals(Breaker.CLOSED)
                    && !account.breaker.state().equals(Breaker.HALF_OPEN)) {
                continue;                       // circuit open: skip without cost
            }
            if (prefixMatch) {
                if (account.resolvePrefix(model) != null || account.models.isEmpty()) {
                    candidates.add(account);
                }
            } else if (account.serves(model)) {
                candidates.add(account);
            }
        }

        if (candidates.isEmpty()) {
            if (!quotaParked.isEmpty()) {
                throw new NoAccount("every account for '" + model + "' is out of quota ("
                        + quotaParked.size() + " parked); they return automatically when the "
                        + "provider's window resets", 429, "quota_exhausted");
            }
            if (!freeFiltered.isEmpty()) {
                throw new NoAccount("model '" + model + "' is not free and free-only routing is "
                        + "on, so " + freeFiltered.size() + " account(s) were skipped", 402,
                        "not_a_free_model");
            }
            if (exclude.isEmpty()) {
                throw new NoAccount("no enabled account serves model '" + model + "'",
                        503, "no_healthy_accounts");
            }
            throw new NoAccount("every account for model '" + model + "' has been tried",
                    503, "no_healthy_accounts");
        }

        // session affinity pins a conversation to the account that started serving it
        JSONObject affinityConfig = routing.optJSONObject("session_affinity");
        if (sessionId != null && affinityConfig != null && affinityConfig.optBoolean("enabled", true)) {
            String pinned;
            synchronized (affinity) {
                pinned = affinity.get(sessionId);
            }
            if (pinned != null) {
                for (Account account : candidates) {
                    if (account.name.equals(pinned) && account.breaker.allow()) {
                        return new Attempt(account, model, maxAttempts);
                    }
                }
            }
        }

        // Same provider, several keys: prefer a different key from the one that just
        // failed this request, so a quota or ban on one key never stops the request.
        if (!exclude.isEmpty() && candidates.size() > 1) {
            List<Account> untried = new ArrayList<Account>();
            for (Account account : candidates) {
                if (!exclude.contains(account.name)) {
                    untried.add(account);
                }
            }
            if (!untried.isEmpty()) {
                candidates = untried;
            }
        }

        Account chosen = pick(candidates, globalStrategy, model);
        if (chosen == null || !chosen.breaker.allow()) {
            // every candidate's half-open slot is taken — treat as unavailable
            for (Account account : candidates) {
                if (account.breaker.allow()) {
                    chosen = account;
                    break;
                }
            }
            if (chosen == null) {
                throw new NoAccount("all accounts are probing or cooling down",
                        503, "no_healthy_accounts");
            }
        }

        if (sessionId != null && affinityConfig != null && affinityConfig.optBoolean("enabled", true)) {
            int ttl = affinityConfig.optInt("ttl_seconds", 1800);
            synchronized (affinity) {
                if (affinity.size() > 2048) {
                    affinity.clear();
                }
                affinity.put(sessionId, chosen.name);
            }
        }

        String concrete = prefixMatch && !chosen.models.isEmpty()
                ? chosen.resolvePrefix(model) : model;
        if (concrete == null) {
            concrete = model;
        }
        return new Attempt(chosen, concrete, maxAttempts);
    }

    private Account pick(List<Account> candidates, String globalStrategy, String model) {
        String strategy = null;
        for (Account account : candidates) {
            if (account.strategy != null && account.strategy.length() > 0) {
                strategy = account.strategy;
                break;                             // any account override wins
            }
        }
        if (strategy == null) {
            strategy = globalStrategy;
        }

        List<Account> sorted = new ArrayList<Account>(candidates);
        if ("failover".equals(strategy) || "priority".equals(strategy)) {
            Sorts.sortByPriority(sorted);
            return sorted.get(0);
        }
        if ("weighted".equals(strategy)) {
            long total = 0;
            for (Account account : sorted) {
                total += Math.max(1, account.weight);
            }
            long pick = (long) (Math.random() * total);
            for (Account account : sorted) {
                pick -= Math.max(1, account.weight);
                if (pick < 0) {
                    return account;
                }
            }
            return sorted.get(sorted.size() - 1);
        }
        if ("random".equals(strategy)) {
            return sorted.get((int) (Math.random() * sorted.size()));
        }
        if ("least_latency".equals(strategy)) {
            Sorts.sortByLatency(sorted);
            return sorted.get(0);
        }
        if ("least_requests".equals(strategy)) {
            Sorts.sortByInFlight(sorted);
            return sorted.get(0);
        }
        if ("least_cost".equals(strategy)) {
            Sorts.sortByCost(sorted, model);
            return sorted.get(0);
        }
        // round_robin (default)
        Sorts.sortByPriority(sorted);
        int index = (int) Math.abs(roundRobin.getAndIncrement() % sorted.size());
        return sorted.get(index);
    }

    public void releaseSession(String sessionId) {
        if (sessionId != null) {
            forgetSession(sessionId);
        }
    }

    /** Exponential backoff with optional jitter, capped by the routing config. */
    public void backoff(int attempt, JSONObject routing) {
        JSONObject retry = routing.optJSONObject("retry");
        double base = retry == null ? 0.35 : retry.optDouble("backoff_seconds", 0.35);
        double max = retry == null ? 4.0 : retry.optDouble("max_backoff_seconds", 4.0);
        boolean jitter = retry == null || retry.optBoolean("jitter", true);
        double delay = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
        if (jitter) {
            delay *= 0.5 + Math.random() * 0.5;
        }
        try {
            Thread.sleep((long) (delay * 1000));
        } catch (InterruptedException exc) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class Sorts {
        static void sortByPriority(List<Account> list) {
            java.util.Collections.sort(list, new Comparator<Account>() {
                @Override
                public int compare(Account a, Account b) {
                    return Integer.compare(a.priority, b.priority);
                }
            });
        }

        static void sortByLatency(List<Account> list) {
            java.util.Collections.sort(list, new Comparator<Account>() {
                @Override
                public int compare(Account a, Account b) {
                    return Double.compare(a.breaker.avgLatency(), b.breaker.avgLatency());
                }
            });
        }

        static void sortByInFlight(List<Account> list) {
            java.util.Collections.sort(list, new Comparator<Account>() {
                @Override
                public int compare(Account a, Account b) {
                    return Integer.compare(a.breaker.inFlight(), b.breaker.inFlight());
                }
            });
        }

        static void sortByCost(List<Account> list, final String model) {
            java.util.Collections.sort(list, new Comparator<Account>() {
                @Override
                public int compare(Account a, Account b) {
                    return Double.compare(rate(a, model), rate(b, model));
                }

                private double rate(Account account, String model) {
                    double[] price = Pricing.lookup(model);
                    if (price == null) {
                        return 0;
                    }
                    return (price[0] + price[1]) * account.costMultiplier;
                }
            });
        }
    }

    /** Token bucket per account: rpm / tpm / concurrency. */
    public static final class RateLimiter {
        private final Map<String, long[]> windows = new LinkedHashMap<String, long[]>();

        public synchronized boolean allow(String account, int rpm, int tpm, int concurrency) {
            long now = System.currentTimeMillis() / 60000L;
            long[] window = windows.get(account);
            if (window == null || window[0] != now) {
                window = new long[]{now, 0, 0, 0};   // minute, requests, tokens, in-flight
                windows.put(account, window);
            }
            if (rpm > 0 && window[1] >= rpm) {
                return false;
            }
            if (tpm > 0 && window[2] >= tpm) {
                return false;
            }
            if (concurrency > 0 && window[3] >= concurrency) {
                return false;
            }
            window[1]++;
            window[3]++;
            return true;
        }

        public synchronized void complete(String account, int tokens) {
            long now = System.currentTimeMillis() / 60000L;
            long[] window = windows.get(account);
            if (window != null && window[0] == now) {
                window[2] += Math.max(0, tokens);
                if (window[3] > 0) {
                    window[3]--;
                }
            }
        }
    }

    public static Set<String> emptyExclude() {
        return new HashSet<String>();
    }
}