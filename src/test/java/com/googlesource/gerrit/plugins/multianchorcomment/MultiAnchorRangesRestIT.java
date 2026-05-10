package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.common.truth.Truth.assertThat;

import com.google.common.reflect.TypeToken;
import com.google.gerrit.acceptance.LightweightPluginDaemonTest;
import com.google.gerrit.acceptance.PushOneCommit;
import com.google.gerrit.acceptance.RestResponse;
import com.google.gerrit.acceptance.TestPlugin;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.json.OutputFormat;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.SaveMultiAnchorRanges;
import java.io.Reader;
import java.lang.reflect.Type;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Test;

@TestPlugin(
    name = "multianchor_comment",
    sysModule = "com.googlesource.gerrit.plugins.multianchorcomment.PluginModule"
)
public class MultiAnchorRangesRestIT extends LightweightPluginDaemonTest {

  @Test
  public void saveGetListAndDeleteRanges() throws Exception {
    ChangeContext ctx = createChangeContext();
    String endpoint = rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-1");

    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Arrays.asList(
        rangeInput(1, 0, 2, 3),
        rangeInput(5, 1, 5, 4));

    RestResponse saveResponse = adminRestSession.put(endpoint, input);
    saveResponse.assertOK();
    List<Range> saved = parseJson(saveResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(saved).hasSize(2);

    RestResponse getResponse = adminRestSession.get(endpoint);
    getResponse.assertOK();
    List<Range> fetched = parseJson(getResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(fetched).hasSize(2);
    assertThat(fetched.get(0).startLine).isEqualTo(1);
    assertThat(fetched.get(1).endCharacter).isEqualTo(4);

    RestResponse listResponse = adminRestSession.get(listEndpoint(ctx.changeId));
    listResponse.assertOK();
    Map<String, List<Range>> allRanges =
        parseJson(listResponse, new TypeToken<Map<String, List<Range>>>() {}.getType());
    assertThat(allRanges).containsKey(ctx.patchSet + "/uuid-1");
    assertThat(allRanges.get(ctx.patchSet + "/uuid-1")).hasSize(2);

    adminRestSession.delete(endpoint).assertNoContent();

    RestResponse getAfterDelete = adminRestSession.get(endpoint);
    getAfterDelete.assertOK();
    List<Range> empty = parseJson(getAfterDelete, new TypeToken<List<Range>>() {}.getType());
    assertThat(empty).isEmpty();
  }

  @Test
  public void saveRejectsMissingOrInvalidRanges() throws Exception {
    ChangeContext ctx = createChangeContext();
    String endpoint = rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-2");

    adminRestSession.put(endpoint).assertBadRequest();

    SaveMultiAnchorRanges.Input nullRangeInput = new SaveMultiAnchorRanges.Input();
    nullRangeInput.ranges = Arrays.asList((SaveMultiAnchorRanges.RangeInput) null);
    adminRestSession.put(endpoint, nullRangeInput).assertBadRequest();

    SaveMultiAnchorRanges.Input invalidRangeInput = new SaveMultiAnchorRanges.Input();
    invalidRangeInput.ranges = Arrays.asList(rangeInput(0, 0, 1, 1));
    adminRestSession.put(endpoint, invalidRangeInput).assertBadRequest();

    SaveMultiAnchorRanges.Input negativeCharInput = new SaveMultiAnchorRanges.Input();
    negativeCharInput.ranges = Arrays.asList(rangeInput(1, -1, 1, 1));
    adminRestSession.put(endpoint, negativeCharInput).assertBadRequest();

    SaveMultiAnchorRanges.Input negativeEndCharInput = new SaveMultiAnchorRanges.Input();
    negativeEndCharInput.ranges = Arrays.asList(rangeInput(1, 0, 1, -2));
    adminRestSession.put(endpoint, negativeEndCharInput).assertBadRequest();

    SaveMultiAnchorRanges.Input reversedLineInput = new SaveMultiAnchorRanges.Input();
    reversedLineInput.ranges = Arrays.asList(rangeInput(3, 0, 2, 1));
    adminRestSession.put(endpoint, reversedLineInput).assertBadRequest();

    SaveMultiAnchorRanges.Input reversedCharInput = new SaveMultiAnchorRanges.Input();
    reversedCharInput.ranges = Arrays.asList(rangeInput(2, 5, 2, 1));
    adminRestSession.put(endpoint, reversedCharInput).assertBadRequest();
  }

  @Test
  public void invalidCompositeIdReturnsNotFound() throws Exception {
    ChangeContext ctx = createChangeContext();

    adminRestSession
        .get("/changes/" + ctx.changeId + "/multianchor-ranges/bad")
        .assertNotFound();
    adminRestSession
      .get("/changes/" + ctx.changeId + "/multianchor-ranges/1~")
      .assertNotFound();
    adminRestSession
      .get("/changes/" + ctx.changeId + "/multianchor-ranges/~uuid")
      .assertNotFound();
    adminRestSession
        .get("/changes/" + ctx.changeId + "/multianchor-ranges/0~uuid")
        .assertNotFound();
    adminRestSession
        .get("/changes/" + ctx.changeId + "/multianchor-ranges/abc~uuid")
        .assertNotFound();
  }

    @Test
    public void listEmptyBeforeSaveAndDeleteIsIdempotent() throws Exception {
    ChangeContext ctx = createChangeContext();

    RestResponse listResponse = adminRestSession.get(listEndpoint(ctx.changeId));
    listResponse.assertOK();
    Map<String, List<Range>> emptyMap =
      parseJson(listResponse, new TypeToken<Map<String, List<Range>>>() {}.getType());
    assertThat(emptyMap).isEmpty();

    String endpoint = rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-4");
    adminRestSession.delete(endpoint).assertNoContent();

    RestResponse getResponse = adminRestSession.get(endpoint);
    getResponse.assertOK();
    List<Range> empty = parseJson(getResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(empty).isEmpty();
    }

    @Test
    public void listIncludesMultipleComments() throws Exception {
    ChangeContext ctx = createChangeContext();

    SaveMultiAnchorRanges.Input inputA = new SaveMultiAnchorRanges.Input();
    inputA.ranges = Arrays.asList(rangeInput(1, 0, 1, 3));
    adminRestSession
      .put(rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-a"), inputA)
      .assertOK();

    SaveMultiAnchorRanges.Input inputB = new SaveMultiAnchorRanges.Input();
    inputB.ranges = Arrays.asList(rangeInput(2, 0, 2, 4), rangeInput(3, 0, 3, 2));
    adminRestSession
      .put(rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-b"), inputB)
      .assertOK();

    RestResponse listResponse = adminRestSession.get(listEndpoint(ctx.changeId));
    listResponse.assertOK();
    Map<String, List<Range>> allRanges =
      parseJson(listResponse, new TypeToken<Map<String, List<Range>>>() {}.getType());

    assertThat(allRanges).containsKey(ctx.patchSet + "/uuid-a");
    assertThat(allRanges).containsKey(ctx.patchSet + "/uuid-b");
    assertThat(allRanges.get(ctx.patchSet + "/uuid-a")).hasSize(1);
    assertThat(allRanges.get(ctx.patchSet + "/uuid-b")).hasSize(2);
    }

  @Test
  public void currentPatchSetAliasWorks() throws Exception {
    ChangeContext ctx = createChangeContext();
    String currentEndpoint = rangesEndpoint(ctx.changeId, "current", "uuid-3");

    SaveMultiAnchorRanges.Input input = new SaveMultiAnchorRanges.Input();
    input.ranges = Arrays.asList(rangeInput(3, 0, 3, 2));

    adminRestSession.put(currentEndpoint, input).assertOK();

    String numericEndpoint = rangesEndpoint(ctx.changeId, String.valueOf(ctx.patchSet), "uuid-3");
    RestResponse getResponse = adminRestSession.get(numericEndpoint);
    getResponse.assertOK();
    List<Range> fetched = parseJson(getResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(fetched).hasSize(1);
    assertThat(fetched.get(0).endCharacter).isEqualTo(2);
  }

  private ChangeContext createChangeContext() throws Exception {
    PushOneCommit.Result result = createChange();
    int changeNumber = result.getChange().change().getId().get();
    int patchSet = result.getPatchSetId().get();
    return new ChangeContext(String.valueOf(changeNumber), patchSet);
  }

  private String listEndpoint(String changeId) {
    return "/changes/" + changeId + "/multianchor-ranges";
  }

  private String rangesEndpoint(String changeId, String patchSet, String uuid) {
    return "/changes/" + changeId + "/multianchor-ranges/" + patchSet + "~" + uuid;
  }

  private SaveMultiAnchorRanges.RangeInput rangeInput(
      int startLine, int startCharacter, int endLine, int endCharacter) {
    SaveMultiAnchorRanges.RangeInput range = new SaveMultiAnchorRanges.RangeInput();
    range.startLine = startLine;
    range.startCharacter = startCharacter;
    range.endLine = endLine;
    range.endCharacter = endCharacter;
    return range;
  }

  private <T> T parseJson(RestResponse response, Type type) throws Exception {
    try (Reader reader = response.getReader()) {
      return OutputFormat.JSON_COMPACT.newGson().fromJson(reader, type);
    }
  }

  private static class ChangeContext {
    private final String changeId;
    private final int patchSet;

    private ChangeContext(String changeId, int patchSet) {
      this.changeId = changeId;
      this.patchSet = patchSet;
    }
  }
}
