package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.BadRequestException;
import com.google.gerrit.extensions.restapi.Response;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

public class SaveMultiAnchorRangesTest {

  @Mock private MultiAnchorStorage storage;
  private SaveMultiAnchorRanges saveMultiAnchorRanges;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    saveMultiAnchorRanges = new SaveMultiAnchorRanges(storage);
  }

  private MultiAnchorRangesResource mockResource(
      String project, int change, int patchSet, String uuid) {
    MultiAnchorRangesResource rsrc = mock(MultiAnchorRangesResource.class);
    when(rsrc.getProject()).thenReturn(Project.nameKey(project));
    when(rsrc.getChangeId()).thenReturn(Change.id(change));
    when(rsrc.getPatchSet()).thenReturn(patchSet);
    when(rsrc.getCommentUuid()).thenReturn(uuid);
    return rsrc;
  }

  private SaveMultiAnchorRanges.RangeInput makeRangeInput(int sl, int sc, int el, int ec) {
    SaveMultiAnchorRanges.RangeInput ri = new SaveMultiAnchorRanges.RangeInput();
    ri.startLine = sl;
    ri.startCharacter = sc;
    ri.endLine = el;
    ri.endCharacter = ec;
    return ri;
  }

  @Test(expected = BadRequestException.class)
  public void testNullInputThrowsBadRequest() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    saveMultiAnchorRanges.apply(rsrc, null);
  }

  @Test(expected = BadRequestException.class)
  public void testNullRangesFieldThrowsBadRequest() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = null;
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test
  public void testEmptyRangesListSavesEmpty() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.emptyList();

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertTrue(resp.value().isEmpty());
    verify(storage).saveRanges(any(), any(), anyInt(), any(), eq(Collections.emptyList()));
  }

  @Test(expected = BadRequestException.class)
  public void testNullRangeElementThrowsBadRequest() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Arrays.asList(makeRangeInput(1, 0, 2, 5), null);
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeStartLineZero() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(0, 0, 1, 5));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeNegativeStartLine() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(-1, 0, 1, 5));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeNegativeStartCharacter() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, -1, 2, 5));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeEndLineZero() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 0, 5));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeNegativeEndCharacter() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 2, -1));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeStartLineAfterEndLine() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(5, 0, 3, 0));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test(expected = BadRequestException.class)
  public void testInvalidRangeSameLineStartCharAfterEndChar() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(5, 10, 5, 5));
    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test
  public void testValidRangeSameLineEqualChars() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(5, 3, 5, 3));

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertEquals(1, resp.value().size());
    assertEquals(5, resp.value().get(0).startLine);
    assertEquals(3, resp.value().get(0).startCharacter);
  }

  @Test
  public void testSingleValidRange() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 3, 10));

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertEquals(1, resp.value().size());
    assertEquals(1, resp.value().get(0).startLine);
    assertEquals(0, resp.value().get(0).startCharacter);
    assertEquals(3, resp.value().get(0).endLine);
    assertEquals(10, resp.value().get(0).endCharacter);
  }

  @Test
  public void testMultipleValidRanges() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Arrays.asList(
        makeRangeInput(1, 0, 3, 5),
        makeRangeInput(10, 2, 12, 8),
        makeRangeInput(20, 0, 25, 0));

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertEquals(3, resp.value().size());
    assertEquals(1, resp.value().get(0).startLine);
    assertEquals(10, resp.value().get(1).startLine);
    assertEquals(20, resp.value().get(2).startLine);
  }

  @Test
  public void testToRangeCopiesAllFields() throws Exception {
    SaveMultiAnchorRanges.RangeInput ri = makeRangeInput(7, 3, 9, 15);
    Range range = ri.toRange();

    assertEquals(7, range.startLine);
    assertEquals(3, range.startCharacter);
    assertEquals(9, range.endLine);
    assertEquals(15, range.endCharacter);
  }

  @SuppressWarnings("unchecked")
  @Test
  public void testStorageCalledWithCorrectArguments() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("myproj", 42, 3, "comment-uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 2, 5));

    saveMultiAnchorRanges.apply(rsrc, input);

    ArgumentCaptor<List<Range>> rangesCaptor = ArgumentCaptor.forClass(List.class);
    verify(storage).saveRanges(
        eq(Project.nameKey("myproj")),
        eq(Change.id(42)),
        eq(3),
        eq("comment-uuid"),
        rangesCaptor.capture());

    List<Range> saved = rangesCaptor.getValue();
    assertEquals(1, saved.size());
    assertEquals(1, saved.get(0).startLine);
  }

  @Test(expected = IOException.class)
  public void testStorageIOExceptionPropagates() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 2, 5));

    doThrow(new IOException("disk full"))
        .when(storage)
        .saveRanges(any(), any(), anyInt(), any(), any());

    saveMultiAnchorRanges.apply(rsrc, input);
  }

  @Test
  public void testValidRangeZeroCharacterOffsets() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(1, 0, 2, 0));

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertEquals(1, resp.value().size());
    assertEquals(0, resp.value().get(0).startCharacter);
    assertEquals(0, resp.value().get(0).endCharacter);
  }

  @Test
  public void testValidRangeStartLineEqualsEndLine() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Collections.singletonList(makeRangeInput(5, 2, 5, 10));

    Response<List<Range>> resp = saveMultiAnchorRanges.apply(rsrc, input);

    assertEquals(1, resp.value().size());
    assertEquals(5, resp.value().get(0).startLine);
    assertEquals(5, resp.value().get(0).endLine);
    assertEquals(2, resp.value().get(0).startCharacter);
    assertEquals(10, resp.value().get(0).endCharacter);
  }

  @Test
  public void testSecondRangeInvalidStopsProcessing() throws Exception {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 1, "uuid");
    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Arrays.asList(makeRangeInput(1, 0, 2, 5), null);

    try {
      saveMultiAnchorRanges.apply(rsrc, input);
      fail("Expected BadRequestException");
    } catch (BadRequestException e) {
      // expected
    }

    verify(storage, never()).saveRanges(any(), any(), anyInt(), any(), any());
  }
}
