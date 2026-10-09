package com.aiproxy.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What a provider is, what a key looks like, and which models are free.
 *
 * <p>Everything here is offline: key shapes are regular expressions, brand marks are
 * inline SVG, and the free-tier list is a static table. No network call is needed to
 * answer "whose key is this?" — which is what the dashboard's key-identifier panel and
 * the routing filter both read from.
 */
public final class Providers {

    private Providers() {}

    // ------------------------------------------------------------------ catalogue

    /** One provider: identity, brand, endpoint, and how its keys are shaped. */
    public static final class Info {
        public final String id;
        public final String name;
        public final String colour;
        public final String baseUrl;
        public final String keyPattern;
        public final String keyHint;
        public final String authHeader;
        public final String docs;
        public final boolean freeTier;
        public final String logo;

        Info(String id, String name, String colour, String baseUrl, String keyPattern,
             String keyHint, String authHeader, String docs, boolean freeTier, String logo) {
            this.id = id;
            this.name = name;
            this.colour = colour;
            this.baseUrl = baseUrl;
            this.keyPattern = keyPattern;
            this.keyHint = keyHint;
            this.authHeader = authHeader;
            this.docs = docs;
            this.freeTier = freeTier;
            this.logo = logo;
        }

        public JSONObject toJSON() {
            try {
                return new JSONObject()
                        .put("id", id)
                        .put("name", name)
                        .put("colour", colour)
                        .put("base_url", baseUrl)
                        .put("key_hint", keyHint)
                        .put("auth_header", authHeader)
                        .put("docs", docs)
                        .put("free_tier", freeTier)
                        .put("logo", logo)
                        .put("key_pattern", keyPattern);
            } catch (Exception exc) {
                throw new IllegalStateException(exc);
            }
        }
    }

    private static final Map<String, Info> CATALOGUE = new LinkedHashMap<String, Info>();

    private static void register(Info info) {
        CATALOGUE.put(info.id, info);
    }

    /**
     * Brand mark as an inline SVG: the glyph sits on the provider's own colour, so the
     * dashboard needs no image assets and no network to render provider identity.
     */
    private static String mark(String glyph, String colour) {
        return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40' width='40' "
                + "height='40' role='img'>"
                + "<rect width='40' height='40' rx='11' fill='" + colour + "'/>"
                + "<text x='20' y='20' font-family='Helvetica,Arial,sans-serif' font-size='"
                + (glyph.length() > 1 ? "15" : "19")
                + "' font-weight='700' fill='#ffffff' text-anchor='middle' "
                + "dominant-baseline='central'>" + glyph + "</text></svg>";
    }

