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

/**
 * Unit tests for DeleteMultiAnchorRanges.
 *
 * These tests verify that the endpoint correctly deletes additional comment
 * ranges via MultiAnchorStorage.
 *
 * Covered scenarios:
 * - Successful deletion (happy path)
 * - Ensuring storage.deleteRanges is invoked with correct arguments
 * - Verifying method is called the expected number of times
 * - Handling multiple deletion calls
 * - Supporting different resources (project/change/comment variations)
 * - Propagating IOException from storage
 *
 * The tests focus on validating side effects (interaction with storage)
 * rather than return values, since the endpoint returns a no-content response.
 */

public class DeleteMultiAnchorRangesTest {

  @Mock private MultiAnchorStorage storage;
  private DeleteMultiAnchorRanges deleteMultiAnchorRanges;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    deleteMultiAnchorRanges = new DeleteMultiAnchorRanges(storage);
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

  @Test
  public void testNormalDeletion() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 1, 3, "uuid");

    Response<?> resp = deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    assertNotNull(resp);
    verify(storage).deleteRanges(Project.nameKey("proj"), Change.id(1), 3, "uuid");
  }

  @Test
  public void testThrowsIOException() {
    MultiAnchorRangesResource rsrc = mockResource("proj", 2, 4, "uuid");

    try {
        doThrow(new IOException("fail"))
          .when(storage).deleteRanges(any(), any(), anyInt(), any());

      deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());
      fail("Expected IOException");
    } catch (IOException e) {
      // expected
    }
  }

  @Test
  public void testCalledOnce() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 3, 1, "uuid");

    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    verify(storage, times(1)).deleteRanges(any(), any(), anyInt(), any());
  }

  @Test
  public void testMultipleCalls() throws IOException {
    MultiAnchorRangesResource rsrc = mockResource("proj", 4, 2, "uuid");

    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());
    deleteMultiAnchorRanges.apply(rsrc, new DeleteMultiAnchorRanges.Input());

    verify(storage, times(2)).deleteRanges(any(), any(), anyInt(), any());
  }

  @Test
  public void testDifferentResources() throws IOException {
    MultiAnchorRangesResource r1 = mockResource("p1", 1, 1, "u1");
    MultiAnchorRangesResource r2 = mockResource("p2", 2, 2, "u2");

    deleteMultiAnchorRanges.apply(r1, new DeleteMultiAnchorRanges.Input());
    deleteMultiAnchorRanges.apply(r2, new DeleteMultiAnchorRanges.Input());

    verify(storage).deleteRanges(Project.nameKey("p1"), Change.id(1), 1, "u1");
    verify(storage).deleteRanges(Project.nameKey("p2"), Change.id(2), 2, "u2");
  }
}
