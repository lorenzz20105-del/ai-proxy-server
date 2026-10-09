package com.aiproxy.mobile;

/** Boots the embedded proxy so a browser can be pointed at the real dashboard. */
public class ServerMain {
    public static void main(String[] args) throws Exception {
        Server server = new Server(new android.content.Context());
        server.start();
        System.out.println("PORT=" + server.port());
        System.out.println("KEY=" + server.masterKey());
        System.out.flush();
        Thread.sleep(Long.MAX_VALUE);
    }
}
