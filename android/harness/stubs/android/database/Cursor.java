package android.database;
public interface Cursor {
  boolean moveToNext();
  boolean moveToFirst();
  int getInt(int i);
  long getLong(int i);
  double getDouble(int i);
  String getString(int i);
  int getColumnIndexOrThrow(String name);
  int getCount();
  void close();
}
