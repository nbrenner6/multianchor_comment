package com.googlesource.gerrit.plugins.multianchorcomment.data;

import com.google.gerrit.extensions.api.changes.DraftInput;
import com.google.gerrit.extensions.client.Comment.Range;
import java.util.List;

/**
 * Extended draft input that supports multiple anchor ranges.
 *
 * <p>The first range in {@code allRanges} becomes the primary range stored in core Gerrit.
 * Additional ranges are stored in plugin-specific storage.
 */
public class MultiAnchorDraftInput extends DraftInput {

  /**
   * All ranges for this comment. The first range is the primary anchor stored in core Gerrit;
   * subsequent ranges are additional anchors stored in plugin storage.
   */
  public List<Range> allRanges;
}
