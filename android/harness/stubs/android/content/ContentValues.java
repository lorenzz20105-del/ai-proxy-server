package android.content;
import java.util.LinkedHashMap;
import java.util.Map;
public class ContentValues {
  public final Map<String,Object> values = new LinkedHashMap<>();
  public void put(String k,String v){ values.put(k,v); }
  public void put(String k,Integer v){ values.put(k,v); }
  public void put(String k,Long v){ values.put(k,v); }
  public void put(String k,Double v){ values.put(k,v); }
  public void put(String k,Float v){ values.put(k,v); }
  public void put(String k,Boolean v){ values.put(k,v); }
  public void put(String k,byte[] v){ values.put(k,v); }
}
