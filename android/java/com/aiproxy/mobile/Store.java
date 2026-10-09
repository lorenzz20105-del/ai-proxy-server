package com.aiproxy.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * SQLite persistence plus the in-memory registry the router reads.
 *
 * <p>Everything the dashboard can configure lives here: accounts, keys, aliases,
 * routing, budget and the request log. Writes hit the database on the calling
 * (background) thread; the registry is guarded so admin edits are immediately
 * visible to in-flight routing.
 */
public final class Store extends SQLiteOpenHelper {

    private static final String DB_NAME = "aiproxy.db";

    private static Store instance;

    /**
     * Master key handed to the admin API and the bundled console.
     *
     * <p>A fixed value on purpose: the proxy binds loopback only, and the console
     * must clear its key gate on first launch with nothing to type. Matches the
     * backend's {@code DEFAULT_MASTER_KEY} so both engines accept one known key.
     */
    public static final String DEFAULT_MASTER_KEY = "sk-proxy-default-master-key";

    private final Map<String, Account> accounts = new LinkedHashMap<>();
    private final Map<String, String> aliases = new LinkedHashMap<>();
    private final Map<String, String> keys = new LinkedHashMap<>();

    private final Object lock = new Object();

    // routing + budget config, persisted as JSON blobs
    private JSONObject routing = defaultRouting();
    private JSONObject budget = defaultBudget();
    private String masterKey;

    public static synchronized Store get(Context context) {
        if (instance == null) {
            instance = new Store(context.getApplicationContext());
        }
        return instance;
    }

