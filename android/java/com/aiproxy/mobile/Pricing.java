package com.aiproxy.mobile;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Per-token pricing in USD. Prices are per **million** tokens and follow the
 * published provider price lists; unknown models cost 0 rather than guessing,
 * because a wrong cost is worse than a missing one.
 */
public final class Pricing {

    /** input, output — USD per 1M tokens. */
    private static final Map<String, double[]> TABLE = new HashMap<String, double[]>();

    static {
        // OpenAI
        put("gpt-4o", 2.50, 10.00);
        put("gpt-4o-mini", 0.15, 0.60);
        put("gpt-4o-2024-08-06", 2.50, 10.00);
        put("gpt-4.1", 2.00, 8.00);
        put("gpt-4.1-mini", 0.40, 1.60);
        put("gpt-4.1-nano", 0.10, 0.40);
        put("gpt-4-turbo", 10.00, 30.00);
        put("gpt-4", 30.00, 60.00);
        put("gpt-3.5-turbo", 0.50, 1.50);
        put("o1", 15.00, 60.00);
        put("o1-mini", 1.10, 4.40);
        put("o3-mini", 1.10, 4.40);
        put("o3", 10.00, 40.00);
        put("text-embedding-3-small", 0.02, 0.0);
        put("text-embedding-3-large", 0.13, 0.0);

        // Anthropic
        put("claude-opus-4-20250514", 15.00, 75.00);
        put("claude-opus-4", 15.00, 75.00);
        put("claude-sonnet-4-20250514", 3.00, 15.00);
        put("claude-sonnet-4", 3.00, 15.00);
        put("claude-3-7-sonnet-20250219", 3.00, 15.00);
        put("claude-3-5-sonnet-20241022", 3.00, 15.00);
        put("claude-3-5-haiku-20241022", 0.80, 4.00);
        put("claude-3-opus-20240229", 15.00, 75.00);
        put("claude-3-haiku-20240307", 0.25, 1.25);

        // Google
        put("gemini-2.5-pro", 1.25, 10.00);
        put("gemini-2.5-flash", 0.30, 2.50);
        put("gemini-2.0-flash", 0.10, 0.40);
        put("gemini-2.0-flash-lite", 0.075, 0.30);
        put("gemini-1.5-pro", 1.25, 5.00);
        put("gemini-1.5-flash", 0.075, 0.30);
    }

    private static void put(String model, double input, double output) {
        TABLE.put(model, new double[]{input, output});
    }

    private Pricing() {
    }

    public static double cost(String model, int tokensIn, int tokensOut) {
        double[] price = lookup(model);
        if (price == null) {
            return 0;
        }
        return (tokensIn / 1_000_000.0) * price[0] + (tokensOut / 1_000_000.0) * price[1];
    }

    /** Exact match first, then the longest declared prefix that matches. */
    static double[] lookup(String model) {
        if (model == null) {
            return null;
        }
        String key = normalise(model);
        double[] exact = TABLE.get(key);
        if (exact != null) {
            return exact;
        }
        String best = null;
        for (String candidate : TABLE.keySet()) {
            if (key.startsWith(candidate) && (best == null || candidate.length() > best.length())) {
                best = candidate;
            }
        }
        return best == null ? null : TABLE.get(best);
    }

    public static String normalise(String model) {
        String key = model.toLowerCase(Locale.US).trim();
        // bedrock-style "anthropic.claude-3-5-sonnet-20241022-v2:0" -> claude-3-5-sonnet-20241022
        int colon = key.indexOf(':');
        if (colon > 0) {
            key = key.substring(0, colon);
        }
        if (key.contains(".")) {
            int dot = key.indexOf('.');
            key = key.substring(dot + 1);
        }
        return key;
    }

    public static boolean known(String model) {
        return lookup(model) != null;
    }
}