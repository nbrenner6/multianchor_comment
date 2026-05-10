package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.common.truth.Truth.assertThat;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.common.CommentInfo;
import com.googlesource.gerrit.plugins.multianchorcomment.data.MultiAnchorCommentInfo;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class MultiAnchorCommentInfoTest {

  @Test
  public void fromCommentInfoCopiesPrimaryRange() {
    CommentInfo info = new CommentInfo();
    info.message = "test";
    info.range = range(1, 0, 1, 2);

    MultiAnchorCommentInfo converted = MultiAnchorCommentInfo.fromCommentInfo(info);

    assertThat(converted.message).isEqualTo("test");
    assertThat(converted.allRanges).hasSize(1);
    assertThat(converted.isMultiAnchor).isFalse();
  }

  @Test
  public void addAdditionalRangesMarksMultiAnchor() {
    CommentInfo info = new CommentInfo();
    info.range = range(2, 0, 2, 1);

    MultiAnchorCommentInfo converted = MultiAnchorCommentInfo.fromCommentInfo(info);
    List<Range> additional = Arrays.asList(range(3, 0, 3, 4));

    converted.addAdditionalRanges(additional);

    assertThat(converted.allRanges).hasSize(2);
    assertThat(converted.isMultiAnchor).isTrue();
  }

  @Test
  public void addAdditionalRangesHandlesNullOrEmpty() {
    CommentInfo info = new CommentInfo();
    info.range = range(4, 0, 4, 4);

    MultiAnchorCommentInfo converted = MultiAnchorCommentInfo.fromCommentInfo(info);
    converted.addAdditionalRanges(null);
    converted.addAdditionalRanges(List.of());

    assertThat(converted.allRanges).hasSize(1);
    assertThat(converted.isMultiAnchor).isFalse();
  }

  @Test
  public void addAdditionalRangesWhenNoPrimaryRange() {
    CommentInfo info = new CommentInfo();
    info.range = null;

    MultiAnchorCommentInfo converted = MultiAnchorCommentInfo.fromCommentInfo(info);
    converted.addAdditionalRanges(List.of(range(1, 0, 1, 1)));

    assertThat(converted.allRanges).hasSize(1);
    assertThat(converted.isMultiAnchor).isFalse();
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
