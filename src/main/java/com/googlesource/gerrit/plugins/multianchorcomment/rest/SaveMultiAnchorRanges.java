package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.BadRequestException;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestModifyView;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * REST endpoint for saving additional ranges for a comment.
 *
 * <p>PUT /changes/{changeId}/multianchor-ranges/{commentUuid}
 *
 * <p>Saves the additional anchor ranges for the specified comment. These ranges are stored
 * separately from the primary range in Gerrit core, allowing comments to span multiple
 * non-contiguous code sections.
 *
 * <p>Example request body:
 *
 * <pre>{@code
 * {
 *   "ranges": [
 *     {"startLine": 50, "startCharacter": 0, "endLine": 52, "endCharacter": 15},
 *     {"startLine": 100, "startCharacter": 0, "endLine": 105, "endCharacter": 20}
 *   ]
 * }
 * }</pre>
 *
 * <p>The ranges are validated before saving:
 *
 * <ul>
 *   <li>startLine and endLine must be positive (1-based)
 *   <li>startCharacter and endCharacter must be non-negative (0-based)
 *   <li>Start position must be before or equal to end position
 * </ul>
 */
@Singleton
public class SaveMultiAnchorRanges
    implements RestModifyView<MultiAnchorRangesResource, SaveMultiAnchorRanges.Input> {

  /** Simple POJO for JSON deserialization of range data. */
  public static class RangeInput {
    public int startLine;
    public int startCharacter;
    public int endLine;
    public int endCharacter;

    /** Converts to Comment.Range for storage. */
    public Range toRange() {
      Range r = new Range();
      r.startLine = this.startLine;
      r.startCharacter = this.startCharacter;
      r.endLine = this.endLine;
      r.endCharacter = this.endCharacter;
      return r;
    }

    public boolean isValid() {
      return startLine > 0
          && startCharacter >= 0
          && endLine > 0
          && endCharacter >= 0
          && startLine <= endLine
          && (startLine != endLine || startCharacter <= endCharacter);
    }
  }

  /** Input class for the request body. */
  public static class Input {
    /** The additional ranges to save for this comment. */
    public List<RangeInput> ranges;
  }

  private final MultiAnchorStorage storage;

  @Inject
  SaveMultiAnchorRanges(MultiAnchorStorage storage) {
    this.storage = storage;
  }

  @Override
  public Response<List<Range>> apply(MultiAnchorRangesResource rsrc, Input input)
      throws IOException, BadRequestException {
    if (input == null || input.ranges == null) {
      throw new BadRequestException("ranges field is required");
    }

    // Validate and convert all ranges
    List<Range> ranges = new ArrayList<>();
    for (RangeInput rangeInput : input.ranges) {
      if (!rangeInput.isValid()) {
        throw new BadRequestException(
            String.format(
                "Invalid range: startLine=%d, startCharacter=%d, endLine=%d, endCharacter=%d. "
                    + "Lines must be positive, characters non-negative, and start must be <= end.",
                rangeInput.startLine,
                rangeInput.startCharacter,
                rangeInput.endLine,
                rangeInput.endCharacter));
      }
      ranges.add(rangeInput.toRange());
    }

    storage.saveRanges(rsrc.getProject(), rsrc.getChangeId(), rsrc.getCommentUuid(), ranges);

    return Response.ok(ranges);
  }
}