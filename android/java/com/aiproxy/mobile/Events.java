package com.aiproxy.mobile;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Fan-out for the live log feed. The dashboard subscribes with
 * {@code GET /admin/logs/stream} and every request the router records is pushed
 * to all subscribers, so the Traffic tab updates without polling.
 */
public final class Events {

    private static final int MAX_SUBSCRIBERS = 64;

    public interface Subscriber {
        void onLog(JSONObject entry);
    }

    private static final Deque<Subscriber> subscribers = new ArrayDeque<Subscriber>();

    private Events() {
    }

    public static synchronized void subscribe(Subscriber subscriber) {
        if (subscribers.size() >= MAX_SUBSCRIBERS) {
            subscribers.pollFirst();
        }
        subscribers.addLast(subscriber);
    }

    public static synchronized void unsubscribe(Subscriber subscriber) {
        subscribers.remove(subscriber);
    }

    public static void publish(JSONObject entry) {
        List<Subscriber> targets;
        synchronized (Events.class) {
            targets = new ArrayList<Subscriber>(subscribers);
        }
        for (Subscriber subscriber : targets) {
            try {
                subscriber.onLog(entry);
            } catch (Exception ignored) {
                // a broken subscriber must not stop the others
            }
        }
    }
}