    static {
        register(new Info("openai", "OpenAI", "#10A37F",
                "https://api.openai.com/v1", "^sk-(proj-)?[A-Za-z0-9_-]{20,}$",
                "sk-…", "Authorization: Bearer", "https://platform.openai.com/api-keys",
                false, mark("O", "#10A37F")));
        register(new Info("anthropic", "Anthropic", "#D97757",
                "https://api.anthropic.com/v1", "^sk-ant-[A-Za-z0-9_-]{20,}$",
                "sk-ant-…", "x-api-key", "https://console.anthropic.com/settings/keys",
                false, mark("A", "#D97757")));
        register(new Info("google", "Google Gemini", "#4285F4",
                "https://generativelanguage.googleapis.com/v1beta",
                "^AIza[0-9A-Za-z_-]{35}$", "AIza…", "x-goog-api-key",
                "https://aistudio.google.com/app/apikey", true, mark("G", "#4285F4")));
        register(new Info("openrouter", "OpenRouter", "#6467F2",
                "https://openrouter.ai/api/v1", "^sk-or-v1-[A-Za-z0-9]{32,}$",
                "sk-or-v1-…", "Authorization: Bearer", "https://openrouter.ai/keys",
                true, mark("OR", "#6467F2")));
        register(new Info("groq", "Groq", "#F55036",
                "https://api.groq.com/openai/v1", "^gsk_[A-Za-z0-9]{32,}$",
                "gsk_…", "Authorization: Bearer", "https://console.groq.com/keys",
                true, mark("GQ", "#F55036")));
        register(new Info("mistral", "Mistral", "#FA520F",
                "https://api.mistral.ai/v1", "^[A-Za-z0-9]{32,}$",
                "32-char alphanumeric", "Authorization: Bearer",
                "https://console.mistral.ai/api-keys", true, mark("M", "#FA520F")));
        register(new Info("xai", "xAI Grok", "#000000",
                "https://api.x.ai/v1", "^xai-[A-Za-z0-9]{40,}$",
                "xai-…", "Authorization: Bearer", "https://console.x.ai",
                true, mark("X", "#000000")));
        register(new Info("deepseek", "DeepSeek", "#4D6BFE",
                "https://api.deepseek.com/v1", "^sk-[a-f0-9]{32}$",
                "sk- + 32 hex", "Authorization: Bearer", "https://platform.deepseek.com",
                true, mark("DS", "#4D6BFE")));
        register(new Info("moonshot", "Moonshot Kimi", "#1F1F1F",
                "https://api.moonshot.cn/v1", "^sk-[A-Za-z0-9]{32}$",
                "sk- + 32 alnum", "Authorization: Bearer", "https://platform.moonshot.cn",
                true, mark("K", "#1F1F1F")));
        register(new Info("siliconflow", "SiliconFlow", "#6E56CF",
                "https://api.siliconflow.cn/v1", "^sf-[A-Za-z0-9]{20,}$",
                "sf-…", "Authorization: Bearer", "https://cloud.siliconflow.cn/account/ak",
                true, mark("SF", "#6E56CF")));
        register(new Info("together", "Together AI", "#0F6FFF",
                "https://api.together.xyz/v1", "^[0-9a-f]{64}$",
                "64-char hex", "Authorization: Bearer", "https://api.together.ai/settings/api-keys",
                true, mark("TG", "#0F6FFF")));
        register(new Info("fireworks", "Fireworks AI", "#5019C5",
                "https://api.fireworks.ai/inference/v1", "^fw_[A-Za-z0-9_-]{20,}$",
                "fw_…", "Authorization: Bearer", "https://fireworks.ai/dashboard/api-keys",
                true, mark("FW", "#5019C5")));
        register(new Info("cerebras", "Cerebras", "#F26522",
                "https://api.cerebras.ai/v1", "^csk-[A-Za-z0-9]{20,}$",
                "csk-…", "Authorization: Bearer", "https://cloud.cerebras.ai",
                true, mark("CB", "#F26522")));
        register(new Info("perplexity", "Perplexity", "#20808D",
                "https://api.perplexity.ai", "^pplx-[A-Za-z0-9]{20,}$",
                "pplx-…", "Authorization: Bearer", "https://www.perplexity.ai/settings/api",
                true, mark("PX", "#20808D")));
        register(new Info("huggingface", "Hugging Face", "#FFD21E",
                "https://api-inference.huggingface.co/v1", "^hf_[A-Za-z0-9]{30,}$",
                "hf_…", "Authorization: Bearer", "https://huggingface.co/settings/tokens",
                true, mark("HF", "#FFD21E")));
        register(new Info("replicate", "Replicate", "#1F1F1F",
                "https://api.replicate.com/v1", "^r8_[A-Za-z0-9]{30,}$",
                "r8_…", "Authorization: Bearer", "https://replicate.com/account/api-tokens",
                false, mark("R", "#1F1F1F")));
        register(new Info("github", "GitHub Copilot", "#6E40C9",
                "https://api.githubcopilot.com", "^gh[opurs]_[A-Za-z0-9]{20,}$",
                "ghp_ / gho_ / ghu_", "Authorization: token",
                "https://github.com/settings/tokens", true, mark("GH", "#6E40C9")));
        register(new Info("zhipu", "Zhipu GLM", "#3859FF",
                "https://open.bigmodel.cn/api/paas/v4", "^[A-Za-z0-9]{16}\\.[A-Za-z0-9]{16,}$",
                "id.secret", "Authorization: Bearer", "https://open.bigmodel.cn/usercenter/apikeys",
                true, mark("GLM", "#3859FF")));
        register(new Info("jina", "Jina AI", "#0A7C7C",
                "https://api.jina.ai/v1", "^jina_[A-Za-z0-9]{20,}$",
                "jina_…", "Authorization: Bearer", "https://dashboard.jina.ai",
                true, mark("JN", "#0A7C7C")));
        register(new Info("voyage", "Voyage AI", "#6E56CF",
                "https://api.voyageai.com/v1", "^voy_[A-Za-z0-9]{20,}$",
                "voy-…", "Authorization: Bearer", "https://dashboard.voyageai.com",
                false, mark("VY", "#6E56CF")));
        register(new Info("nvidia", "NVIDIA NIM", "#76B900",
                "https://integrate.api.nvidia.com/v1", "^nvapi-[A-Za-z0-9_-]{20,}$",
                "nvapi-…", "Authorization: Bearer", "https://build.nvidia.com",
                true, mark("NV", "#76B900")));
        register(new Info("ollama", "Ollama (local)", "#111827",
                "http://127.0.0.1:11434/v1", "^$", "no key", "none",
                "https://ollama.com", true, mark("OL", "#111827")));
        register(new Info("custom", "Custom endpoint", "#64748B",
                "", ".*", "anything", "Authorization: Bearer", "", false,
                mark("••", "#64748B")));
    }

