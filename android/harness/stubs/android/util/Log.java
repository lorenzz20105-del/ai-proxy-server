package android.util;
public final class Log {
  public static int d(String tag, String msg){ System.out.println("D/"+tag+": "+msg); return 0; }
  public static int w(String tag, String msg){ System.out.println("W/"+tag+": "+msg); return 0; }
  public static int e(String tag, String msg){ System.err.println("E/"+tag+": "+msg); return 0; }
  public static int e(String tag, String msg, Throwable t){ System.err.println("E/"+tag+": "+msg); return 0; }
}
