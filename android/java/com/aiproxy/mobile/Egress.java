package com.aiproxy.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Egress control: which network identity each account leaves through.
 *
 * <p>When several accounts belong to one provider, they all hitting the API from a single
 * address is the strongest possible signal that they are one operator. This layer spreads
 * same-provider accounts across distinct exits — a proxy pool, or an explicit per-account
 * override — and reports the resulting spread so the dashboard can show whether two
 * accounts still share an address.
 *
 * <p>Assignment is sticky: account → exit is decided once and stored, so a given key
 * always leaves from the same address. Flip-flopping an account between exits is itself a
 * fraud signal.
 */
public final class Egress {

    private Egress() {}

    /** One outbound exit: an HTTP or SOCKS proxy, or direct. */
    public static final class Exit {
        public final String id;
        public final String scheme;      // http | socks5 | direct
        public final String host;
        public final int port;
        public final String username;
        public final String password;
        public final String label;

        Exit(String id, String scheme, String host, int port, String username,
             String password, String label) {
            this.id = id;
            this.scheme = scheme;
            this.host = host;
            this.port = port;
            this.username = username;
            this.password = password;
            this.label = label;
        }

        public boolean isDirect() {
            return "direct".equals(scheme) || host == null || host.isEmpty();
        }

        public Proxy toJavaProxy() {
            if (isDirect()) {
                return Proxy.NO_PROXY;
            }
            Proxy.Type type = "socks5".equals(scheme) || "socks".equals(scheme)
                    ? Proxy.Type.SOCKS : Proxy.Type.HTTP;
            return new Proxy(type, new InetSocketAddress(host, port));
        }

        /** Redacted form — the proxy password never leaves the device in a response. */
        public JSONObject toJSON() {
            try {
                return new JSONObject()
                        .put("id", id)
                        .put("scheme", scheme)
                        .put("host", host == null ? "" : host)
                        .put("port", port)
                        .put("label", label)
                        .put("has_auth", username != null && !username.isEmpty())
                        .put("direct", isDirect());
            } catch (Exception exc) {
                throw new IllegalStateException(exc);
            }
        }
    }

    /** Parse one `http://user:pass@host:port` (or socks5://, or `direct`) entry. */
    public static Exit parse(String spec) {
        if (spec == null || spec.trim().isEmpty() || "direct".equalsIgnoreCase(spec.trim())) {
            return new Exit("direct", "direct", "", 0, "", "", "Device IP (direct)");
        }
        String trimmed = spec.trim();
        String scheme = "http";
        String rest = trimmed;
        int schemeAt = trimmed.indexOf("://");
        if (schemeAt > 0) {
            scheme = trimmed.substring(0, schemeAt).toLowerCase(java.util.Locale.US);
            rest = trimmed.substring(schemeAt + 3);
        }
        String username = "";
        String password = "";
        int at = rest.lastIndexOf('@');
        if (at > 0) {
            String credentials = rest.substring(0, at);
            rest = rest.substring(at + 1);
            int colon = credentials.indexOf(':');
            if (colon >= 0) {
                username = credentials.substring(0, colon);
                password = credentials.substring(colon + 1);
            } else {
                username = credentials;
            }
        }
        String host = rest;
        int port = "socks5".equals(scheme) ? 1080 : 8080;
        int colon = rest.lastIndexOf(':');
        if (colon > 0) {
            host = rest.substring(0, colon);
            try {
                port = Integer.parseInt(rest.substring(colon + 1));
            } catch (NumberFormatException ignored) {
                // keep the default port
            }
        }
        return new Exit(host + ":" + port, scheme, host, port, username, password,
                host + ":" + port);
    }

