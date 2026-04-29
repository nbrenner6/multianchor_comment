package com.googlesource.gerrit.plugins.multianchorcomment.data;

import com.google.gerrit.extensions.client.Comment.Range;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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

  /**
   * Returns the map of comment UUIDs to their additional ranges.
   *
   * <p>Returns an unmodifiable view to prevent external mutation of internal state.
   *
   * @return the map of additional ranges for all comments
   */
  public Map<String, List<Range>> getAdditionalRanges() {
    return Collections.unmodifiableMap(additionalRanges);
  }

  /**
   * Sets the additional ranges map, handling null input.
   *
   * @param additionalRanges the map of comment UUIDs to ranges, or null for empty map
   */
  public void setAdditionalRanges(Map<String, List<Range>> additionalRanges) {
    this.additionalRanges = Optional.ofNullable(additionalRanges).orElseGet(HashMap::new);
  }

  /**
   * Retrieves ranges for a specific comment UUID.
   *
   * <p>Returns an empty immutable list for absent keys (no allocation), and a defensive copy when
   * present to prevent external mutation.
   *
   * @param commentUuid the UUID of the comment
   * @return the list of additional ranges, or an empty list if none exist
   */
  public List<Range> getRangesForComment(String commentUuid) {
    List<Range> ranges = additionalRanges.get(commentUuid);
    if (ranges == null) {
      return Collections.emptyList();
    }
    return new ArrayList<>(ranges);
  }

  /**
   * Sets or removes ranges for a comment.
   *
   * <p>If ranges is null or empty, the comment entry is removed from the map.
   *
   * @param commentUuid the UUID of the comment
   * @param ranges the list of ranges to set, or null/empty to remove the entry
   */
  public void setRangesForComment(String commentUuid, List<Range> ranges) {
    if (ranges == null || ranges.isEmpty()) {
      additionalRanges.remove(commentUuid);
    } else {
      additionalRanges.put(commentUuid, new ArrayList<>(ranges));
    }
  }

  /**
   * Removes all additional ranges for a comment.
   *
   * @param commentUuid the UUID of the comment to remove
   */
  public void removeComment(String commentUuid) {
    additionalRanges.remove(commentUuid);
  }

  /**
   * Checks if a comment has additional ranges.
   *
   * @param commentUuid the UUID of the comment to check
   * @return true if the comment has additional ranges, false otherwise
   */
  public boolean hasRangesForComment(String commentUuid) {
    return additionalRanges.containsKey(commentUuid);
  }
}
