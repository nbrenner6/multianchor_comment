package com.googlesource.gerrit.plugins.multianchorcomment.data;

import com.google.gerrit.extensions.client.Comment.Range;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Data model for storing multi-anchor comment ranges.
 *
 * <p>Maps comment UUIDs to their list of ranges. The first/primary range is stored in core Gerrit;
 * additional ranges are stored here.
 */
public class MultiAnchorData {

  /** Maps comment UUID to list of additional ranges (beyond the primary stored in core Gerrit). */
  private Map<String, List<Range>> additionalRanges;

  public MultiAnchorData() {
    this.additionalRanges = new HashMap<>();
  }

  public Map<String, List<Range>> getAdditionalRanges() {
    return additionalRanges;
  }

  public void setAdditionalRanges(Map<String, List<Range>> additionalRanges) {
    this.additionalRanges = additionalRanges != null ? additionalRanges : new HashMap<>();
  }

  public List<Range> getRangesForComment(String commentUuid) {
    return additionalRanges.getOrDefault(commentUuid, new ArrayList<>());
  }

  public void setRangesForComment(String commentUuid, List<Range> ranges) {
    if (ranges == null || ranges.isEmpty()) {
      additionalRanges.remove(commentUuid);
    } else {
      additionalRanges.put(commentUuid, new ArrayList<>(ranges));
    }
  }

  public void removeComment(String commentUuid) {
    additionalRanges.remove(commentUuid);
  }

  public boolean hasRangesForComment(String commentUuid) {
    return additionalRanges.containsKey(commentUuid);
  }
}
