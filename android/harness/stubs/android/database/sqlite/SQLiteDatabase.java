package android.database.sqlite;
import android.content.ContentValues;
import android.database.Cursor;
import java.sql.*;
import java.util.*;

/** Minimal android.database.sqlite surface backed by sqlite-jdbc, for the JVM harness. */
public class SQLiteDatabase {
  public static final int CONFLICT_REPLACE = 5;
  public static final int CONFLICT_IGNORE = 4;
  public final Connection connection;
  public boolean open;

  public SQLiteDatabase(Connection connection) { this.connection = connection; }

  public void execSQL(String sql) {
    try (Statement st = connection.createStatement()) { st.execute(sql); }
    catch (SQLException e) { throw new RuntimeException("execSQL: " + sql + " -> " + e.getMessage(), e); }
  }

  public Cursor rawQuery(String sql, String[] args) {
    try {
      PreparedStatement st = connection.prepareStatement(sql);
      bind(st, args);
      return new JdbcCursor(st, st.executeQuery());
    } catch (SQLException e) { throw new RuntimeException("rawQuery: " + e.getMessage(), e); }
  }

  public Cursor query(String table, String[] columns, String selection, String[] args,
                      String groupBy, String having, String orderBy) {
    return query(table, columns, selection, args, groupBy, having, orderBy, null);
  }

  public Cursor query(String table, String[] columns, String selection, String[] args,
                      String groupBy, String having, String orderBy, String limit) {
    StringBuilder sql = new StringBuilder("SELECT ");
    if (columns == null || columns.length == 0) {
      sql.append('*');
    } else {
      sql.append(String.join(", ", columns));
    }
    sql.append(" FROM ").append(table);
    if (selection != null) sql.append(" WHERE ").append(selection);
    if (orderBy != null) sql.append(" ORDER BY ").append(orderBy);
    if (limit != null) sql.append(" LIMIT ").append(limit);
    return rawQuery(sql.toString(), args);
  }

  public long insert(String table, String nullColumnHack, ContentValues values) {
    if (values == null || values.values.isEmpty()) {
      try (Statement st = connection.createStatement()) {
        st.executeUpdate("INSERT INTO " + table + " DEFAULT VALUES");
      } catch (SQLException e) { throw new RuntimeException(e); }
      return 1;
    }
    List<String> cols = new ArrayList<>(); List<Object> vals = new ArrayList<>();
    for (Map.Entry<String,Object> e : values.values.entrySet()) { cols.add(e.getKey()); vals.add(e.getValue()); }
    StringBuilder sql = new StringBuilder("INSERT INTO ").append(table).append(" (")
            .append(String.join(", ", cols)).append(") VALUES (");
    for (int i=0;i<vals.size();i++) sql.append(i==0?"?":",?");
    sql.append(')');
    try {
      PreparedStatement st = connection.prepareStatement(sql.toString());
      for (int i=0;i<vals.size();i++) set(st, i+1, vals.get(i));
      st.executeUpdate();
    } catch (SQLException e) { throw new RuntimeException("insert: " + e.getMessage(), e); }
    return 1;
  }

  public int replace(String table, String nullColumnHack, ContentValues values) {
    if (values == null) return delete(table, null, null);
    List<String> cols = new ArrayList<>(); List<Object> vals = new ArrayList<>();
    for (Map.Entry<String,Object> e : values.values.entrySet()) { cols.add(e.getKey()); vals.add(e.getValue()); }
    StringBuilder sql = new StringBuilder("INSERT OR REPLACE INTO ").append(table).append(" (")
            .append(String.join(", ", cols)).append(") VALUES (");
    for (int i=0;i<vals.size();i++) sql.append(i==0?"?":",?");
    sql.append(')');
    try {
      PreparedStatement st = connection.prepareStatement(sql.toString());
      for (int i=0;i<vals.size();i++) set(st, i+1, vals.get(i));
      return st.executeUpdate();
    } catch (SQLException e) { throw new RuntimeException("replace: " + e.getMessage(), e); }
  }

  public int insertWithOnConflict(String table, String nullColumnHack, ContentValues values, int conflict) {
    return replace(table, nullColumnHack, values);
  }

  public int delete(String table, String where, String[] args) {
    String sql = "DELETE FROM " + table + (where == null ? "" : " WHERE " + where);
    try {
      PreparedStatement st = connection.prepareStatement(sql);
      bind(st, args);
      return st.executeUpdate();
    } catch (SQLException e) { throw new RuntimeException("delete: " + e.getMessage(), e); }
  }

  private static void bind(PreparedStatement st, String[] args) throws SQLException {
    if (args == null) return;
    for (int i=0;i<args.length;i++) st.setString(i+1, args[i]);
  }

  private static void set(PreparedStatement st, int index, Object value) throws SQLException {
    if (value == null) st.setObject(index, null);
    else if (value instanceof Integer) st.setInt(index, (Integer) value);
    else if (value instanceof Long) st.setLong(index, (Long) value);
    else if (value instanceof Double) st.setDouble(index, (Double) value);
    else if (value instanceof Float) st.setDouble(index, (Float) value);
    else if (value instanceof Boolean) st.setInt(index, ((Boolean) value) ? 1 : 0);
    else if (value instanceof byte[]) st.setBytes(index, (byte[]) value);
    else st.setString(index, value.toString());
  }

  static final class JdbcCursor implements Cursor {
    private final PreparedStatement statement; private final ResultSet rs; private boolean closed;
    JdbcCursor(PreparedStatement statement, ResultSet rs) { this.statement = statement; this.rs = rs; }
    public boolean moveToNext(){ try { return rs.next(); } catch (SQLException e) { throw new RuntimeException(e); } }
    public boolean moveToFirst(){ try { return rs.next(); } catch (SQLException e) { throw new RuntimeException(e); } }
    public int getInt(int i){ try { return rs.getInt(i+1); } catch (SQLException e) { throw new RuntimeException(e); } }
    public long getLong(int i){ try { return rs.getLong(i+1); } catch (SQLException e) { throw new RuntimeException(e); } }
    public double getDouble(int i){ try { return rs.getDouble(i+1); } catch (SQLException e) { throw new RuntimeException(e); } }
    public String getString(int i){ try { return rs.getString(i+1); } catch (SQLException e) { throw new RuntimeException(e); } }
    public int getColumnIndexOrThrow(String name){
      // JDBC findColumn is 1-based; the Android contract is 0-based.
      try {
        int one = rs.findColumn(name);
        if (one < 1) throw new IllegalArgumentException("no column " + name);
        return one - 1;
      } catch (SQLException e) { throw new IllegalArgumentException("no column " + name, e); }
    }
    public int getCount(){ try { return rs.getRow(); } catch (SQLException e) { return 0; } }
    public void close(){ if (closed) return; closed = true; try { rs.close(); statement.close(); } catch (SQLException ignored) {} }
  }
}
