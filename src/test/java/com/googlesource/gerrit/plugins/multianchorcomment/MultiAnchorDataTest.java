package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.common.truth.Truth.assertThat;
import static org.junit.Assert.assertThrows;

import com.google.gerrit.extensions.client.Comment.Range;
import com.googlesource.gerrit.plugins.multianchorcomment.data.MultiAnchorData;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class MultiAnchorDataTest {

  @Test
  public void rangesAreCopiedAndRemovable() {
    MultiAnchorData data = new MultiAnchorData();

    Range r1 = range(1, 0, 1, 2);
    Range r2 = range(2, 1, 2, 3);
    List<Range> input = new java.util.ArrayList<>(Arrays.asList(r1, r2));

    data.setRangesForComment("c1", input);

    List<Range> stored = data.getRangesForComment("c1");
    assertThat(stored).hasSize(2);
    assertThat(stored.get(0).startLine).isEqualTo(1);

    input.clear();
    List<Range> afterMutation = data.getRangesForComment("c1");
    assertThat(afterMutation).hasSize(2);

    data.removeComment("c1");
    assertThat(data.getRangesForComment("c1")).isEmpty();
  }

  @Test
  public void nullOrEmptyRangesRemoveEntry() {
    MultiAnchorData data = new MultiAnchorData();

    data.setRangesForComment("c1", Arrays.asList(range(1, 0, 1, 1)));
    assertThat(data.hasRangesForComment("c1")).isTrue();

    data.setRangesForComment("c1", null);
    assertThat(data.hasRangesForComment("c1")).isFalse();

    data.setRangesForComment("c2", Arrays.asList(range(1, 0, 1, 1)));
    data.setRangesForComment("c2", List.of());
    assertThat(data.hasRangesForComment("c2")).isFalse();
  }

  @Test
  public void additionalRangesMapIsUnmodifiable() {
    MultiAnchorData data = new MultiAnchorData();
    data.setRangesForComment("c1", Arrays.asList(range(1, 0, 1, 1)));

    Map<String, List<Range>> map = data.getAdditionalRanges();
    assertThat(map).containsKey("c1");

    assertThrows(UnsupportedOperationException.class, () -> map.put("c2", List.of()));
  }

  private static Range range(int sl, int sc, int el, int ec) {
    Range r = new Range();
    r.startLine = sl;
    r.startCharacter = sc;
    r.endLine = el;
    r.endCharacter = ec;
    return r;
  }
}
