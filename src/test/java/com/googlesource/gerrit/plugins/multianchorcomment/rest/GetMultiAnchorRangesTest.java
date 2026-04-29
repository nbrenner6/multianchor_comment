package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import java.io.IOException;
import java.util.List;
import java.util.Arrays;
import java.util.Collections;

import org.junit.Before;
import org.junit.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.Response;

import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;

/**
 * Unit tests for GetMultiAnchorRanges.
 *
 * These tests verify that the endpoint correctly retrieves additional comment
 * ranges from MultiAnchorStorage and returns them in the REST response.
 *
 * Covered scenarios:
 * - Returning multiple ranges from storage
 * - Handling empty and null results
 * - Returning a single range
 * - Propagating IOException from storage
 * - Verifying correct interaction with storage (arguments + call count)
 * - Handling unusual or edge-case range values
 * - Supporting multiple resources (different project/change/comment IDs)
 *
 * The tests use Mockito to mock storage and resource inputs, and validate
 * that the response structure and values match expected behavior.
 */

public class GetMultiAnchorRangesTest {

  @Mock private MultiAnchorStorage storage;
  private GetMultiAnchorRanges getMultiAnchorRanges;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    getMultiAnchorRanges = new GetMultiAnchorRanges(storage);
  }

  private MultiAnchorRangesResource mockResource(String project, int change, String uuid) {
    MultiAnchorRangesResource rsrc = mock(MultiAnchorRangesResource.class);
    when(rsrc.getProject()).thenReturn(Project.nameKey(project));
    when(rsrc.getChangeId()).thenReturn(Change.id(change));
    when(rsrc.getCommentUuid()).thenReturn(uuid);
    return rsrc;
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
  public void testReturnsRangesFromStorage() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("projectA", 123, "uuid1");

    List<Range> expected = Arrays.asList(
        makeRange(1, 0, 3, 5),
        makeRange(10, 2, 12, 8)
    );

    when(storage.getRangesForComment(any(), any(), any())).thenReturn(expected);

    List<Range> actual = getMultiAnchorRanges.apply(rsrc).value();

    assertEquals(2, actual.size());
    assertEquals(1, actual.get(0).startLine);
    assertEquals(12, actual.get(1).endLine);
  }

  @Test
  public void testReturnsEmptyList() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, "uuid");

    when(storage.getRangesForComment(any(), any(), any()))
        .thenReturn(Collections.emptyList());

    assertTrue(getMultiAnchorRanges.apply(rsrc).value().isEmpty());
  }

  @Test
  public void testSingleRange() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 2, "uuid");

    Range r = makeRange(5, 0, 5, 10);
    when(storage.getRangesForComment(any(), any(), any()))
        .thenReturn(Collections.singletonList(r));

    List<Range> actual = getMultiAnchorRanges.apply(rsrc).value();

    assertEquals(1, actual.size());
    assertEquals(10, actual.get(0).endCharacter);
  }

  @Test
  public void testNullList() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 3, "uuid");

    when(storage.getRangesForComment(any(), any(), any())).thenReturn(null);

    Response<List<Range>> resp = getMultiAnchorRanges.apply(rsrc);

    assertNotNull(resp);
  }

  @Test
  public void testStorageCalledOnce() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 4, "uuid");

    when(storage.getRangesForComment(any(), any(), any()))
        .thenReturn(Collections.emptyList());

    getMultiAnchorRanges.apply(rsrc);

    verify(storage, times(1)).getRangesForComment(any(), any(), any());
  }

  @Test
  public void testThrowsIOException() {
    MultiAnchorRangesResource rsrc = mockResource("proj", 5, "uuid");

    try {
      when(storage.getRangesForComment(any(), any(), any()))
          .thenThrow(new IOException("fail"));

      getMultiAnchorRanges.apply(rsrc);
      fail("Expected IOException");
    } catch (IOException e) {
      // expected
    }
  }

  @Test
  public void testWeirdValues() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 6, "uuid");

    Range r = makeRange(0, 0, -1, 5);
    when(storage.getRangesForComment(any(), any(), any()))
        .thenReturn(Collections.singletonList(r));

    assertEquals(-1, getMultiAnchorRanges.apply(rsrc).value().get(0).endLine);
  }

  @Test
  public void testMultipleResources() throws IOException {
    MultiAnchorRangesResource r1 = mockResource("p1", 1, "u1");
    MultiAnchorRangesResource r2 = mockResource("p2", 2, "u2");

    when(storage.getRangesForComment(Project.nameKey("p1"), Change.id(1), "u1"))
        .thenReturn(Collections.singletonList(makeRange(1,1,2,2)));

    when(storage.getRangesForComment(Project.nameKey("p2"), Change.id(2), "u2"))
        .thenReturn(Collections.singletonList(makeRange(3,0,3,5)));

    assertEquals(2, getMultiAnchorRanges.apply(r1).value().get(0).endLine);
    assertEquals(5, getMultiAnchorRanges.apply(r2).value().get(0).endCharacter);
  }

  @Test
  public void testLargeList() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 7, "uuid");

    List<Range> list = Arrays.asList(
        makeRange(0,0,1,1),
        makeRange(2,0,3,1),
        makeRange(4,0,5,1)
    );

    when(storage.getRangesForComment(any(), any(), any())).thenReturn(list);

    assertEquals(3, getMultiAnchorRanges.apply(rsrc).value().size());
  }

  @Test
  public void testSpecialStrings() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj!@#", 8, "uuid$%^");

    when(storage.getRangesForComment(any(), any(), any()))
        .thenReturn(Collections.singletonList(makeRange(1,1,2,2)));

    assertEquals(2, getMultiAnchorRanges.apply(rsrc).value().get(0).endLine);
  }
}
