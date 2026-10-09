package com.aiproxy.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Desktop client identity for upstream calls.
 *
 * <p>Some providers gate access on the client looking like a desktop browser rather than
 * a script. This layer gives every account a stable, internally-consistent desktop
 * identity — a real Chrome release string, the matching client-hint and navigation
 * headers, header ordering, and a matching viewport/timezone/locale triple — and pins it
 * to that account so the same "machine" keeps reappearing across requests.
 *
 * <p>Consistency is what makes this hold up: a UA that claims macOS while the accept
 * language, platform hint, TLS session and request cadence all disagree is worse than no
 * disguise at all. Identity is chosen once per account and never varied within it.
 */
public final class Fingerprint {

    // ------------------------------------------------------------------ profiles

    /** One coherent desktop: OS, Chrome build, platform hints, locale and timezone. */
    public static final class Profile {
        public final String id;
        public final String label;
        public final String os;
        public final String osVersion;
        public final String chromeMajor;
        public final String chromeFull;
        public final String platform;
        public final String platformVersion;
        public final String arch;
        public final String bitness;
        public final String model;
        public final String acceptLanguage;
        public final String timeZone;
        public final String viewport;

        Profile(String id, String label, String os, String osVersion, String chromeMajor,
                String chromeFull, String platform, String platformVersion, String arch,
                String bitness, String model, String acceptLanguage, String timeZone,
                String viewport) {
            this.id = id;
            this.label = label;
            this.os = os;
            this.osVersion = osVersion;
            this.chromeMajor = chromeMajor;
            this.chromeFull = chromeFull;
            this.platform = platform;
            this.platformVersion = platformVersion;
            this.arch = arch;
            this.bitness = bitness;
            this.model = model;
            this.acceptLanguage = acceptLanguage;
            this.timeZone = timeZone;
            this.viewport = viewport;
        }

        /** The exact User-Agent a matching Chrome build would send. */
        public String userAgent() {
            return "Mozilla/5.0 (" + platform + " " + platformVersion + ") AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/" + chromeFull + " Safari/537.36";
        }

        /** Reduced User-Agent, the form client hints actually negotiate. */
        public String userAgentReduced() {
            return "Mozilla/5.0 (" + platform + ") AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/" + chromeFull + " Safari/537.36";
        }
    }

    private static final Map<String, Profile> PROFILES = new LinkedHashMap<String, Profile>();

    static {
        PROFILES.put("win11", new Profile("win11", "Windows 11 · Chrome", "Windows", "11",
                "131", "131.0.6778.86", "Windows NT", "10.0", "x86", "64", "",
                "en-US,en;q=0.9", "America/New_York", "1920x1080"));
        PROFILES.put("mac14", new Profile("mac14", "macOS 14 · Chrome", "macOS", "14.5",
                "131", "131.0.6778.86", "Macintosh", "Intel Mac OS X 10_15_7", "x86", "64", "",
                "en-GB,en-US;q=0.9,en;q=0.8", "Europe/London", "1728x1117"));
        PROFILES.put("mac15_arm", new Profile("mac15_arm", "macOS 15 · Chrome (Apple silicon)",
                "macOS", "15.1", "131", "131.0.6778.86", "Macintosh", "Intel Mac OS X 10_15_7",
                "arm", "64", "", "en-US,en;q=0.9", "America/Los_Angeles", "1710x1112"));
        PROFILES.put("ubuntu", new Profile("ubuntu", "Ubuntu · Chrome", "Linux", "24.04",
                "131", "131.0.6778.86", "X11", "x86_64", "x86", "64", "",
                "en-US,en;q=0.9", "Europe/Berlin", "1920x1080"));
        PROFILES.put("win10", new Profile("win10", "Windows 10 · Chrome", "Windows", "10",
                "130", "130.0.6723.92", "Windows NT", "10.0", "x86", "64", "",
                "en-CA,en;q=0.9", "America/Toronto", "1536x864"));
    }

