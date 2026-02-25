package com.googlesource.gerrit.plugins.multianchorcomment.storage;

import com.google.common.flogger.FluentLogger;
import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.server.CurrentUser;
import com.google.gerrit.server.IdentifiedUser;
import com.google.gerrit.server.git.GitRepositoryManager;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.inject.Inject;
import com.google.inject.Provider;
import com.google.inject.Singleton;
import com.google.gerrit.extensions.client.Comment.Range;
import com.googlesource.gerrit.plugins.multianchorcomment.data.MultiAnchorData;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.lib.RefUpdate;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.lib.TreeFormatter;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevTree;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;

/**
 * Storage handler for multi-anchor comment data.
 *
 * <p>Stores additional anchor ranges in plugin-specific Git refs following NoteDb conventions.
 *
 * <p>Storage pattern mirrors Gerrit's draft comment storage:
 *
 * <ul>
 *   <li>Ref: refs/meta/multianchor/{sharded-change-id} (e.g., refs/meta/multianchor/73/67473)
 *   <li>Format: JSON blob in a Git tree, committed with user attribution
 *   <li>Data: Map of comment UUID → list of additional ranges
 * </ul>
 */
@Singleton
public class MultiAnchorStorage {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();
  private static final String REFS_META_MULTIANCHOR = "refs/meta/multianchor/";
  private static final String DATA_FILE = "anchors.json";

  private final GitRepositoryManager repoManager;
  private final Provider<CurrentUser> userProvider;
  private final Gson gson;

  @Inject
  public MultiAnchorStorage(GitRepositoryManager repoManager, Provider<CurrentUser> userProvider) {
    this.repoManager = repoManager;
    this.userProvider = userProvider;
    // Use pretty printing for readability (same as Gerrit's ChangeNoteJson)
    this.gson = new GsonBuilder().setPrettyPrinting().create();
  }

  /**
   * Returns the sharded ref name for storing multi-anchor data.
   *
   * <p>Follows Gerrit's sharding convention: refs/meta/multianchor/{last-2-digits}/{full-id}
   */
  private String getRefName(Change.Id changeId) {
    int id = changeId.get();
    int shard = id % 100;
    return String.format("%s%02d/%d", REFS_META_MULTIANCHOR, shard, id);
  }

  /**
   * Creates a PersonIdent for the current user, or a default if not available.
   *
   * <p>Follows Gerrit's pattern of attributing commits to the acting user.
   */
  private PersonIdent getPersonIdent() {
    CurrentUser user = userProvider.get();
    if (user.isIdentifiedUser()) {
      IdentifiedUser identifiedUser = user.asIdentifiedUser();
      String name = identifiedUser.getName();
      String email = identifiedUser.getEmailAddresses().stream().findFirst().orElse("unknown@gerrit");
      return new PersonIdent(name != null ? name : "Anonymous", email);
    }
    return new PersonIdent("Gerrit Server", "gerrit@localhost");
  }

