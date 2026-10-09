package android.content.res;
import java.io.*;
import java.util.*;
public class AssetManager {
  public InputStream open(String name) throws IOException {
    File f = new File(System.getProperty("aiproxy.assets"), name);
    if (!f.exists()) throw new FileNotFoundException(name);
    return new FileInputStream(f);
  }
}
