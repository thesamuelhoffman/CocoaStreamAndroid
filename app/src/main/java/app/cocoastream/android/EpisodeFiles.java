package app.cocoastream.android;
import java.util.regex.Pattern;
public final class EpisodeFiles {
 public static boolean matches(String path,int season,int episode) {
  if(season<0||episode<1)return false;
  String pattern="(?i)(?:s0*"+season+"[ ._-]*e0*"+episode+"|(?<![0-9])0*"+season+"x0*"+episode+")(?![0-9])";
  return Pattern.compile(pattern).matcher(path).find();
 }
}