  /**
   * Loads multi-anchor data for a change from Git storage.
   *
   * <p>Reads the additional anchor ranges stored in the plugin's Git ref. The data is stored as a
   * JSON file (anchors.json) within a Git commit, following NoteDb conventions.
   *
   * <p>Storage location: refs/meta/multianchor/{shard}/{changeId} in the project repository.
   *
   * <p>The loading process:
   *
   * <ol>
   *   <li>Open the project's Git repository
   *   <li>Look up the ref (e.g., refs/meta/multianchor/73/67473) - returns null if no data exists
   *   <li>Parse the commit that the ref points to
   *   <li>Get the tree (directory listing) from the commit
   *   <li>Find "anchors.json" in the tree and get its blob ID
   *   <li>Read the blob content and deserialize from JSON
   * </ol>
   *
   * <p>Example anchors.json content:
   *
   * <pre>{@code
   * {
   *   "additionalRanges": {
   *     "comment-uuid-123": [
   *       {"startLine": 50, "startCharacter": 0, "endLine": 52, "endCharacter": 15},
   *       {"startLine": 100, "startCharacter": 0, "endLine": 105, "endCharacter": 20}
   *     ]
   *   }
   * }
   * }</pre>
   *
   * @param project the project containing the change (used to open the Git repository)
   * @param changeId the change ID (used to construct the ref name)
   * @return the multi-anchor data containing comment UUID to ranges mapping, or a new empty
   *     instance if no data exists for this change
   * @throws IOException if there is an error reading from the Git repository
   */
  public MultiAnchorData load(Project.NameKey project, Change.Id changeId) throws IOException {
    // Step 1: Open the Git repository for this project
    // The repository contains all code, branches, and metadata refs (including our plugin data)
    try (Repository repo = repoManager.openRepository(project)) {

      // Step 2: Build the ref name where our data lives
      // Example: "refs/meta/multianchor/73/67473" for change ID 67473
      String refName = getRefName(changeId);

      // Step 3: Look up the ref - this is like looking up a key in a database
      // The ref is a named pointer that tells us which commit contains our current data
      // Returns null if no data has ever been saved for this change
      Ref ref = repo.exactRef(refName);
      if (ref == null) {
        // No ref exists yet - this change has no multi-anchor data
        return new MultiAnchorData();
      }

      // Step 4: Parse the commit that the ref points to
      // RevWalk is a helper for traversing Git commit history
      try (RevWalk rw = new RevWalk(repo)) {
        // ref.getObjectId() returns the SHA-1 hash of the commit (e.g., "abc123...")
        // parseCommit() reads that commit object from Git's object database
        RevCommit commit = rw.parseCommit(ref.getObjectId());

        // Step 5: Get the tree (directory listing) from the commit
        // The tree tells us what files exist in this commit and their blob IDs
        RevTree tree = commit.getTree();

        // Step 6: Find our data file within the tree
        // TreeWalk.forPath() searches the tree for a file named "anchors.json"
        // Returns null if the file doesn't exist in this commit
        try (TreeWalk tw = TreeWalk.forPath(repo, DATA_FILE, tree)) {
          if (tw == null) {
            // File doesn't exist in this commit (shouldn't happen, but handle gracefully)
            return new MultiAnchorData();
          }

          // Step 7: Get the blob ID for anchors.json
          // The tree entry maps filename -> blob ID (the SHA-1 hash of the file content)
          ObjectId blobId = tw.getObjectId(0);

          // Step 8: Read the blob content from Git's object database
          try (ObjectReader reader = repo.newObjectReader()) {
            // Open the blob by its ID and read all bytes
            byte[] bytes = reader.open(blobId).getBytes();

            // Step 9: Convert bytes to JSON string and deserialize
            String json = new String(bytes, StandardCharsets.UTF_8);
            MultiAnchorData data = gson.fromJson(json, MultiAnchorData.class);
            return data != null ? data : new MultiAnchorData();
          }
        }
      }
    }
  }