    // ------------------------------------------------------------------ lookup

    public static Info get(String id) {
        Info info = CATALOGUE.get(id == null ? "" : id.toLowerCase(java.util.Locale.US));
        return info == null ? CATALOGUE.get("custom") : info;
    }

    public static Info detect(String apiKey) {
        Info best = null;
        int bestScore = -1;
        for (Info info : CATALOGUE.values()) {
            if (info.keyPattern.isEmpty() || info.keyPattern.equals(".*")) {
                continue;
            }
            try {
                if (!apiKey.matches(info.keyPattern)) {
                    continue;
                }
                // Score by how much literal text precedes the first metacharacter, so
                // `sk-ant-…` outranks `sk-…`. Pattern length would reward the pattern
                // with the most syntax instead of the most information.
                int score = literalPrefix(info.keyPattern) * 100 + info.keyPattern.length();
                if (score > bestScore) {
                    bestScore = score;
                    best = info;
                }
            } catch (Exception ignored) {
                // an invalid regex in the table must never break detection
            }
        }
        if (best != null) {
            return best;
        }
        // no signature match: still say something useful rather than "unknown"
        if (apiKey == null || apiKey.isEmpty()) {
            return get("ollama");
        }
        if (apiKey.length() >= 40) {
            return get("openai");
        }
        return get("custom");
    }

