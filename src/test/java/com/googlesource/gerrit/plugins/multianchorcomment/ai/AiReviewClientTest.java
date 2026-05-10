package com.googlesource.gerrit.plugins.multianchorcomment.ai;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import com.google.gerrit.extensions.client.Comment.Range;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

public class AiReviewClientTest {

  @Mock private AiReviewConfig config;
  private AiReviewClient client;

  @Before
  public void setUp() {
    MockitoAnnotations.initMocks(this);
    when(config.getApiKey()).thenReturn("test-key");
    when(config.getApiUrl()).thenReturn("https://api.example.com/v1/messages");
    when(config.getModel()).thenReturn("test-model");
    client = new AiReviewClient(config);
  }

  // --- extractContent tests ---

  @Test
  public void testExtractContentNormalResponse() {
    String response = """
        {"content":[{"text":"[{\\"path\\":\\"a.java\\"}]"}],"stop_reason":"end_turn"}""";

    String result = client.extractContent(response);

    assertEquals("[{\"path\":\"a.java\"}]", result);
  }

  @Test
  public void testExtractContentStripsMarkdownFences() {
    String response = """
        {"content":[{"text":"```json\\n[{\\"path\\":\\"a.java\\"}]\\n```"}],"stop_reason":"end_turn"}""";

    String result = client.extractContent(response);

    assertEquals("[{\"path\":\"a.java\"}]", result);
  }

  @Test
  public void testExtractContentNoFences() {
    String response = """
        {"content":[{"text":"[{\\"path\\":\\"b.java\\"}]"}],"stop_reason":"end_turn"}""";

    String result = client.extractContent(response);

    assertEquals("[{\"path\":\"b.java\"}]", result);
  }

  @Test(expected = RuntimeException.class)
  public void testExtractContentNullContent() {
    String response = """
        {"error":"something went wrong"}""";

    client.extractContent(response);
  }

  @Test
  public void testExtractContentMaxTokensTruncation() {
    // When stop_reason is max_tokens and JSON is truncated, recovery should kick in
    String response = """
        {"content":[{"text":"[{\\"path\\":\\"a.java\\",\\"message\\":\\"ok\\",\\"ranges\\":[]}  ,  {\\"incompl"}],"stop_reason":"max_tokens"}""";

    String result = client.extractContent(response);

    // Should recover the first complete object
    assertTrue(result.startsWith("["));
    assertTrue(result.endsWith("]"));
    assertTrue(result.contains("a.java"));
    assertFalse(result.contains("incompl"));
  }

  @Test
  public void testExtractContentNonMaxTokensStopReason() {
    // When stop_reason is not max_tokens, no recovery should happen even if JSON looks incomplete
    String response = """
        {"content":[{"text":"[{\\"path\\":\\"a.java\\"}]"}],"stop_reason":"end_turn"}""";

    String result = client.extractContent(response);

    assertEquals("[{\"path\":\"a.java\"}]", result);
  }

  // --- recoverTruncatedJsonArray tests ---

  @Test
  public void testRecoverTruncatedJsonArrayCompleteObjects() {
    String input = "[{\"a\":1},{\"b\":2},{\"c\":\"incomplet";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[{\"a\":1},{\"b\":2}]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArrayNoCompleteObjects() {
    String input = "[{\"a\":\"no closing brace";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArrayTrailingComma() {
    String input = "[{\"a\":1},  {\"b\":\"trunc";

    String result = client.recoverTruncatedJsonArray(input);

    // Should remove trailing comma after last complete object
    assertEquals("[{\"a\":1}]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArrayWithStrings() {
    // Braces inside strings should be ignored
    String input = "[{\"msg\":\"use { and } carefully\"},{\"incomp";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[{\"msg\":\"use { and } carefully\"}]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArrayWithEscapedQuotes() {
    // Escaped quotes inside strings should be handled
    String input = "[{\"msg\":\"say \\\"hello\\\"\"},{\"trunc";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[{\"msg\":\"say \\\"hello\\\"\"}]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArraySingleCompleteObject() {
    String input = "[{\"path\":\"a.java\"},{\"path\":\"b.ja";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[{\"path\":\"a.java\"}]", result);
  }

  @Test
  public void testRecoverTruncatedJsonArrayAlreadyComplete() {
    // Already has all complete objects (just missing closing bracket)
    String input = "[{\"a\":1},{\"b\":2}";

    String result = client.recoverTruncatedJsonArray(input);

    assertEquals("[{\"a\":1},{\"b\":2}]", result);
  }

  // --- toAiComment tests ---

  @Test
  public void testToAiCommentFieldMapping() {
    AiReviewClient.AiCommentJson raw = new AiReviewClient.AiCommentJson(
        "src/Main.java",
        "Fix this bug",
        List.of(new AiReviewClient.AiRangeJson(10, 0, 12, 5))
    );

    AiReviewClient.AiComment result = client.toAiComment(raw);

    assertEquals("src/Main.java", result.path);
    assertEquals("Fix this bug", result.message);
    assertEquals(1, result.allRanges.size());
    assertNotNull(result.primaryRange);
    assertEquals(10, result.primaryRange.startLine);
    assertEquals(0, result.primaryRange.startCharacter);
    assertEquals(12, result.primaryRange.endLine);
    assertEquals(5, result.primaryRange.endCharacter);
  }

  @Test
  public void testToAiCommentMultipleRanges() {
    AiReviewClient.AiCommentJson raw = new AiReviewClient.AiCommentJson(
        "src/Foo.java",
        "Repeated pattern",
        List.of(
            new AiReviewClient.AiRangeJson(1, 0, 3, 0),
            new AiReviewClient.AiRangeJson(10, 2, 15, 8),
            new AiReviewClient.AiRangeJson(20, 0, 22, 0)
        )
    );

    AiReviewClient.AiComment result = client.toAiComment(raw);

    assertEquals(3, result.allRanges.size());
    // Primary range should be the first one
    assertEquals(1, result.primaryRange.startLine);

    // Verify all ranges are converted correctly
    Range second = result.allRanges.get(1);
    assertEquals(10, second.startLine);
    assertEquals(2, second.startCharacter);
    assertEquals(15, second.endLine);
    assertEquals(8, second.endCharacter);

    Range third = result.allRanges.get(2);
    assertEquals(20, third.startLine);
    assertEquals(22, third.endLine);
  }
}
