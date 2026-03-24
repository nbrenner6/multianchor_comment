package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import java.io.IOException;

import org.junit.Before;
import org.junit.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.restapi.Response;

import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;

public class DeleteMultiAnchorRangesTest {

  @Mock private MultiAnchorStorage storage;
  private DeleteMultiAnchorRanges deleteMultiAnchorRanges;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    deleteMultiAnchorRanges = new DeleteMultiAnchorRanges(storage);
  }

  private MultiAnchorRangesResource mockResource(String project, int change, String uuid) {
    MultiAnchorRangesResource rsrc = mock(MultiAnchorRangesResource.class);
    when(rsrc.getProject()).thenReturn(Project.nameKey(project));
    when(rsrc.getChangeId()).thenReturn(Change.id(change));
    when(rsrc.getCommentUuid()).thenReturn(uuid);
    return rsrc;
  }

  @Test
  public void testNormalDeletion() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, "uuid");

    Response<?> resp = deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    assertNotNull(resp);
    verify(storage).deleteRanges(Project.nameKey("proj"), Change.id(1), "uuid");
  }

  @Test
  public void testThrowsIOException() {
    MultiAnchorRangesResource rsrc = mockResource("proj", 2, "uuid");

    try {
      doThrow(new IOException("fail"))
          .when(storage).deleteRanges(any(), any(), any());

      deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());
      fail("Expected IOException");
    } catch (IOException e) {
      // expected
    }
  }

  @Test
  public void testCalledOnce() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 3, "uuid");

    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    verify(storage, times(1)).deleteRanges(any(), any(), any());
  }

  @Test
  public void testMultipleCalls() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 4, "uuid");

    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());
    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    verify(storage, times(2)).deleteRanges(any(), any(), any());
  }

  @Test
  public void testDifferentResources() throws IOException {
    MultiAnchorRangesResource r1 = mockResource("p1", 1, "u1");
    MultiAnchorRangesResource r2 = mockResource("p2", 2, "u2");

    deleteMultiAnchorRanges.apply(r1, new DeleteMultiAnchorRanges.Input());
    deleteMultiAnchorRanges.apply(r2, new DeleteMultiAnchorRanges.Input());

    verify(storage).deleteRanges(Project.nameKey("p1"), Change.id(1), "u1");
    verify(storage).deleteRanges(Project.nameKey("p2"), Change.id(2), "u2");
  }
}