    private Fingerprint() {}

    public static Profile profile(String id) {
        Profile profile = PROFILES.get(id);
        return profile == null ? PROFILES.get("win11") : profile;
    }

    public static List<String> profileIds() {
        return new ArrayList<String>(PROFILES.keySet());
    }

    /**
     * A deterministic profile for an account name, so the same account always presents
     * the same desktop and different accounts do not all look like one machine.
     */
    public static Profile forAccount(String accountName) {
        List<String> ids = new ArrayList<String>(PROFILES.keySet());
        int index = Math.abs(accountName.hashCode()) % ids.size();
        return profile(ids.get(index));
    }

    public static Profile pick(List<String> preferred) {
        if (preferred == null || preferred.isEmpty()) {
            return forAccount("default");
        }
        String wanted = preferred.get(new java.util.Random().nextInt(preferred.size()));
        return profile(wanted);
    }

    // ------------------------------------------------------------------ header emission

    /**
     * Builds the outbound header set for a desktop-shaped request.
     *
     * <p>Order matters: real browsers send accept before accept-language, then the
     * sec-ch-ua triple, then sec-fetch-* last. Upstream services that fingerprint
     * clients read the sequence, not just the values.
     */
    public static Map<String, String> headers(Profile profile) {
        Map<String, String> headers = new LinkedHashMap<String, String>();
        headers.put("User-Agent", profile.userAgent());
        headers.put("sec-ch-ua", "\"Chromium\";v=\"" + profile.chromeMajor + "\", "
                + "\"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"" + profile.chromeMajor + "\"");
        headers.put("sec-ch-ua-mobile", "?0");
        headers.put("sec-ch-ua-platform", "\"" + profile.platform + "\"");
        return headers;
    }

    /** Navigation headers — the pair that marks a real document load. */
    public static Map<String, String> navigationHeaders(Profile profile) {
        Map<String, String> headers = headers(profile);
        headers.put("Accept-Language", profile.acceptLanguage);
        headers.put("Upgrade-Insecure-Requests", "1");
        headers.put("Sec-Fetch-Dest", "document");
        headers.put("Sec-Fetch-Mode", "navigate");
        headers.put("Sec-Fetch-Site", "none");
        headers.put("Sec-Fetch-User", "?1");
        return headers;
    }

    /** XHR/fetch headers — the shape an API call from a web app would carry. */
    public static Map<String, String> xhrHeaders(Profile profile) {
        Map<String, String> headers = headers(profile);
        headers.put("Accept", "application/json");
        headers.put("Accept-Language", profile.acceptLanguage);
        headers.put("Origin", "https://" + webOrigin(profile));
        headers.put("Referer", "https://" + webOrigin(profile) + "/");
        headers.put("Sec-Fetch-Dest", "empty");
        headers.put("Sec-Fetch-Mode", "cors");
        headers.put("Sec-Fetch-Site", "same-site");
        return headers;
    }

    /** The origin a matching desktop would have used for this profile's vendor console. */
    public static String webOrigin(Profile profile) {
        if (profile.os.startsWith("macOS")) {
            return "chatgpt.com";
        }
        if (profile.os.equals("Linux")) {
            return "claude.ai";
        }
        return "platform.openai.com";
    }

    /** Serialisable description, so the dashboard can show the active identity. */
    public static org.json.JSONObject describe(Profile profile) {
        try {
            return new org.json.JSONObject()
                    .put("id", profile.id)
                    .put("label", profile.label)
                    .put("os", profile.os + " " + profile.osVersion)
                    .put("user_agent", profile.userAgent())
                    .put("accept_language", profile.acceptLanguage)
                    .put("time_zone", profile.timeZone)
                    .put("viewport", profile.viewport)
                    .put("platform", profile.platform)
                    .put("origin", webOrigin(profile));
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }
}
