package com.googlesource.gerrit.plugins.multianchorcomment.data;

import static org.junit.Assert.*;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.common.CommentInfo;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class MultiAnchorCommentInfoTest {

  private Range makeRange(int sl, int sc, int el, int ec) {
    Range r = new Range();
    r.startLine = sl;
    r.startCharacter = sc;
    r.endLine = el;
    r.endCharacter = ec;
    return r;
  }

  @Test
  public void testFromCommentInfoCopiesAllFields() {
    CommentInfo info = new CommentInfo();
    info.patchSet = 3;
    info.id = "comment-id";
    info.path = "src/Main.java";
    info.line = 42;
    info.range = makeRange(40, 0, 42, 10);
    info.inReplyTo = "parent-id";
    info.updated = new Timestamp(1000L);
    info.message = "test message";
    info.commitId = "abc123";
    info.tag = "test-tag";
    info.changeMessageId = "msg-id";
    info.unresolved = true;

    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    assertEquals(Integer.valueOf(3), result.patchSet);
    assertEquals("comment-id", result.id);
    assertEquals("src/Main.java", result.path);
    assertEquals(Integer.valueOf(42), result.line);
    assertNotNull(result.range);
    assertEquals(40, result.range.startLine);
    assertEquals("parent-id", result.inReplyTo);
    assertEquals(new Timestamp(1000L), result.updated);
    assertEquals("test message", result.message);
    assertEquals("abc123", result.commitId);
    assertEquals("test-tag", result.tag);
    assertEquals("msg-id", result.changeMessageId);
    assertTrue(result.unresolved);
  }

  @Test
  public void testFromCommentInfoWithRange() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);

    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    assertNotNull(result.allRanges);
    assertEquals(1, result.allRanges.size());
    assertEquals(1, result.allRanges.get(0).startLine);
    assertEquals(5, result.allRanges.get(0).endLine);
  }

  @Test
  public void testFromCommentInfoWithNullRange() {
    CommentInfo info = new CommentInfo();
    info.range = null;

    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    assertNotNull(result.allRanges);
    assertTrue(result.allRanges.isEmpty());
  }

  @Test
  public void testFromCommentInfoSetsMultiAnchorFalse() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);

    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    assertFalse(result.isMultiAnchor);
  }

  @Test
  public void testAddAdditionalRangesWithRanges() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    List<Range> additional = Arrays.asList(makeRange(10, 0, 12, 5), makeRange(20, 0, 25, 0));
    result.addAdditionalRanges(additional);

    assertEquals(3, result.allRanges.size());
    assertTrue(result.isMultiAnchor);
  }

  @Test
  public void testAddAdditionalRangesWithNull() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    result.addAdditionalRanges(null);

    assertEquals(1, result.allRanges.size());
    assertFalse(result.isMultiAnchor);
  }

  @Test
  public void testAddAdditionalRangesWithEmptyList() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    result.addAdditionalRanges(Collections.emptyList());

    assertEquals(1, result.allRanges.size());
    assertFalse(result.isMultiAnchor);
  }

  @Test
  public void testAddAdditionalRangesWhenAllRangesNull() {
    CommentInfo info = new CommentInfo();
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);
    // Force allRanges to null to test the null-check branch
    result.allRanges = null;

    List<Range> additional = Arrays.asList(makeRange(10, 0, 12, 5));
    result.addAdditionalRanges(additional);

    assertNotNull(result.allRanges);
    assertEquals(1, result.allRanges.size());
  }

  @Test
  public void testIsMultiAnchorTrueWhenMultipleRanges() {
    CommentInfo info = new CommentInfo();
    info.range = makeRange(1, 0, 5, 10);
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);

    result.addAdditionalRanges(Arrays.asList(makeRange(10, 0, 12, 5)));

    assertTrue(result.isMultiAnchor);
    assertEquals(2, result.allRanges.size());
  }

  @Test
  public void testIsMultiAnchorFalseWhenSingleRange() {
    CommentInfo info = new CommentInfo();
    MultiAnchorCommentInfo result = MultiAnchorCommentInfo.fromCommentInfo(info);
    // allRanges is empty, add just one range
    result.allRanges = null;
    result.addAdditionalRanges(Arrays.asList(makeRange(10, 0, 12, 5)));

    assertFalse(result.isMultiAnchor);
    assertEquals(1, result.allRanges.size());
  }
}
