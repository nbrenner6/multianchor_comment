package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestReadView;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;
import java.util.List;

/**
 * REST endpoint for getting additional ranges for a specific comment.
 *
 * <p>GET /changes/{changeId}/multianchor-ranges/{commentUuid}
 *
 * <p>Returns the list of additional ranges for the specified comment. These are ranges beyond the
 * primary range stored in Gerrit core.
 *
 * <p>Example response:
 *
 * <pre>{@code
 * [
 *   {"startLine": 50, "startCharacter": 0, "endLine": 52, "endCharacter": 15},
 *   {"startLine": 100, "startCharacter": 0, "endLine": 105, "endCharacter": 20}
 * ]
 * }</pre>
 *
 * <p>Returns an empty list if no additional ranges exist for this comment.
 */
@Singleton
public class GetMultiAnchorRanges implements RestReadView<MultiAnchorRangesResource> {

  private final MultiAnchorStorage storage;

  @Inject
  GetMultiAnchorRanges(MultiAnchorStorage storage) {
    this.storage = storage;
  }

  @Override
  public Response<List<Range>> apply(MultiAnchorRangesResource rsrc) throws IOException {
    List<Range> ranges =
        storage.getRangesForComment(rsrc.getProject(), rsrc.getChangeId(), rsrc.getCommentUuid());
    return Response.ok(ranges);
  }
}