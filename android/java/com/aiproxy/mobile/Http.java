package com.aiproxy.mobile;

import android.content.res.AssetManager;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Minimal HTTP/1.1 server. The app runs the proxy in-process so it works the moment
 * it is opened — no Termux, no separate service, no configuration.
 *
 * <p>Deliberately hand-rolled: the Android framework ships no server and pulling in
 * NanoHTTPD/Netty would violate the zero-dependency build.
 */
public final class Http {

    public interface Handler {
        void handle(Req req, Res res) throws Exception;
    }

    public static final class Req {
        public final String method;
        public final String path;
        public final Map<String, String> query;
        public final Map<String, String> headers;
        public final byte[] body;
        public final String remote;

        Req(String method, String path, Map<String, String> query,
            Map<String, String> headers, byte[] body, String remote) {
            this.method = method;
            this.path = path;
            this.query = query;
            this.headers = headers;
            this.body = body;
            this.remote = remote;
        }

        public String header(String name) {
            return headers.get(name.toLowerCase(Locale.US));
        }

        public String param(String name) {
            return query.get(name);
        }

        public String bodyText() {
            return new String(body, StandardCharsets.UTF_8);
        }

        public boolean isStreamRequest() {
            return "chunked".equalsIgnoreCase(header("transfer-encoding"));
        }
    }

    public static final class Res {
        private final OutputStream raw;
        private boolean sent;
        private int status = 200;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private boolean streaming;

        Res(OutputStream raw) {
            this.raw = raw;
        }

        public Res header(String name, String value) {
            headers.put(name, value);
            return this;
        }

        public Res status(int code) {
            this.status = code;
            return this;
        }

        public boolean sent() {
            return sent;
        }

        public void json(int code, Object payload) {
            byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
            header("Content-Type", "application/json; charset=utf-8");
            send(code, data);
        }

        public void text(int code, String body) {
            header("Content-Type", "text/plain; charset=utf-8");
            send(code, body.getBytes(StandardCharsets.UTF_8));
        }

        public void bytes(int code, byte[] data, String mime) {
            header("Content-Type", mime);
            send(code, data);
        }

        public void redirect(String location) {
            header("Location", location);
            text(302, "");
        }

        public void send(int code, byte[] data) {
            if (sent) {
                return;
            }
            status = code;
            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                head.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
            }
            head.append("Content-Length: ").append(data.length).append("\r\n");
            head.append("Connection: close\r\n\r\n");
            write(head.toString().getBytes(StandardCharsets.UTF_8));
            write(data);
            flush();
            sent = true;
        }

        /** Switch to chunked SSE mode; afterwards use {@link #event} and {@link #endStream}. */
        public void beginStream(String contentType) {
            if (sent) {
                return;
            }
            streaming = true;
            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 200 OK\r\n");
            head.append("Content-Type: ").append(contentType).append("\r\n");
            head.append("Cache-Control: no-cache, no-transform\r\n");
            head.append("Connection: close\r\n");
            head.append("X-Accel-Buffering: no\r\n\r\n");
            write(head.toString().getBytes(StandardCharsets.UTF_8));
            flush();
            sent = true;
        }

        public void raw(String frame) {
            write(frame.getBytes(StandardCharsets.UTF_8));
            flush();
        }

        public void event(String name, String data) {
            StringBuilder frame = new StringBuilder();
            if (name != null && name.length() > 0) {
                frame.append("event: ").append(name).append('\n');
            }
            for (String line : data.split("\n", -1)) {
                frame.append("data: ").append(line).append('\n');
            }
            frame.append('\n');
            raw(frame.toString());
        }

        public void comment(String text) {
            raw(": " + text + "\n\n");
        }

        public void endStream() {
            if (streaming) {
                raw("data: [DONE]\n\n");
            }
            flush();
        }

        private void write(byte[] data) {
            try {
                raw.write(data);
            } catch (IOException ignored) {
                // client hung up mid-write
            }
        }

