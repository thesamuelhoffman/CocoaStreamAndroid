import app.cocoastream.android.CastWire;
import java.util.Map;
import java.io.IOException;
public class CastWireTest {
 public static void main(String[] args) throws Exception {
  byte[] encoded=CastWire.encode("sender-0","receiver-0","urn:x-cast:com.google.cast.tp.heartbeat","{\"type\":\"PING\"}");
  assert encoded[0]==8 && encoded[1]==0 : "Cast protocol version";
  Map<Integer,String> decoded=CastWire.decode(encoded);
  assert decoded.get(2).equals("sender-0");
  assert decoded.get(3).equals("receiver-0");
  assert decoded.get(6).equals("{\"type\":\"PING\"}");
  try { CastWire.decode(new byte[]{18,4,65});throw new AssertionError("Truncation accepted"); } catch(IOException expected) {}
  try { CastWire.decode(new byte[]{18,(byte)255,(byte)255,(byte)255,(byte)255,127});throw new AssertionError("Oversize accepted"); } catch(IOException expected) {}
  System.out.println("Cast V2 envelope, truncation and oversized fields PASS");
 }
}
