package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.PatchSet;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.registration.DynamicMap;
import com.google.gerrit.extensions.restapi.IdString;
import com.google.gerrit.extensions.restapi.ResourceNotFoundException;
import com.google.gerrit.extensions.restapi.RestView;
import com.google.gerrit.server.change.ChangeResource;
import com.google.inject.Provider;
import org.junit.Before;
import org.junit.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

public class MultiAnchorRangesCollectionTest {

  @Mock private DynamicMap<RestView<MultiAnchorRangesResource>> views;
  @Mock private Provider<ListMultiAnchorRanges> listProvider;
  @Mock private ListMultiAnchorRanges listView;
  private MultiAnchorRangesCollection collection;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    when(listProvider.get()).thenReturn(listView);
    collection = new MultiAnchorRangesCollection(views, listProvider);
  }

  private ChangeResource mockParent(String project, int changeId, int currentPatchSet) {
    ChangeResource parent = mock(ChangeResource.class);
    Change change = mock(Change.class);
    when(parent.getProject()).thenReturn(Project.nameKey(project));
    when(parent.getChange()).thenReturn(change);
    when(change.getId()).thenReturn(Change.id(changeId));
    PatchSet.Id psId = mock(PatchSet.Id.class);
    when(psId.get()).thenReturn(currentPatchSet);
    when(change.currentPatchSetId()).thenReturn(psId);
    return parent;
  }

  private IdString idString(String value) {
    IdString id = mock(IdString.class);
    when(id.get()).thenReturn(value);
    return id;
  }

  @Test
  public void testParseValidCompositeId() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);

    MultiAnchorRangesResource rsrc = collection.parse(parent, idString("1~uuid123"));

    assertEquals(Project.nameKey("proj"), rsrc.getProject());
    assertEquals(Change.id(1), rsrc.getChangeId());
    assertEquals(1, rsrc.getPatchSet());
    assertEquals("uuid123", rsrc.getCommentUuid());
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseNullIdThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString(null));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseEmptyIdThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString(""));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseNoSeparatorThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("notidle"));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseSeparatorAtStartThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("~uuid"));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseSeparatorAtEndThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("1~"));
  }

  @Test
  public void testParseCurrentPatchSet() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 5);

    MultiAnchorRangesResource rsrc = collection.parse(parent, idString("current~uuid456"));

    assertEquals(5, rsrc.getPatchSet());
    assertEquals("uuid456", rsrc.getCommentUuid());
  }

  @Test
  public void testParseCurrentCaseInsensitive() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 7);

    MultiAnchorRangesResource rsrc = collection.parse(parent, idString("CURRENT~uuid789"));

    assertEquals(7, rsrc.getPatchSet());
    assertEquals("uuid789", rsrc.getCommentUuid());
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseNonNumericPatchSetThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("abc~uuid"));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseZeroPatchSetThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("0~uuid"));
  }

  @Test(expected = ResourceNotFoundException.class)
  public void testParseNegativePatchSetThrows() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);
    collection.parse(parent, idString("-1~uuid"));
  }

  @Test
  public void testParseTildeInUuid() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);

    MultiAnchorRangesResource rsrc = collection.parse(parent, idString("1~uuid~extra"));

    assertEquals(1, rsrc.getPatchSet());
    assertEquals("uuid~extra", rsrc.getCommentUuid());
  }

  @Test
  public void testParseLargePatchSetNumber() throws ResourceNotFoundException {
    ChangeResource parent = mockParent("proj", 1, 3);

    MultiAnchorRangesResource rsrc = collection.parse(parent, idString("999~uuid"));

    assertEquals(999, rsrc.getPatchSet());
    assertEquals("uuid", rsrc.getCommentUuid());
  }

  @Test
  public void testListReturnsListView() {
    RestView<?> result = collection.list();
    assertSame(listView, result);
  }

  @Test
  public void testViewsReturnsDynamicMap() {
    assertSame(views, collection.views());
  }
}
