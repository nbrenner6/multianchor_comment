package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.server.change.ChangeResource;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

public class ListMultiAnchorRangesTest {

  @Mock private MultiAnchorStorage storage;
  private ListMultiAnchorRanges listMultiAnchorRanges;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    listMultiAnchorRanges = new ListMultiAnchorRanges(storage);
  }

  private Range makeRange(int sl, int sc, int el, int ec) {
    Range r = new Range();
    r.startLine = sl;
    r.startCharacter = sc;
    r.endLine = el;
    r.endCharacter = ec;
    return r;
  }

  private ChangeResource mockChangeResource(String project, int changeId) {
    ChangeResource rsrc = mock(ChangeResource.class);
    Change change = mock(Change.class);
    when(rsrc.getProject()).thenReturn(Project.nameKey(project));
    when(rsrc.getChange()).thenReturn(change);
    when(change.getId()).thenReturn(Change.id(changeId));
    return rsrc;
  }

  @Test
  public void testReturnsRangesFromStorage() throws IOException {
    ChangeResource rsrc = mockChangeResource("proj", 1);

    Map<String, List<Range>> expected = new HashMap<>();
    expected.put("1/uuid1", Collections.singletonList(makeRange(1, 0, 3, 5)));

    when(storage.getRanges(any(), any())).thenReturn(expected);

    Response<Map<String, List<Range>>> resp = listMultiAnchorRanges.apply(rsrc);

    assertEquals(1, resp.value().size());
    assertTrue(resp.value().containsKey("1/uuid1"));
    assertEquals(1, resp.value().get("1/uuid1").get(0).startLine);
  }

  @Test
  public void testReturnsEmptyMap() throws IOException {
    ChangeResource rsrc = mockChangeResource("proj", 1);

    when(storage.getRanges(any(), any())).thenReturn(Collections.emptyMap());

    Response<Map<String, List<Range>>> resp = listMultiAnchorRanges.apply(rsrc);

    assertTrue(resp.value().isEmpty());
  }

  @Test
  public void testStorageCalledWithCorrectArguments() throws IOException {
    ChangeResource rsrc = mockChangeResource("myproj", 42);

    when(storage.getRanges(any(), any())).thenReturn(Collections.emptyMap());

    listMultiAnchorRanges.apply(rsrc);

    verify(storage).getRanges(eq(Project.nameKey("myproj")), eq(Change.id(42)));
  }

  @Test(expected = IOException.class)
  public void testStorageIOExceptionPropagates() throws IOException {
    ChangeResource rsrc = mockChangeResource("proj", 1);

    when(storage.getRanges(any(), any())).thenThrow(new IOException("read error"));

    listMultiAnchorRanges.apply(rsrc);
  }

  @Test
  public void testMultipleCommentsInMap() throws IOException {
    ChangeResource rsrc = mockChangeResource("proj", 1);

    Map<String, List<Range>> expected = new HashMap<>();
    expected.put("1/uuid1", Collections.singletonList(makeRange(1, 0, 3, 5)));
    expected.put("1/uuid2", Arrays.asList(makeRange(10, 0, 12, 0), makeRange(20, 0, 25, 0)));
    expected.put("2/uuid3", Collections.singletonList(makeRange(50, 0, 55, 0)));

    when(storage.getRanges(any(), any())).thenReturn(expected);

    Response<Map<String, List<Range>>> resp = listMultiAnchorRanges.apply(rsrc);

    assertEquals(3, resp.value().size());
    assertEquals(2, resp.value().get("1/uuid2").size());
  }

  @Test
  public void testNullMapFromStorage() throws IOException {
    ChangeResource rsrc = mockChangeResource("proj", 1);

    when(storage.getRanges(any(), any())).thenReturn(null);

    Response<Map<String, List<Range>>> resp = listMultiAnchorRanges.apply(rsrc);

    assertNull(resp.value());
  }
}
