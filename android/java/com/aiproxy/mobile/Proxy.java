package com.aiproxy.mobile;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.util.Map;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Provider translation layer.
 *
 * <p>Everything the proxy accepts is OpenAI chat-completions shaped. This class
 * converts that to Anthropic Messages or Google {@code generateContent}, calls the
 * upstream, and converts the answer — including SSE frames — back to OpenAI shape,
 * so a client only ever sees one protocol no matter which account served it.
 */
public final class Proxy {

    private static final String TAG = "AIProxy";

    public static final class Result {
        public int status;
        public String body;
        public JSONObject json;
        public String error;
        public boolean retryable;
        public double latencyMs;
    }

    /** Receives translated OpenAI stream frames. */
    public interface StreamSink {
        void onChunk(String content);

        void onUsage(int tokensIn, int tokensOut);

        void onDone();
    }

    public static final class StreamFailure extends Exception {
        public final int status;
        public final boolean retryable;

        StreamFailure(String message, int status, boolean retryable) {
            super(message);
            this.status = status;
            this.retryable = retryable;
        }
    }

    private Proxy() {
    }

    // ------------------------------------------------------------------ dispatch

    public static Result chat(Account account, JSONObject request, String model, int timeoutMs)
            throws Exception {
        long started = System.currentTimeMillis();
        HttpURLConnection connection = open(account, request, model, false, timeoutMs);
        try {
            writeBody(connection, payload(account, request, model, false));
            int status = connection.getResponseCode();
            byte[] raw = readAll(status >= 400
                    ? connection.getErrorStream() : connection.getInputStream());
            String text = new String(raw, StandardCharsets.UTF_8);

            Result result = new Result();
            result.status = status;
            result.latencyMs = System.currentTimeMillis() - started;
            if (status >= 400) {
                result.error = upstreamError(text, status);
                result.retryable = retryable(status);
                return result;
            }
            JSONObject upstream = new JSONObject(text);
            if ("anthropic".equals(account.providerType)) {
                result.json = anthropicToOpenAI(upstream, model);
            } else if ("google".equals(account.providerType)) {
                result.json = googleToOpenAI(upstream, model);
            } else {
                result.json = upstream;
            }
            result.body = result.json.toString();
            return result;
        } finally {
            connection.disconnect();
        }
    }