    private Store(Context context) {
        super(context, DB_NAME, null, 1);
        getWritableDatabase();
        load();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE accounts (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
        db.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE keys (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
        db.execSQL("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + " ts REAL, request_id TEXT, model TEXT, requested_model TEXT,"
                + " account TEXT, status INTEGER, attempts INTEGER, latency_ms REAL,"
                + " ttft_ms REAL, stream INTEGER, cached INTEGER, prompt_tokens INTEGER,"
                + " completion_tokens INTEGER, cost_usd REAL, error TEXT, kind TEXT,"
                + " method TEXT, path TEXT, location TEXT)");
        db.execSQL("CREATE INDEX idx_logs_ts ON logs(ts)");
        db.execSQL("CREATE TABLE usage_hourly (bucket TEXT, account TEXT, model TEXT,"
                + " requests INTEGER, errors INTEGER, tokens_in INTEGER,"
                + " tokens_out INTEGER, cost_usd REAL, latency_sum REAL, latency_n INTEGER)");
        db.execSQL("CREATE TABLE probe (account TEXT PRIMARY KEY, ok INTEGER,"
                + " latency_ms REAL, detail TEXT, ts REAL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS accounts");
        db.execSQL("DROP TABLE IF EXISTS kv");
        db.execSQL("DROP TABLE IF EXISTS keys");
        db.execSQL("DROP TABLE IF EXISTS logs");
        db.execSQL("DROP TABLE IF EXISTS usage_hourly");
        db.execSQL("DROP TABLE IF EXISTS probe");
        onCreate(db);
    }

    // ------------------------------------------------------------------ kv

    private void putKv(String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        getWritableDatabase().replace("kv", null, values);
    }

    private String getKv(String key) {
        Cursor cursor = getReadableDatabase().query("kv", new String[]{"value"},
                "key = ?", new String[]{key}, null, null, null);
        try {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        } finally {
            cursor.close();
        }
    }

    private void load() {
        SQLiteDatabase db = getReadableDatabase();

        Cursor cursor = db.query("accounts", new String[]{"name", "data"},
                null, null, null, null, "name");
        try {
            while (cursor.moveToNext()) {
                try {
                    Account account = Account.fromJSON(new JSONObject(cursor.getString(1)));
                    accounts.put(account.name, account);
                } catch (Exception ignored) {
                    // skip a row we cannot parse rather than losing the whole registry
                }
            }
        } finally {
            cursor.close();
        }

        cursor = db.query("keys", new String[]{"name", "data"}, null, null, null, null, "name");
        try {
            while (cursor.moveToNext()) {
                try {
                    JSONObject value = new JSONObject(cursor.getString(1));
                    keys.put(value.optString("key"), value.optString("name"));
                } catch (Exception ignored) {
                    // same tolerance as accounts
                }
            }
        } finally {
            cursor.close();
        }

        // Fixed, documented default so the console is usable the moment the app
        // opens — no generated key to hunt for. The server binds loopback only
        // (127.0.0.1), never an external interface. Change the constant to roll
        // a private key; the value is mirrored into the kv table for display.
        masterKey = DEFAULT_MASTER_KEY;
        putKv("master_key", masterKey);

        String routingJson = getKv("routing");
        if (routingJson != null) {
            try {
                routing = new JSONObject(routingJson);
            } catch (Exception ignored) {
                routing = defaultRouting();
            }
        }
        String budgetJson = getKv("budget");
        if (budgetJson != null) {
            try {
                budget = new JSONObject(budgetJson);
            } catch (Exception ignored) {
                budget = defaultBudget();
            }
        }
        String aliasJson = getKv("aliases");
        if (aliasJson != null) {
            try {
                JSONObject parsed = new JSONObject(aliasJson);
                java.util.Iterator<String> it = parsed.keys();
                while (it.hasNext()) {
                    String name = it.next();
                    aliases.put(name, parsed.optJSONArray(name) == null ? ""
                            : parsed.getJSONArray(name).toString());
                }
            } catch (Exception ignored) {
                aliases.clear();
            }
        }
    }

    private static JSONObject defaultRouting() {
        try {
            return new JSONObject()
                    .put("strategy", "round_robin")
                    .put("model_matching", "exact")
                    .put("retry", new JSONObject()
                            .put("max_attempts", 3)
                            .put("backoff_seconds", 0.35)
                            .put("max_backoff_seconds", 4.0)
                            .put("jitter", true)
                            .put("retry_status_codes", new JSONArray("[408,429,500,502,503,504,529]")))
                    .put("circuit_breaker", new JSONObject()
                            .put("failure_threshold", 5)
                            .put("success_threshold", 2)
                            .put("cooldown_seconds", 45)
                            .put("half_open_max_concurrency", 1))
                    .put("session_affinity", new JSONObject()
                            .put("enabled", true)
                            .put("ttl_seconds", 1800)
                            .put("header", "x-session-id"))
                    .put("cache", new JSONObject()
                            .put("enabled", true)
                            .put("ttl_seconds", 300)
                            .put("max_entries", 2000)
                            .put("deterministic_only", true));
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    private static JSONObject defaultBudget() {
        try {
            return new JSONObject().put("daily_usd", 0).put("monthly_usd", JSONObject.NULL)
                    .put("hard_stop", true).put("alerts", new JSONArray());
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    // ------------------------------------------------------------------ accounts

    public List<Account> accounts() {
        synchronized (lock) {
            return new ArrayList<>(accounts.values());
        }
    }

    public Account account(String name) {
        synchronized (lock) {
            return accounts.get(name);
        }
    }

    public void saveAccount(Account account) {
        synchronized (lock) {
            accounts.put(account.name, account);
            ContentValues values = new ContentValues();
            values.put("name", account.name);
            try {
                values.put("data", account.toJSON(true).toString());
            } catch (Exception exc) {
                throw new IllegalStateException(exc);
            }
            getWritableDatabase().replace("accounts", null, values);
        }
    }

    public void deleteAccount(String name) {
        synchronized (lock) {
            accounts.remove(name);
            getWritableDatabase().delete("accounts", "name = ?", new String[]{name});
        }
    }

    public boolean hasAccounts() {
        synchronized (lock) {
            return !accounts.isEmpty();
        }
    }

    // ------------------------------------------------------------------ keys

    public boolean isValidKey(String candidate) {
        if (candidate == null || candidate.isEmpty()) {
            return false;
        }
        synchronized (lock) {
            return masterKey.equals(candidate) || keys.containsKey(candidate);
        }
    }

    public String keyName(String candidate) {
        if (masterKey.equals(candidate)) {
            return "master";
        }
        synchronized (lock) {
            String name = keys.get(candidate);
            return name == null ? "" : name;
        }
    }

    public String masterKey() {
        return masterKey;
    }

    public String maskKey(String key) {
        if (key == null || key.length() < 10) {
            return "****";
        }
        return key.substring(0, Math.min(8, key.length())) + "…" + key.substring(key.length() - 4);
    }

    public JSONObject keysJSON() {
        JSONArray out = new JSONArray();
        Cursor cursor = getReadableDatabase().query("keys", new String[]{"data"},
                null, null, null, null, "name");
        try {
            while (cursor.moveToNext()) {
                try {
                    JSONObject record = new JSONObject(cursor.getString(0));
                    // A key is shown once, at creation. The list only ever carries the mask.
                    record.remove("key");
                    out.put(record);
                } catch (Exception ignored) {
                    // skip a malformed key row
                }
            }
        } finally {
            cursor.close();
        }
        try {
            return new JSONObject().put("keys", out);
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    /** The configured proxy pool, in priority order. */
    public JSONArray egressPool() {
        String raw = getKv("egress_pool");
        if (raw == null || raw.isEmpty()) {
            return new JSONArray();
        }
        try {
            return new JSONArray(raw);
        } catch (Exception exc) {
            return new JSONArray();
        }
    }

    public void egressPool(JSONArray pool) {
        putKv("egress_pool", pool == null ? "[]" : pool.toString());
    }

    /** Total USD recorded in the request log over the trailing window, in seconds. */
    public double spentUsd(long windowSeconds) {
        double since = System.currentTimeMillis() / 1000.0 - windowSeconds;
        android.database.Cursor cursor = getReadableDatabase()
                .rawQuery("SELECT COALESCE(SUM(cost_usd), 0) FROM logs WHERE ts >= ?",
                        new String[]{String.valueOf(since)});
        try {
            return cursor.moveToNext() ? cursor.getDouble(0) : 0;
        } finally {
            cursor.close();
        }
    }

    public void createKey(JSONObject record) {
        synchronized (lock) {
            keys.put(record.optString("key"), record.optString("name"));
            ContentValues values = new ContentValues();
            values.put("name", record.optString("name"));
            values.put("data", record.toString());
            getWritableDatabase().replace("keys", null, values);
        }
    }

    public void deleteKey(String name) {
        synchronized (lock) {
            java.util.Iterator<Map.Entry<String, String>> it = keys.entrySet().iterator();
            while (it.hasNext()) {
                if (it.next().getValue().equals(name)) {
                    it.remove();
                }
            }
            getWritableDatabase().delete("keys", "name = ?", new String[]{name});
        }
    }

    // ------------------------------------------------------------------ config

    public JSONObject routing() {
        synchronized (lock) {
            return routing;
        }
    }

    public void routing(JSONObject value) {
        synchronized (lock) {
            routing = value;
            putKv("routing", value.toString());
        }
    }

    public JSONObject budget() {
        synchronized (lock) {
            return budget;
        }
    }

    public void budget(JSONObject value) {
        synchronized (lock) {
            budget = value;
            putKv("budget", value.toString());
        }
    }

    public Map<String, String> aliases() {
        synchronized (lock) {
            return new LinkedHashMap<>(aliases);
        }
    }

    public void putAlias(String alias, JSONArray targets) {
        synchronized (lock) {
            aliases.put(alias, targets.toString());
            persistAliases();
        }
    }

    public void deleteAlias(String alias) {
        synchronized (lock) {
            aliases.remove(alias);
            persistAliases();
        }
    }

    private void persistAliases() {
        try {
            JSONObject out = new JSONObject();
            for (Map.Entry<String, String> entry : aliases.entrySet()) {
                out.put(entry.getKey(), new JSONArray(entry.getValue()));
            }
            putKv("aliases", out.toString());
        } catch (Exception exc) {
            throw new IllegalStateException(exc);
        }
    }

    // ------------------------------------------------------------------ logging

    public void logRequest(JSONObject entry) {
        ContentValues values = new ContentValues();
        values.put("ts", entry.optDouble("ts", System.currentTimeMillis() / 1000.0));
        values.put("request_id", entry.optString("id"));
        values.put("model", entry.optString("model"));
        values.put("requested_model", entry.optString("requested_model"));
        values.put("account", entry.optString("account"));
        values.put("status", entry.optInt("status"));
        values.put("attempts", entry.optInt("attempts", 1));
        values.put("latency_ms", entry.optDouble("latency_ms"));
        values.put("ttft_ms", entry.optDouble("ttft_ms"));
        values.put("stream", entry.optBoolean("stream") ? 1 : 0);
        values.put("cached", entry.optBoolean("cached") ? 1 : 0);
        values.put("prompt_tokens", entry.optInt("prompt_tokens"));
        values.put("completion_tokens", entry.optInt("completion_tokens"));
        values.put("cost_usd", entry.optDouble("cost_usd"));
        values.put("error", entry.optString("error"));
        values.put("kind", entry.optString("kind", "request"));
        values.put("method", entry.optString("method"));
        values.put("path", entry.optString("path"));
        values.put("location", entry.optString("location"));
        getWritableDatabase().insert("logs", null, values);

        JSONObject usage = new JSONObject();
        try {
            usage.put("bucket", bucket(System.currentTimeMillis() / 1000.0, 3600))
                    .put("account", entry.optString("account"))
                    .put("model", entry.optString("model"))
                    .put("requests", 1)
                    .put("errors", entry.optInt("status") >= 400 ? 1 : 0)
                    .put("tokens_in", entry.optInt("prompt_tokens"))
                    .put("tokens_out", entry.optInt("completion_tokens"))
                    .put("cost_usd", entry.optDouble("cost_usd"))
                    .put("latency_sum", entry.optDouble("latency_ms"))
                    .put("latency_n", 1);
        } catch (Exception exc) {
            return;
        }
        ContentValues row = new ContentValues();
        row.put("bucket", usage.optString("bucket"));
        row.put("account", usage.optString("account"));
        row.put("model", usage.optString("model"));
        row.put("requests", usage.optInt("requests"));
        row.put("errors", usage.optInt("errors"));
        row.put("tokens_in", usage.optInt("tokens_in"));
        row.put("tokens_out", usage.optInt("tokens_out"));
        row.put("cost_usd", usage.optDouble("cost_usd"));
        row.put("latency_sum", usage.optDouble("latency_sum"));
        row.put("latency_n", usage.optInt("latency_n"));
        getWritableDatabase().insertWithOnConflict("usage_hourly", null, row,
                SQLiteDatabase.CONFLICT_REPLACE);

        Events.publish(entry);
    }

    public static String bucket(double ts, int seconds) {
        long hour = (long) (ts / seconds) * seconds;
        return String.format(Locale.US, "%d", hour);
    }

    public int clearLogs() {
        int count = countLogs();
        getWritableDatabase().delete("logs", null, null);
        getWritableDatabase().delete("usage_hourly", null, null);
        return count;
    }

    public int countLogs() {
        Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM logs", null);
        try {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } finally {
            cursor.close();
        }
    }

    // ------------------------------------------------------------------ probes

    public void recordProbe(String account, boolean ok, double latencyMs, String detail) {
        ContentValues values = new ContentValues();
        values.put("account", account);
        values.put("ok", ok ? 1 : 0);
        values.put("latency_ms", latencyMs);
        values.put("detail", detail);
        values.put("ts", System.currentTimeMillis() / 1000.0);
        getWritableDatabase().replace("probe", null, values);
    }

    public Map<String, JSONObject> probes() {
        Map<String, JSONObject> out = new LinkedHashMap<>();
        Cursor cursor = getReadableDatabase().query("probe",
                new String[]{"account", "ok", "latency_ms", "detail", "ts"},
                null, null, null, null, null);
        try {
            while (cursor.moveToNext()) {
                try {
                    out.put(cursor.getString(0), new JSONObject()
                            .put("ok", cursor.getInt(1) == 1)
                            .put("latency_ms", cursor.getDouble(2))
                            .put("detail", cursor.getString(3))
                            .put("ts", cursor.getDouble(4)));
                } catch (Exception ignored) {
                    // skip malformed probe rows
                }
            }
        } finally {
            cursor.close();
        }
        return out;
    }
}