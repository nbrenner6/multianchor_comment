package com.googlesource.gerrit.plugins.multianchorcomment.data;

import static org.junit.Assert.*;

import com.google.gerrit.extensions.client.Comment.Range;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;

public class MultiAnchorDataTest {

  private MultiAnchorData data;

  @Before
  public void setUp() {
    data = new MultiAnchorData();
  }

  private Range makeRange(int sl, int sc, int el, int ec) {
    Range r = new Range();
    r.startLine = sl;
    r.startCharacter = sc;
    r.endLine = el;
    r.endCharacter = ec;
    return r;
  }

  @Test
  public void testNewInstanceHasEmptyMap() {
    assertTrue(data.getAdditionalRanges().isEmpty());
  }

  @Test(expected = UnsupportedOperationException.class)
  public void testGetAdditionalRangesReturnsUnmodifiable() {
    data.getAdditionalRanges().put("key", new ArrayList<>());
  }

  @Test
  public void testSetAdditionalRangesWithMap() {
    Map<String, List<Range>> map = new HashMap<>();
    map.put("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    data.setAdditionalRanges(map);

    assertEquals(1, data.getAdditionalRanges().size());
    assertTrue(data.getAdditionalRanges().containsKey("uuid1"));
  }

  @Test
  public void testSetAdditionalRangesWithNull() {
    // First set some data
    Map<String, List<Range>> map = new HashMap<>();
    map.put("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    data.setAdditionalRanges(map);
    assertFalse(data.getAdditionalRanges().isEmpty());

    // Setting null should reset to empty map
    data.setAdditionalRanges(null);
    assertTrue(data.getAdditionalRanges().isEmpty());
  }

  @Test
  public void testGetRangesForCommentExistingKey() {
    List<Range> ranges = Arrays.asList(makeRange(1, 0, 2, 5), makeRange(10, 0, 12, 0));
    data.setRangesForComment("uuid1", ranges);

    List<Range> result = data.getRangesForComment("uuid1");
    assertEquals(2, result.size());
    assertEquals(1, result.get(0).startLine);
    assertEquals(10, result.get(1).startLine);
  }

  @Test
  public void testGetRangesForCommentMissingKey() {
    List<Range> result = data.getRangesForComment("nonexistent");
    assertTrue(result.isEmpty());
  }

  @Test
  public void testGetRangesForCommentReturnsCopy() {
    List<Range> ranges = Arrays.asList(makeRange(1, 0, 2, 5));
    data.setRangesForComment("uuid1", ranges);

    List<Range> result = data.getRangesForComment("uuid1");
    result.add(makeRange(10, 0, 12, 0));

    // Internal state should not be affected
    assertEquals(1, data.getRangesForComment("uuid1").size());
  }

  @Test
  public void testSetRangesForCommentWithRanges() {
    List<Range> ranges = Arrays.asList(makeRange(1, 0, 2, 5));
    data.setRangesForComment("uuid1", ranges);

    assertTrue(data.hasRangesForComment("uuid1"));
    assertEquals(1, data.getRangesForComment("uuid1").size());
  }

  @Test
  public void testSetRangesForCommentWithNull() {
    // First add an entry
    data.setRangesForComment("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    assertTrue(data.hasRangesForComment("uuid1"));

    // Setting null should remove the entry
    data.setRangesForComment("uuid1", null);
    assertFalse(data.hasRangesForComment("uuid1"));
  }

  @Test
  public void testSetRangesForCommentWithEmptyList() {
    // First add an entry
    data.setRangesForComment("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    assertTrue(data.hasRangesForComment("uuid1"));

    // Setting empty list should remove the entry
    data.setRangesForComment("uuid1", Collections.emptyList());
    assertFalse(data.hasRangesForComment("uuid1"));
  }

  @Test
  public void testRemoveComment() {
    data.setRangesForComment("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    assertTrue(data.hasRangesForComment("uuid1"));

    data.removeComment("uuid1");
    assertFalse(data.hasRangesForComment("uuid1"));
  }

  @Test
  public void testHasRangesForComment() {
    assertFalse(data.hasRangesForComment("uuid1"));

    data.setRangesForComment("uuid1", Arrays.asList(makeRange(1, 0, 2, 5)));
    assertTrue(data.hasRangesForComment("uuid1"));

    assertFalse(data.hasRangesForComment("uuid2"));
  }
}