  /**
   * Saves multi-anchor data for a change to Git storage.
   *
   * <p>Persists the additional anchor ranges as a JSON file (anchors.json) in a Git commit,
   * following NoteDb conventions. Each save creates a new immutable commit, preserving full
   * history of changes.
   *
   * <p>Storage location: refs/meta/multianchor/{shard}/{changeId} in the project repository.
   *
   * <p>The saving process:
   *
   * <ol>
   *   <li>Serialize the data to JSON
   *   <li>Create a new blob containing the JSON bytes
   *   <li>Create a new tree containing the blob (with filename "anchors.json")
   *   <li>Create a new commit pointing to the tree, with:
   *       <ul>
   *         <li>Author/committer set to the current user (for attribution)
   *         <li>Parent set to the previous commit (if any) to maintain history
   *       </ul>
   *   <li>Update the ref to point to the new commit (atomic operation)
   * </ol>
   *
   * <p>Git objects are immutable, so "updating" data means creating new objects:
   *
   * <pre>{@code
   * Before:  ref → Commit A → Tree X → Blob (old JSON)
   * After:   ref → Commit B → Tree Y → Blob (new JSON)
   *                   ↓
   *               parent: Commit A  (history preserved)
   * }</pre>
   *
   * <p>The ref update is atomic - either it succeeds completely or fails without partial changes.
   * If another process updates the ref concurrently, this operation will fail with an IOException.
   *
   * @param project the project containing the change (used to open the Git repository)
   * @param changeId the change ID (used to construct the ref name)
   * @param data the multi-anchor data to save (will be serialized to JSON)
   * @throws IOException if there is an error writing to the Git repository, or if the ref was
   *     modified concurrently by another process
   */
  public void save(Project.NameKey project, Change.Id changeId, MultiAnchorData data)
      throws IOException {
    try (Repository repo = repoManager.openRepository(project)) {
      String refName = getRefName(changeId);
      PersonIdent author = getPersonIdent();

      try (ObjectInserter inserter = repo.newObjectInserter()) {
        // Create blob with JSON data
        String json = gson.toJson(data);
        ObjectId blobId =
            inserter.insert(Constants.OBJ_BLOB, json.getBytes(StandardCharsets.UTF_8));

        // Create tree with the blob
        TreeFormatter treeFormatter = new TreeFormatter();
        treeFormatter.append(DATA_FILE, org.eclipse.jgit.lib.FileMode.REGULAR_FILE, blobId);
        ObjectId treeId = inserter.insert(treeFormatter);

        // Create commit with user attribution
        CommitBuilder commitBuilder = new CommitBuilder();
        commitBuilder.setTreeId(treeId);
        commitBuilder.setAuthor(author);
        commitBuilder.setCommitter(author);
        commitBuilder.setMessage("Update multi-anchor comment data\n");

        // Set parent if ref exists (creates commit chain like NoteDb)
        Ref existingRef = repo.exactRef(refName);
        if (existingRef != null) {
          commitBuilder.setParentId(existingRef.getObjectId());
        }

        ObjectId commitId = inserter.insert(commitBuilder);
        inserter.flush();

        // Update the ref
        RefUpdate refUpdate = repo.updateRef(refName);
        refUpdate.setNewObjectId(commitId);
        if (existingRef != null) {
          refUpdate.setExpectedOldObjectId(existingRef.getObjectId());
        } else {
          refUpdate.setExpectedOldObjectId(ObjectId.zeroId());
        }
        refUpdate.setRefLogMessage("Update multi-anchor anchors", false);

        RefUpdate.Result result = refUpdate.update();
        switch (result) {
          case NEW:
          case FAST_FORWARD:
          case FORCED:
            logger.atFine().log("Updated %s to %s", refName, commitId.name());
            break;
          default:
            throw new IOException("Failed to update ref " + refName + ": " + result);
        }
      }
    }
  }

  /**
   * Saves ranges for a specific comment.
   *
   * @param project the project
   * @param changeId the change ID
   * @param commentUuid the comment UUID
   * @param ranges the additional ranges (beyond the primary stored in core Gerrit)
   */
  public void saveRanges(
      Project.NameKey project, Change.Id changeId, String commentUuid, List<Range> ranges)
      throws IOException {
    MultiAnchorData data = load(project, changeId);
    data.setRangesForComment(commentUuid, ranges);
    save(project, changeId, data);
  }

  /**
   * Gets all additional ranges for a change.
   *
   * @param project the project
   * @param changeId the change ID
   * @return map of comment UUID to additional ranges
   */
  public Map<String, List<Range>> getRanges(Project.NameKey project, Change.Id changeId)
      throws IOException {
    return load(project, changeId).getAdditionalRanges();
  }

  /**
   * Gets additional ranges for a specific comment.
   *
   * @param project the project
   * @param changeId the change ID
   * @param commentUuid the comment UUID
   * @return list of additional ranges, or empty list if none
   */
  public List<Range> getRangesForComment(
      Project.NameKey project, Change.Id changeId, String commentUuid) throws IOException {
    return load(project, changeId).getRangesForComment(commentUuid);
  }

  /**
   * Deletes ranges for a specific comment.
   *
   * @param project the project
   * @param changeId the change ID
   * @param commentUuid the comment UUID
   */
  public void deleteRanges(Project.NameKey project, Change.Id changeId, String commentUuid)
      throws IOException {
    MultiAnchorData data = load(project, changeId);
    if (data.hasRangesForComment(commentUuid)) {
      data.removeComment(commentUuid);
      save(project, changeId, data);
    }
  }
}
