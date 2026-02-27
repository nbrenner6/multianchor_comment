package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestModifyView;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;

/**
 * REST endpoint for deleting additional ranges for a comment.
 *
 * <p>DELETE /changes/{changeId}/multianchor-ranges/{commentUuid}
 *
 * <p>Removes all additional anchor ranges for the specified comment. This should be called when a
 * comment is deleted from Gerrit to clean up the plugin's storage.
 *
 * <p>Returns 204 No Content on success.
 *
 * <p>Note: This only deletes the additional ranges stored by the plugin. The primary comment and
 * its primary range in Gerrit core must be deleted separately using Gerrit's native API.
 */
@Singleton
public class DeleteMultiAnchorRanges
    implements RestModifyView<MultiAnchorRangesResource, DeleteMultiAnchorRanges.Input> {

  /** Empty input class for DELETE request. */
  public static class Input {}

  private final MultiAnchorStorage storage;

  @Inject
  DeleteMultiAnchorRanges(MultiAnchorStorage storage) {
    this.storage = storage;
  }

  @Override
  public Response<?> apply(MultiAnchorRangesResource rsrc, Input input) throws IOException {
    storage.deleteRanges(rsrc.getProject(), rsrc.getChangeId(), rsrc.getCommentUuid());
    return Response.none();
  }
}