package android.database.sqlite;
import android.content.Context;
import java.sql.Connection;
import java.sql.DriverManager;

public abstract class SQLiteOpenHelper {
  public static final int VERSION = 1;
  protected SQLiteDatabase database;

  public SQLiteOpenHelper(Context context, String name, Object factory, int version) {
    try { Class.forName("org.sqlite.JDBC"); } catch (Exception ignored) {}
    try {
      String path = System.getProperty("aiproxy.db", "jdbc:sqlite::memory:");
      Connection connection = DriverManager.getConnection(path);
      database = new SQLiteDatabase(connection);
    } catch (Exception e) { throw new RuntimeException("cannot open sqlite: " + e.getMessage(), e); }
    onCreate(database);
  }

  public abstract void onCreate(SQLiteDatabase db);
  public abstract void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion);

  public SQLiteDatabase getWritableDatabase(){ return database; }
  public SQLiteDatabase getReadableDatabase(){ return database; }
  public void close(){}
}