    /** Stream a completion, pushing translated OpenAI chunks into {@code sink}. */
    public static void chatStream(Account account, JSONObject request, String model,
                                  StreamSink sink, int timeoutMs) throws Exception {
        HttpURLConnection connection = open(account, request, model, true, timeoutMs);
        try {
            writeBody(connection, payload(account, request, model, true));
            int status = connection.getResponseCode();
            if (status >= 400) {
                byte[] raw = readAll(connection.getErrorStream());
                throw new StreamFailure(upstreamError(new String(raw, StandardCharsets.UTF_8), status),
                        status, retryable(status));
            }
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), "UTF-8"));
            if ("anthropic".equals(account.providerType)) {
                streamAnthropic(reader, model, sink);
            } else if ("google".equals(account.providerType)) {
                streamGoogle(reader, model, sink);
            } else {
                streamOpenAI(reader, sink);
            }
            reader.close();
            sink.onDone();
        } finally {
            connection.disconnect();
        }
    }

    // ------------------------------------------------------------------ connections

    private static HttpURLConnection open(Account account, JSONObject request, String model,
                                          boolean stream, int timeoutMs) throws Exception {
        String url = endpoint(account, model, stream);

        // Each account leaves through its own exit and presents its own desktop identity,
        // so five keys on one provider never share an address or a fingerprint.
        Egress.Exit exit = account.egressExit();
        HttpURLConnection connection = exit.isDirect()
                ? (HttpURLConnection) new URL(url).openConnection()
                : (HttpURLConnection) new URL(url).openConnection(exit.toJavaProxy());
        if (!exit.isDirect() && exit.username != null && !exit.username.isEmpty()) {
            String credentials = exit.username + ":" + exit.password;
            connection.setRequestProperty("Proxy-Authorization", "Basic "
                    + android.util.Base64.encodeToString(credentials.getBytes(
                            StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
        }
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(stream ? timeoutMs : 60000);
        connection.setInstanceFollowRedirects(false);

        // Desktop client identity: an explicit override wins, otherwise the account's
        // pinned profile. Either way it is stable for the life of the account.
        Fingerprint.Profile profile = account.identityProfile();
        connection.setRequestProperty("User-Agent", account.userAgent != null
                && account.userAgent.length() > 0 ? account.userAgent : profile.userAgent());
        for (Map.Entry<String, String> header : Fingerprint.xhrHeaders(profile).entrySet()) {
            if (!"User-Agent".equals(header.getKey())) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
        }
        java.util.Iterator<String> extra = account.extraHeaders.keys();
        while (extra.hasNext()) {
            String name = extra.next();
            connection.setRequestProperty(name, account.extraHeaders.optString(name));
        }

        String type = account.providerType;
        if ("anthropic".equals(type)) {
            connection.setRequestProperty("x-api-key", account.apiKey);
            connection.setRequestProperty("anthropic-version", "2023-06-01");
        } else if ("google".equals(type)) {
            // Google takes the key in a header, never in the query string
            connection.setRequestProperty("x-goog-api-key", account.apiKey);
        } else {
            connection.setRequestProperty("Authorization", "Bearer " + account.apiKey);
        }
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", stream ? "text/event-stream" : "application/json");
        connection.setDoOutput(true);
        return connection;
    }

    private static String endpoint(Account account, String model, boolean stream) {
        String base = account.baseUrl;
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if ("anthropic".equals(account.providerType)) {
            return base + "/messages";
        }
        if ("google".equals(account.providerType)) {
            return base + "/models/" + model + (stream ? ":streamGenerateContent?alt=sse"
                    : ":generateContent");
        }
        return base + "/chat/completions";
    }

    private static void writeBody(HttpURLConnection connection, byte[] payload) throws Exception {
        // An explicit length, never chunked: a browser sending JSON declares Content-Length,
        // and upstreams that pre-read the body (stream gating, quota checks) need it.
        connection.setFixedLengthStreamingMode(payload.length);
        OutputStream out = connection.getOutputStream();
        try {
            out.write(payload);
            out.flush();
        } finally {
            out.close();
        }
    }

    // ------------------------------------------------------------------ request builders

    static byte[] payload(Account account, JSONObject request, String model, boolean stream)
            throws Exception {
        JSONObject body;
        if ("anthropic".equals(account.providerType)) {
            body = openAIToAnthropic(request, model, stream);
        } else if ("google".equals(account.providerType)) {
            body = openAIToGoogle(request, model, stream);
        } else {
            body = new JSONObject(request.toString());
            body.put("model", model);
            body.put("stream", stream);
        }
        return body.toString().getBytes(StandardCharsets.UTF_8);
    }

    static JSONObject openAIToAnthropic(JSONObject request, String model, boolean stream)
            throws Exception {
        JSONObject out = new JSONObject();
        out.put("model", model);
        out.put("max_tokens", request.optInt("max_tokens", request.optInt("max_completion_tokens", 4096)));
        out.put("stream", stream);

        StringBuilder system = new StringBuilder();
        JSONArray messages = new JSONArray();
        JSONArray input = request.optJSONArray("messages");
        if (input != null) {
            for (int i = 0; i < input.length(); i++) {
                JSONObject message = input.optJSONObject(i);
                if (message == null) {
                    continue;
                }
                String role = message.optString("role", "user");
                String text = flatten(message.opt("content"));
                if ("system".equals(role) || "developer".equals(role)) {
                    if (system.length() > 0) {
                        system.append("\n\n");
                    }
                    system.append(text);
                } else if ("assistant".equals(role)) {
                    messages.put(new JSONObject().put("role", "assistant").put("content", text));
                } else {
                    messages.put(new JSONObject().put("role", "user").put("content", text));
                }
            }
        }
        if (system.length() > 0) {
            out.put("system", system.toString());
        }
        if (messages.length() == 0) {
            messages.put(new JSONObject().put("role", "user").put("content", ""));
        }
        out.put("messages", messages);

        if (request.has("temperature")) {
            out.put("temperature", request.optDouble("temperature"));
        }
        if (request.has("top_p")) {
            out.put("top_p", request.optDouble("top_p"));
        }
        if (request.has("stop")) {
            Object stop = request.opt("stop");
            if (stop instanceof JSONArray && ((JSONArray) stop).length() > 0) {
                out.put("stop_sequences", stop);
            } else if (stop instanceof String && ((String) stop).length() > 0) {
                out.put("stop_sequences", new JSONArray().put(stop));
            }
        }
        return out;
    }

    static JSONObject openAIToGoogle(JSONObject request, String model, boolean stream)
            throws Exception {
        JSONObject out = new JSONObject();
        JSONArray contents = new JSONArray();

        StringBuilder system = new StringBuilder();
        JSONArray input = request.optJSONArray("messages");
        if (input != null) {
            for (int i = 0; i < input.length(); i++) {
                JSONObject message = input.optJSONObject(i);
                if (message == null) {
                    continue;
                }
                String role = message.optString("role", "user");
                String text = flatten(message.opt("content"));
                if ("system".equals(role) || "developer".equals(role)) {
                    if (system.length() > 0) {
                        system.append("\n\n");
                    }
                    system.append(text);
                    continue;
                }
                contents.put(new JSONObject()
                        .put("role", "assistant".equals(role) ? "model" : "user")
                        .put("parts", new JSONArray().put(new JSONObject().put("text", text))));
            }
        }
        if (contents.length() == 0) {
            contents.put(new JSONObject().put("role", "user")
                    .put("parts", new JSONArray().put(new JSONObject().put("text", ""))));
        }
        out.put("contents", contents);

        if (system.length() > 0) {
            out.put("systemInstruction", new JSONObject()
                    .put("parts", new JSONArray().put(new JSONObject().put("text", system.toString()))));
        }
        JSONObject config = new JSONObject();
        if (request.has("temperature")) {
            config.put("temperature", request.optDouble("temperature"));
        }
        if (request.has("top_p")) {
            config.put("topP", request.optDouble("top_p"));
        }
        if (request.has("max_tokens")) {
            config.put("maxOutputTokens", request.optInt("max_tokens"));
        }
        if (config.length() > 0) {
            out.put("generationConfig", config);
        }
        return out;
    }

    /** OpenAI content may be a string, or an array of typed parts. */
    static String flatten(Object content) {
        if (content == null || content == JSONObject.NULL) {
            return "";
        }
        if (content instanceof String) {
            return (String) content;
        }
        if (content instanceof JSONArray) {
            JSONArray array = (JSONArray) content;
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < array.length(); i++) {
                Object part = array.opt(i);
                if (part instanceof JSONObject) {
                    JSONObject piece = (JSONObject) part;
                    if ("text".equals(piece.optString("type")) || piece.has("text")) {
                        if (out.length() > 0) {
                            out.append(' ');
                        }
                        out.append(piece.optString("text"));
                    }
                } else if (part != null && part != JSONObject.NULL) {
                    if (out.length() > 0) {
                        out.append('\n');
                    }
                    out.append(part.toString());
                }
            }
            return out.toString();
        }
        return content.toString();
    }

    // ------------------------------------------------------------------ response translators

    static JSONObject anthropicToOpenAI(JSONObject upstream, String model) throws Exception {
        StringBuilder text = new StringBuilder();
        JSONArray blocks = upstream.optJSONArray("content");
        if (blocks != null) {
            for (int i = 0; i < blocks.length(); i++) {
                JSONObject block = blocks.optJSONObject(i);
                if (block != null && "text".equals(block.optString("type"))) {
                    text.append(block.optString("text"));
                }
            }
        }
        JSONObject usage = upstream.optJSONObject("usage");
        int tokensIn = usage == null ? 0 : usage.optInt("input_tokens");
        int tokensOut = usage == null ? 0 : usage.optInt("output_tokens");

        return new JSONObject()
                .put("id", upstream.optString("id", "chatcmpl-" + System.currentTimeMillis()))
                .put("object", "chat.completion")
                .put("created", System.currentTimeMillis() / 1000L)
                .put("model", upstream.optString("model", model))
                .put("choices", new JSONArray().put(new JSONObject()
                        .put("index", 0)
                        .put("message", new JSONObject()
                                .put("role", "assistant")
                                .put("content", text.toString()))
                        .put("finish_reason", translateStop(upstream.optString("stop_reason")))))
                .put("usage", new JSONObject()
                        .put("prompt_tokens", tokensIn)
                        .put("completion_tokens", tokensOut)
                        .put("total_tokens", tokensIn + tokensOut));
    }

    static JSONObject googleToOpenAI(JSONObject upstream, String model) throws Exception {
        StringBuilder text = new StringBuilder();
        String finish = "stop";
        JSONArray candidates = upstream.optJSONArray("candidates");
        if (candidates != null && candidates.length() > 0) {
            JSONObject candidate = candidates.optJSONObject(0);
            JSONObject content = candidate == null ? null : candidate.optJSONObject("content");
            JSONArray parts = content == null ? null : content.optJSONArray("parts");
            if (parts != null) {
                for (int i = 0; i < parts.length(); i++) {
                    JSONObject part = parts.optJSONObject(i);
                    if (part != null && part.has("text")) {
                        text.append(part.optString("text"));
                    }
                }
            }
            if (candidate != null) {
                String reason = candidate.optString("finishReason");
                if (reason.length() > 0 && !"STOP".equals(reason)) {
                    finish = reason.toLowerCase(java.util.Locale.US);
                }
            }
        }
        JSONObject usage = upstream.optJSONObject("usageMetadata");
        int tokensIn = usage == null ? 0 : usage.optInt("promptTokenCount");
        int tokensOut = usage == null ? 0 : usage.optInt("candidatesTokenCount");

        return new JSONObject()
                .put("id", "chatcmpl-" + System.currentTimeMillis())
                .put("object", "chat.completion")
                .put("created", System.currentTimeMillis() / 1000L)
                .put("model", model)
                .put("choices", new JSONArray().put(new JSONObject()
                        .put("index", 0)
                        .put("message", new JSONObject()
                                .put("role", "assistant")
                                .put("content", text.toString()))
                        .put("finish_reason", finish)))
                .put("usage", new JSONObject()
                        .put("prompt_tokens", tokensIn)
                        .put("completion_tokens", tokensOut)
                        .put("total_tokens", tokensIn + tokensOut));
    }

    private static String translateStop(String reason) {
        if ("end_turn".equals(reason) || "stop_sequence".equals(reason) || reason.length() == 0) {
            return "stop";
        }
        if ("max_tokens".equals(reason)) {
            return "length";
        }
        if ("tool_use".equals(reason)) {
            return "tool_calls";
        }
        return reason;
    }

    // ------------------------------------------------------------------ stream translators

    /** SseFrame is one decoded server-sent event. */
    static final class SseFrame {
        String event;
        String data;
    }

    static List<SseFrame> readFrames(BufferedReader reader) throws Exception {
        List<SseFrame> frames = new ArrayList<SseFrame>();
        String event = null;
        StringBuilder data = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty()) {
                if (data.length() > 0) {
                    SseFrame frame = new SseFrame();
                    frame.event = event;
                    frame.data = data.toString();
                    frames.add(frame);
                }
                event = null;
                data.setLength(0);
                continue;
            }
            if (line.startsWith(":")) {
                continue;                       // heartbeat
            }
            if (line.startsWith("event:")) {
                event = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
                if (data.length() > 0) {
                    data.append('\n');
                }
                data.append(line.substring(5).trim());
            }
        }
        if (data.length() > 0) {
            SseFrame frame = new SseFrame();
            frame.event = event;
            frame.data = data.toString();
            frames.add(frame);
        }
        return frames;
    }

    private static void streamOpenAI(BufferedReader reader, StreamSink sink) throws Exception {
        for (SseFrame frame : readFrames(reader)) {
            if ("[DONE]".equals(frame.data)) {
                break;
            }
            JSONObject chunk;
            try {
                chunk = new JSONObject(frame.data);
            } catch (Exception exc) {
                continue;
            }
            if (chunk.has("error")) {
                throw new StreamFailure(chunk.optJSONObject("error").optString("message"),
                        502, true);
            }
            JSONArray choices = chunk.optJSONArray("choices");
            if (choices != null && choices.length() > 0) {
                JSONObject delta = choices.getJSONObject(0).optJSONObject("delta");
                if (delta != null) {
                    String content = delta.optString("content");
                    if (content.length() > 0) {
                        sink.onChunk(content);
                    }
                }
            }
            JSONObject usage = chunk.optJSONObject("usage");
            if (usage != null) {
                sink.onUsage(usage.optInt("prompt_tokens"), usage.optInt("completion_tokens"));
            }
        }
    }

    private static void streamAnthropic(BufferedReader reader, String model, StreamSink sink)
            throws Exception {
        int tokensIn = 0;
        int tokensOut = 0;
        for (SseFrame frame : readFrames(reader)) {
            String type = frame.event;
            if (type == null || type.isEmpty()) {
                try {
                    type = new JSONObject(frame.data).optString("type");
                } catch (Exception exc) {
                    continue;
                }
            }
            try {
                JSONObject event = new JSONObject(frame.data);
                if ("message_start".equals(type)) {
                    JSONObject message = event.optJSONObject("message");
                    JSONObject usage = message == null ? null : message.optJSONObject("usage");
                    if (usage != null) {
                        tokensIn = usage.optInt("input_tokens");
                    }
                } else if ("content_block_delta".equals(type)) {
                    JSONObject delta = event.optJSONObject("delta");
                    String text = delta == null ? "" : delta.optString("text");
                    if (text.length() > 0) {
                        sink.onChunk(text);
                    }
                } else if ("message_delta".equals(type)) {
                    JSONObject usage = event.optJSONObject("usage");
                    if (usage != null && usage.has("output_tokens")) {
                        tokensOut = usage.optInt("output_tokens");
                    }
                } else if ("error".equals(type)) {
                    throw new StreamFailure(event.optJSONObject("error") == null
                            ? "stream error" : event.getJSONObject("error").optString("message"),
                            502, true);
                }
            } catch (StreamFailure failure) {
                throw failure;
            } catch (Exception exc) {
                continue;
            }
        }
        sink.onUsage(tokensIn, tokensOut);
    }

    private static void streamGoogle(BufferedReader reader, String model, StreamSink sink)
            throws Exception {
        for (SseFrame frame : readFrames(reader)) {
            if ("[DONE]".equals(frame.data)) {
                break;
            }
            try {
                JSONObject event = new JSONObject(frame.data);
                if (event.has("error")) {
                    throw new StreamFailure(event.optJSONObject("error").optString("message",
                            "upstream stream error"), 502, true);
                }
                JSONArray candidates = event.optJSONArray("candidates");
                if (candidates != null && candidates.length() > 0) {
                    JSONObject candidate = candidates.getJSONObject(0);
                    JSONObject content = candidate.optJSONObject("content");
                    JSONArray parts = content == null ? null : content.optJSONArray("parts");
                    if (parts != null) {
                        for (int i = 0; i < parts.length(); i++) {
                            JSONObject part = parts.optJSONObject(i);
                            if (part != null && part.has("text")) {
                                String text = part.optString("text");
                                if (text.length() > 0) {
                                    sink.onChunk(text);
                                }
                            }
                        }
                    }
                }
                JSONObject usage = event.optJSONObject("usageMetadata");
                if (usage != null) {
                    sink.onUsage(usage.optInt("promptTokenCount"),
                            usage.optInt("candidatesTokenCount"));
                }
            } catch (StreamFailure failure) {
                throw failure;
            } catch (Exception exc) {
                continue;
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    static boolean retryable(int status) {
        return status == 408 || status == 409 || status == 425 || status == 429
                || status == 500 || status == 502 || status == 503 || status == 504
                || status == 529;
    }

    static String upstreamError(String text, int status) {
        try {
            JSONObject payload = new JSONObject(text);
            JSONObject error = payload.optJSONObject("error");
            if (error != null && error.optString("message").length() > 0) {
                return error.optString("message");
            }
            JSONArray candidates = payload.optJSONArray("candidates");
            if (candidates != null && candidates.length() == 0) {
                JSONObject blocked = payload.optJSONObject("promptFeedback");
                if (blocked != null) {
                    return "upstream returned no candidates: " + blocked.optString("blockReason");
                }
                return "upstream returned no candidates";
            }
        } catch (Exception ignored) {
            // fall through to the raw body
        }
        if (text != null && text.trim().length() > 0 && text.length() < 400) {
            return text.trim();
        }
        return "upstream returned HTTP " + status;
    }

    static byte[] readAll(InputStream stream) throws Exception {
        if (stream == null) {
            return new byte[0];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            out.write(chunk, 0, read);
        }
        stream.close();
        return out.toByteArray();
    }

    static void log(String message) {
        Log.d(TAG, message);
    }
}