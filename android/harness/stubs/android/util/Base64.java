package android.util;
public final class Base64 {
  public static final int URL_SAFE=8, NO_WRAP=2, NO_PADDING=1, DEFAULT=0;
  public static String encodeToString(byte[] data, int flags){
    java.util.Base64.Encoder enc = (flags & URL_SAFE)!=0 ? java.util.Base64.getUrlEncoder() : java.util.Base64.getEncoder();
    if ((flags & NO_PADDING)!=0) enc = enc.withoutPadding();
    return enc.encodeToString(data);
  }
}