    /** Count the deterministic characters before the first regex metacharacter. */
    private static int literalPrefix(String pattern) {
        String p = pattern.startsWith("^") ? pattern.substring(1) : pattern;
        int n = 0;
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (c == '[' || c == '(' || c == '{' || c == '.' || c == '*' || c == '+' 
                    || c == '?' || c == '|' || c == '$' || c == '^' || c == '\\') {
                break;
            }
            n++;
        }
        return n;
    }

    public static JSONArray catalogueJSON() {
        JSONArray out = new JSONArray();
        for (Info info : CATALOGUE.values()) {
            out.put(info.toJSON());
        }
        return out;
    }

    /**
     * Full identification result for the dashboard: who issued the key, how sure we
     * are, what it unlocks, and the brand mark to render.
     */
    public static JSONObject identify(String apiKey) throws Exception {
        Info info = detect(apiKey == null ? "" : apiKey.trim());
        String key = apiKey == null ? "" : apiKey.trim();
        JSONObject out = info.toJSON()
                .put("masked", mask(key))
                .put("length", key.length())
                .put("prefix", key.length() >= 6 ? key.substring(0, 6) : key)
                .put("confidence", key.matches(info.keyPattern) ? "exact"
                        : (key.isEmpty() ? "none" : "heuristic"))
                .put("accepted", !key.isEmpty());
        out.put("billing_hint", billingHint(info));
        out.put("account_hint", accountHint(key, info));
        return out;
    }

    private static String mask(String key) {
        if (key == null || key.isEmpty()) {
            return "";
        }
        if (key.length() <= 12) {
            return key.length() <= 4 ? "••••" : key.substring(0, 2) + "••••";
        }
        return key.substring(0, 6) + "…" + key.substring(key.length() - 4);
    }

    private static String billingHint(Info info) {
        if (info.freeTier) {
            return info.id + " has a free tier — accounts are quota-bound, so quota-aware "
                    + "failover matters more here than on paid providers";
        }
        return info.id + " is metered per token; the per-account daily budget is the "
                + "control that keeps spend bounded";
    }

    /**
     * Google keys are the one place the issuing account is recoverable from the key
     * itself; for OAuth-style keys we can at least separate personal from project.
     */
    private static String accountHint(String key, Info info) {
        if (info.id.equals("google")) {
            return "Google API keys are project-scoped — the project that owns this key is "
                    + "the account, visible at aistudio.google.com";
        }
        if (key.startsWith("ghp_")) {
            return "GitHub personal access token — the owning login is visible on github.com/settings/tokens";
        }
        if (key.startsWith("ghu_")) {
            return "GitHub user-to-server token for a Copilot subscription";
        }
        if (key.startsWith("gho_")) {
            return "GitHub OAuth token";
        }
        if (key.startsWith("sk-ant-")) {
            return "Anthropic console key — organisation and workspace are visible on "
                    + "console.anthropic.com/settings/keys";
        }
        if (key.startsWith("sk-or-v1-")) {
            return "OpenRouter key — the funding account is on openrouter.ai/settings/keys";
        }
        return "provider keys do not encode the owning account; check " + info.docs;
    }

    // ------------------------------------------------------------------ free models

    /** Models that are free to call, by exact id or by suffix rule. */
    private static final String[] FREE_EXACT = {
            "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite",
            "gemini-2.5-flash-preview-05-20", "gemini-flash-latest",
            "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "meta-llama/llama-3.1-8b-instant",
            "meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-3.1-405b-instruct",
            "deepseek-r1-distill-llama-70b", "gemma2-9b-it", "mistral-7b-instruct-v0.3",
            "mixtral-8x7b-instruct-v0.1", "qwen/qwen-2.5-7b-instruct", "qwen/qwen-2.5-coder-32b-instruct",
            "command-r7b-12-2024", "command-r-plus", "llama-3.3-70b-instruct",
            "gemma-2-9b-it", "phi-3-mini-128k-instruct",
    };

    private static final String[] FREE_SUFFIXES = {
            ":free", "-free", ":free-tier",
    };

    private static final String[] PAID_HINTS = {
            "gpt-4", "gpt-3.5-turbo", "o1", "o3", "o4", "claude-3", "claude-opus", "claude-sonnet-4",
            "davinci", "text-embedding-ada", "instruct-gpt", "command-r-plus",
    };

    /**
     * Free = zero marginal price. OpenRouter's {@code :free} suffix is authoritative; the
     * exact table covers provider free tiers; the paid hints veto the rest.
     */
    public static boolean isFreeModel(String model) {
        if (model == null || model.isEmpty()) {
            return false;
        }
        String id = model.toLowerCase(java.util.Locale.US);
        for (String suffix : FREE_SUFFIXES) {
            if (id.endsWith(suffix)) {
                return true;
            }
        }
        for (String exact : FREE_EXACT) {
            if (id.equals(exact)) {
                return true;
            }
        }
        for (String paid : PAID_HINTS) {
            if (id.startsWith(paid) || id.contains("/" + paid)) {
                return false;
            }
        }
        // a provider that advertises a free tier and does not price a model is free
        return false;
    }

    /** Which provider a model id belongs to, when the account does not say. */
    public static String providerOfModel(String model) {
        if (model == null) {
            return "custom";
        }
        String id = model.toLowerCase(java.util.Locale.US);
        if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")
                || id.startsWith("o4") || id.startsWith("chatgpt")) {
            return "openai";
        }
        if (id.startsWith("claude")) {
            return "anthropic";
        }
        if (id.startsWith("gemini")) {
            return "google";
        }
        if (id.startsWith("grok")) {
            return "xai";
        }
        if (id.contains("/")) {
            return "openrouter";
        }
        return "custom";
    }

    public static List<String> freeModelNames() {
        List<String> out = new ArrayList<String>();
        for (String model : FREE_EXACT) {
            out.add(model);
        }
        return out;
    }
}
