package android.content;
import java.io.File;
public class Context {
  public static final int MODE_PRIVATE=0;
  public Context getApplicationContext(){ return this; }
  public File getFilesDir(){ return new File(System.getProperty("java.io.tmpdir"), "aiproxy-files"); }
  public SharedPreferences getSharedPreferences(String name,int mode){ return new SharedPreferences(); }
  public Object getSystemService(String name){ return null; }
  public android.content.res.AssetManager getAssets(){ return new android.content.res.AssetManager(); }
}
