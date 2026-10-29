package app.cocoastream.android;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** The small Cast V2 protobuf envelope; payloads remain ordinary JSON. */
public final class CastWire {
    private static void varint(ByteArrayOutputStream out, int value) {
        while ((value & ~127) != 0) { out.write((value & 127) | 128); value >>>= 7; }
        out.write(value);
    }
    public static byte[] encode(String source, String destination, String namespace, String payload) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(8); out.write(0);
        String[] fields = {source, destination, namespace, payload};
        int[] numbers = {2,3,4,6};
        for (int i=0; i<fields.length; i++) {
            if (i==3) { out.write(40); out.write(0); }
            byte[] value=fields[i].getBytes(StandardCharsets.UTF_8);
            varint(out,(numbers[i]<<3)|2);varint(out,value.length);out.write(value,0,value.length);
        }
        return out.toByteArray();
    }
    private static int readVarint(ByteArrayInputStream in) throws IOException {
        int value=0;
        for(int shift=0;shift<35;shift+=7) {
            int b=in.read();if(b<0)throw new EOFException();
            value |= (b&127)<<shift;if((b&128)==0)return value;
        }
        throw new IOException("Invalid Cast varint");
    }
    public static Map<Integer,String> decode(byte[] bytes) throws IOException {
        if(bytes.length>524288)throw new IOException("Cast frame too large");
        ByteArrayInputStream in=new ByteArrayInputStream(bytes);
        Map<Integer,String> fields=new HashMap<>();
        while(in.available()>0) {
            int tag=readVarint(in),wire=tag&7;
            if(wire==0)readVarint(in);
            else if(wire==2) {
                int size=readVarint(in);
                if(size<0||size>in.available())throw new IOException("Truncated Cast field");
                byte[] value=new byte[size];if(in.read(value)!=size)throw new EOFException();
                fields.put(tag>>>3,new String(value,StandardCharsets.UTF_8));
            } else throw new IOException("Unsupported Cast field");
        }
        return fields;
    }
}
