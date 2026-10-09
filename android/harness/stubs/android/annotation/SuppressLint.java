package android.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.SOURCE) @Target({ElementType.TYPE,ElementType.METHOD,ElementType.FIELD,ElementType.PARAMETER,ElementType.CONSTRUCTOR})
public @interface SuppressLint { String[] value(); }