    /**
     * Assign an exit to every account.
     *
     * <p>Rule: accounts of the same provider walk the pool round-robin, so N accounts of
     * one provider get N different exits whenever the pool is at least N deep. An
     * account that already carries its own explicit proxy keeps it, and the pool walk
     * skips over exits that are already spoken for.
     */
    public static Map<String, Exit> assign(List<Account> accounts, List<String> poolSpecs,
                                           Map<String, String> overrides) {
        List<Exit> pool = new ArrayList<Exit>();
        for (String spec : poolSpecs) {
            Exit exit = parse(spec);
            if (!exit.isDirect()) {
                pool.add(exit);
            }
        }

        Map<String, Exit> assignment = new LinkedHashMap<String, Exit>();
        Map<String, Integer> cursorByProvider = new LinkedHashMap<String, Integer>();

        for (Account account : accounts) {
            String override = overrides == null ? null : overrides.get(account.name);
            if (override != null && !override.isEmpty()) {
                assignment.put(account.name, parse(override));
                continue;
            }
            if (account.egress != null && !account.egress.isEmpty()) {
                assignment.put(account.name, parse(account.egress));
                continue;
            }
            if (pool.isEmpty()) {
                assignment.put(account.name, parse("direct"));
                continue;
            }
            String key = account.providerType == null ? "custom" : account.providerType;
            Integer cursor = cursorByProvider.get(key);
            if (cursor == null) {
                cursor = 0;
            }
            assignment.put(account.name, pool.get(cursor % pool.size()));
            cursorByProvider.put(key, cursor + 1);
        }
        return assignment;
    }

    /**
     * How well the same-provider accounts are spread. Anything below 1.0 means at least
     * two accounts of one provider still share an exit, which is the correlation the
     * pool exists to break.
     */
    public static JSONObject spread(List<Account> accounts, Map<String, Exit> assignment)
            throws Exception {
        Map<String, List<String>> byGroup = new LinkedHashMap<String, List<String>>();
        Map<String, Map<String, Integer>> exitsByGroup =
                new LinkedHashMap<String, Map<String, Integer>>();

        for (Account account : accounts) {
            if (!account.enabled) {
                continue;
            }
            Exit exit = assignment.get(account.name);
            String exitId = exit == null ? "direct" : exit.id;
            // "same provider, same base URL" is the group that must not look correlated
            String group = account.providerType + "@" + account.baseUrl;
            List<String> members = byGroup.get(group);
            if (members == null) {
                members = new ArrayList<String>();
                byGroup.put(group, members);
            }
            members.add(account.name);

            Map<String, Integer> counts = exitsByGroup.get(group);
            if (counts == null) {
                counts = new LinkedHashMap<String, Integer>();
                exitsByGroup.put(group, counts);
            }
            Integer count = counts.get(exitId);
            counts.put(exitId, count == null ? 1 : count + 1);
        }

        JSONArray groups = new JSONArray();
        double worst = 1.0;
        for (Map.Entry<String, List<String>> entry : byGroup.entrySet()) {
            String group = entry.getKey();
            List<String> members = entry.getValue();
            Map<String, Integer> counts = exitsByGroup.get(group);
            int distinct = counts.size();
            boolean collides = members.size() > 1 && distinct < members.size();
            double ratio = members.isEmpty() ? 1.0 : distinct / (double) members.size();
            if (members.size() > 1) {
                worst = Math.min(worst, ratio);
            }
            groups.put(new JSONObject()
                    .put("group", group)
                    .put("accounts", members.size())
                    .put("distinct_exits", distinct)
                    .put("collides", collides)
                    .put("accounts_list", new JSONArray(members)));
        }

        return new JSONObject()
                .put("groups", groups)
                .put("score", Math.round(worst * 100.0) / 100.0)
                .put("clean", worst >= 1.0);
    }

    /** Sanity-check a proxy specification without leaking its password. */
    public static JSONObject describe(String spec) throws Exception {
        Exit exit = parse(spec);
        return exit.toJSON()
                .put("valid", exit.isDirect() || !exit.host.isEmpty())
                .put("normalised", exit.isDirect() ? "direct" : exit.scheme + "://" + exit.id);
    }
}
