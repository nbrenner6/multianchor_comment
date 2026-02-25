package com.googlesource.gerrit.plugins.multianchorcomment.data;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.common.CommentInfo;
import java.util.ArrayList;
import java.util.List;

/**
 * Extended comment info that includes all anchor ranges.
 *
 * <p>Combines the primary range from core Gerrit with additional ranges from plugin storage.
 */
public class MultiAnchorCommentInfo extends CommentInfo {

  /** All ranges for this comment (primary + additional). */
  public List<Range> allRanges;

  /** Whether this comment has multiple anchors. */
  public Boolean isMultiAnchor;

  /** Creates a MultiAnchorCommentInfo from a core CommentInfo. */
  public static MultiAnchorCommentInfo fromCommentInfo(CommentInfo info) {
    MultiAnchorCommentInfo result = new MultiAnchorCommentInfo();

    // Copy all fields from CommentInfo
    result.patchSet = info.patchSet;
    result.id = info.id;
    result.path = info.path;
    result.side = info.side;
    result.parent = info.parent;
    result.line = info.line;
    result.range = info.range;
    result.inReplyTo = info.inReplyTo;
    result.updated = info.updated;
    result.message = info.message;
    result.commitId = info.commitId;
    result.fixSuggestions = info.fixSuggestions;
    result.author = info.author;
    result.tag = info.tag;
    result.changeMessageId = info.changeMessageId;
    result.unresolved = info.unresolved;
    result.contextLines = info.contextLines;
    result.sourceContentType = info.sourceContentType;

    // Initialize allRanges with the primary range
    result.allRanges = new ArrayList<>();
    if (info.range != null) {
      result.allRanges.add(info.range);
    }
    result.isMultiAnchor = false;

    return result;
  }

  /** Adds additional ranges from plugin storage. */
  public void addAdditionalRanges(List<Range> additionalRanges) {
    if (additionalRanges != null && !additionalRanges.isEmpty()) {
      allRanges.addAll(additionalRanges);
      isMultiAnchor = allRanges.size() > 1;
    }
  }
}
