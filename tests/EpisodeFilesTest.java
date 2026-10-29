import app.cocoastream.android.EpisodeFiles;
public class EpisodeFilesTest {
 public static void main(String[] args) {
  assert EpisodeFiles.matches("Show/Show.S01E02.1080p.mkv",1,2);
  assert EpisodeFiles.matches("Show 1x02.mp4",1,2);
  assert !EpisodeFiles.matches("Show.S01E20.mkv",1,2);
  assert !EpisodeFiles.matches("Show.S02E02.mkv",1,2);
  assert !EpisodeFiles.matches("Show.S11E02.mkv",1,2);
  assert !EpisodeFiles.matches("Show.S01E01.mkv",1,2);
  System.out.println("Season-pack episode selection and adjacent episode numbers PASS");
 }
}
