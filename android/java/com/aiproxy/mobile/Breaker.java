package com.aiproxy.mobile;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Per-account circuit breaker.
 *
 * <p>States: {@code closed} → {@code open} after N consecutive failures →
 * {@code half_open} once the cooldown elapses (a single probe is admitted) →
 * {@code closed} again after enough consecutive successes.
 *
 * <p>A 4xx that is not retryable releases the probe slot instead of counting as a
 * failure: a bad request from the client says nothing about upstream health.
 */
public final class Breaker {

    public static final String CLOSED = "closed";
    public static final String OPEN = "open";
    public static final String HALF_OPEN = "half_open";

    private String state = CLOSED;
    private int consecutiveFailures;
    private int consecutiveSuccesses;
    private long openedAtMs;
    private double lastSuccessTs;
    private String lastError;

    private int failureThreshold = 5;
    private int successThreshold = 2;
    private long cooldownMs = 45_000L;
    private int halfOpenMaxConcurrency = 1;

    private final List<Double> latencies = new ArrayList<Double>();
    private final List<Boolean> outcomes = new ArrayList<Boolean>();
    private int inFlight;

    public void configure(JSONObject circuitBreaker) {
        if (circuitBreaker == null) {
            return;
        }
        failureThreshold = Math.max(1, circuitBreaker.optInt("failure_threshold", failureThreshold));
        successThreshold = Math.max(1, circuitBreaker.optInt("success_threshold", successThreshold));
        cooldownMs = Math.max(0L,
                (long) (circuitBreaker.optDouble("cooldown_seconds", cooldownMs / 1000.0) * 1000));
        halfOpenMaxConcurrency = Math.max(1,
                circuitBreaker.optInt("half_open_max_concurrency", halfOpenMaxConcurrency));
    }

    public synchronized String state() {
        promoteIfReady();
        return state;
    }

    /** Move open → half_open when the cooldown has elapsed. */
    private void promoteIfReady() {
        if (state.equals(OPEN) && System.currentTimeMillis() - openedAtMs >= cooldownMs) {
            state = HALF_OPEN;
            consecutiveSuccesses = 0;
        }
    }

    /** Can a request be dispatched to this account right now? */
    public synchronized boolean allow() {
        promoteIfReady();
        if (state.equals(OPEN)) {
            return false;
        }
        if (state.equals(HALF_OPEN) && inFlight >= halfOpenMaxConcurrency) {
            return false;
        }
        inFlight++;
        return true;
    }

    public synchronized void release() {
        if (inFlight > 0) {
            inFlight--;
        }
    }

    public synchronized void onSuccess(double latencyMs) {
        record(latencyMs, true);
        if (inFlight > 0) {
            inFlight--;
        }
        lastSuccessTs = System.currentTimeMillis() / 1000.0;
        if (state.equals(HALF_OPEN)) {
            consecutiveSuccesses++;
            if (consecutiveSuccesses >= successThreshold) {
                state = CLOSED;
                consecutiveFailures = 0;
                consecutiveSuccesses = 0;
            }
        } else {
            consecutiveFailures = 0;
        }
        lastError = null;
    }

    public synchronized void onFailure(double latencyMs, String error) {
        record(latencyMs, false);
        if (inFlight > 0) {
            inFlight--;
        }
        lastError = error;
        consecutiveSuccesses = 0;
        consecutiveFailures++;
        if (state.equals(HALF_OPEN) || consecutiveFailures >= failureThreshold) {
            trip();
        }
    }

    /** A non-retryable client error: release the slot, do not punish the account. */
    public synchronized void onClientError() {
        if (inFlight > 0) {
            inFlight--;
        }
    }

    private void trip() {
        state = OPEN;
        openedAtMs = System.currentTimeMillis();
        consecutiveSuccesses = 0;
    }

    private void record(double latencyMs, boolean ok) {
        latencies.add(latencyMs);
        outcomes.add(ok);
        while (latencies.size() > 50) {
            latencies.remove(0);
            outcomes.remove(0);
        }
    }

    public synchronized double avgLatency() {
        if (latencies.isEmpty()) {
            return 0;
        }
        double total = 0;
        for (Double value : latencies) {
            total += value;
        }
        return total / latencies.size();
    }

    public synchronized double successRate() {
        if (outcomes.isEmpty()) {
            return 1.0;
        }
        int ok = 0;
        for (Boolean value : outcomes) {
            if (value) {
                ok++;
            }
        }
        return ok / (double) outcomes.size();
    }

    public synchronized int consecutiveFailures() {
        return consecutiveFailures;
    }

    public synchronized String lastError() {
        return lastError;
    }

    public synchronized double lastSuccessTs() {
        return lastSuccessTs;
    }

    public synchronized int inFlight() {
        return inFlight;
    }

    /** Seconds until an open circuit may be probed again. */
    public synchronized double retryAfterSeconds() {
        if (!state.equals(OPEN)) {
            return 0;
        }
        long remaining = cooldownMs - (System.currentTimeMillis() - openedAtMs);
        return Math.max(0, remaining) / 1000.0;
    }

    public synchronized void reset() {
        state = CLOSED;
        consecutiveFailures = 0;
        consecutiveSuccesses = 0;
        lastError = null;
        latencies.clear();
        outcomes.clear();
    }
}