        private void flush() {
            try {
                raw.flush();
            } catch (IOException ignored) {
                // client hung up
            }
        }
    }

    public interface Lifecycle {
        void onListening(int port);
    }

    private static final int MAX_BODY = 32 * 1024 * 1024;

    private final ExecutorService workers = Executors.newFixedThreadPool(24);
    private final AtomicBoolean running = new AtomicBoolean();
    private ServerSocket socket;
    private Thread acceptor;

    public void start(String bindHost, int preferredPort, Handler handler,
                      Lifecycle lifecycle) throws IOException {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(bindHost, preferredPort), 128);
        final int port = socket.getLocalPort();
        if (lifecycle != null) {
            lifecycle.onListening(port);
        }
        acceptor = new Thread(new Runnable() {
            @Override
            public void run() {
                accept(port, handler);
            }
        }, "http-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    private void accept(final int port, final Handler handler) {
        while (running.get()) {
            final Socket client;
            try {
                client = socket.accept();
            } catch (IOException exc) {
                if (running.get()) {
                    continue;
                }
                return;
            }
            workers.execute(new Runnable() {
                @Override
                public void run() {
                    serve(client, handler);
                }
            });
        }
    }

    private void serve(Socket client, Handler handler) {
        try {
            client.setTcpNoDelay(true);
            client.setSoTimeout(120000);
            InputStream in = client.getInputStream();
            OutputStream out = new BufferedOutputStream(client.getOutputStream(), 16384);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                client.close();
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                client.close();
                return;
            }
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                            line.substring(colon + 1).trim());
                }
            }

            byte[] body = readBody(in, headers);

            String path = target;
            Map<String, String> query = new LinkedHashMap<>();
            int mark = target.indexOf('?');
            if (mark >= 0) {
                path = target.substring(0, mark);
                query = parseQuery(target.substring(mark + 1));
            }
            path = decode(path);

            Req req = new Req(method, path, query, headers, body,
                    client.getInetAddress().getHostAddress());
            Res res = new Res(out);
            try {
                handler.handle(req, res);
            } catch (Exception exc) {
                if (!res.sent()) {
                    res.json(500, "{\"error\":{\"message\":\"" + escape(String.valueOf(exc.getMessage()))
                            + "\",\"type\":\"internal_error\"}}");
                }
            }
            try {
                out.flush();
            } catch (IOException ignored) {
                // nothing left to flush to
            }
        } catch (Exception ignored) {
            // malformed request or dropped socket — nothing useful to report
        } finally {
            try {
                client.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    private static byte[] readBody(InputStream in, Map<String, String> headers) throws IOException {
        String encoding = headers.get("transfer-encoding");
        if (encoding != null && encoding.toLowerCase(Locale.US).contains("chunked")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            while (true) {
                String sizeLine = readLine(in);
                if (sizeLine == null) {
                    break;
                }
                int semi = sizeLine.indexOf(';');
                if (semi >= 0) {
                    sizeLine = sizeLine.substring(0, semi);
                }
                int size;
                try {
                    size = Integer.parseInt(sizeLine.trim(), 16);
                } catch (NumberFormatException exc) {
                    break;
                }
                if (size == 0) {
                    readLine(in);
                    break;
                }
                byte[] chunk = new byte[size];
                readFully(in, chunk);
                buffer.write(chunk);
                readLine(in);
                if (buffer.size() > MAX_BODY) {
                    break;
                }
            }
            return buffer.toByteArray();
        }
        String length = headers.get("content-length");
        if (length == null) {
            return new byte[0];
        }
        int size;
        try {
            size = Integer.parseInt(length.trim());
        } catch (NumberFormatException exc) {
            return new byte[0];
        }
        if (size <= 0 || size > MAX_BODY) {
            return new byte[0];
        }
        byte[] body = new byte[size];
        readFully(in, body);
        return body;
    }

    private static void readFully(InputStream in, byte[] buffer) throws IOException {
        int read = 0;
        while (read < buffer.length) {
            int n = in.read(buffer, read, buffer.length - read);
            if (n < 0) {
                throw new IOException("unexpected end of stream");
            }
            read += n;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') {
                break;
            }
            if (c != '\r') {
                buffer.write(c);
            }
        }
        if (c == -1 && buffer.size() == 0) {
            return null;
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    public static Map<String, String> parseQuery(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) {
            return out;
        }
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            if (eq < 0) {
                out.put(decode(pair), "");
            } else {
                out.put(decode(pair.substring(0, eq)), decode(pair.substring(eq + 1)));
            }
        }
        return out;
    }

    public static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception exc) {
            return value;
        }
    }

    public void stop() {
        if (!running.compareAndSet(true, false)) {
            return;
        }
        try {
            if (socket != null) {
                socket.close();
            }
        } catch (IOException ignored) {
            // already closed
        }
        workers.shutdownNow();
    }

    public boolean isRunning() {
        return running.get();
    }

    static byte[] readAsset(AssetManager assets, String name) throws IOException {
        InputStream in = assets.open(name);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) > 0) {
                out.write(chunk, 0, read);
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    public static String escape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    private static String reason(int code) {
        switch (code) {
            case 200:
                return "OK";
            case 201:
                return "Created";
            case 204:
                return "No Content";
            case 302:
                return "Found";
            case 304:
                return "Not Modified";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 409:
                return "Conflict";
            case 429:
                return "Too Many Requests";
            case 500:
                return "Internal Server Error";
            case 501:
                return "Not Implemented";
            case 502:
                return "Bad Gateway";
            case 503:
                return "Service Unavailable";
            case 504:
                return "Gateway Timeout";
            default:
                return "Status";
        }
    }

    public static List<String> splitPath(String path) {
        List<String> parts = new ArrayList<>();
        for (String piece : path.split("/")) {
            if (!piece.isEmpty()) {
                parts.add(piece);
            }
        }
        return parts;
    }
}