package com.googlesource.gerrit.plugins.multianchorcomment.ai;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.google.inject.Inject;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;

public class AiReviewClient {

  /** A single AI-generated review comment, potentially spanning multiple ranges. */
  public static class AiComment {
    public String path;
    public String message;
    public List<Range> allRanges;   // first = primary, rest = additional anchors
    public Range primaryRange;       // convenience alias for allRanges.get(0)
  }

  // Internal structure matching what we ask the LLM to return
  private record AiRangeJson(int startLine, int startCharacter, int endLine, int endCharacter) {}
  private record AiCommentJson(String path, String message, List<AiRangeJson> ranges) {}

  private static final String SYSTEM_PROMPT = """
      You are a code reviewer. Analyze the provided unified diff and return a JSON array
      of review comments. Each comment must follow this exact schema:

      [
        {
          "path": "src/Foo.java",
          "message": "Your review comment",
          "ranges": [
            {"startLine": 10, "startCharacter": 0, "endLine": 12, "endCharacter": 0},
            {"startLine": 45, "startCharacter": 0, "endLine": 45, "endCharacter": 0}
          ]
        }
      ]

      Rules:
      - Use MULTIPLE ranges when the same issue appears in several locations (e.g. a missing
        null check at 3 call sites). This is preferred over separate comments.
      - startLine/endLine are 1-based line numbers in the NEW file.
      - Return ONLY the JSON array, no explanation, no markdown fences.
      """;

  private final HttpClient http;
  private final Gson gson;
  private final String apiKey;
  private final String apiUrl;

  @Inject
  public AiReviewClient(@ApiKey String apiKey, @ApiUrl String apiUrl) {
    this.http   = HttpClient.newHttpClient();
    this.gson   = new Gson();
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  public List<AiComment> review(String diff, String userPrompt) throws Exception {
    String userContent = "Review this diff:\n\n" + diff +
        (userPrompt != null ? "\n\nFocus: " + userPrompt : "");

    // Build request payload (adjust shape for your chosen LLM API)
    String payload = gson.toJson(new ChatRequest(
        "gpt-4o",
        List.of(
            new Message("system", SYSTEM_PROMPT),
            new Message("user",   userContent)
        )
    ));

    var request = HttpRequest.newBuilder()
        .uri(java.net.URI.create(apiUrl))
        .header("Authorization", "Bearer " + apiKey)
        .header("Content-Type",  "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(payload))
        .build();

    var response = http.send(request, HttpResponse.BodyHandlers.ofString());
    String json  = extractContent(response.body());  // parse out the message content

    // Deserialize AI output into our internal type
    List<AiCommentJson> raw = gson.fromJson(json,
        new TypeToken<List<AiCommentJson>>(){}.getType());

    return raw.stream().map(this::toAiComment).toList();
  }

  private AiComment toAiComment(AiCommentJson raw) {
    AiComment c = new AiComment();
    c.path    = raw.path();
    c.message = raw.message();
    c.allRanges = raw.ranges().stream().map(r -> {
      Range range         = new Range();
      range.startLine     = r.startLine();
      range.startCharacter = r.startCharacter();
      range.endLine       = r.endLine();
      range.endCharacter  = r.endCharacter();
      return range;
    }).toList();
    c.primaryRange = c.allRanges.get(0);
    return c;
  }

  // Minimal request/message POJOs for JSON serialization
  private record ChatRequest(String model, List<Message> messages) {}
  private record Message(String role, String content) {}

  private String extractContent(String responseBody) {
    // Parse the LLM response envelope and return just the message text
    // Shape varies by provider — this matches OpenAI's format
    var parsed = gson.fromJson(responseBody, java.util.Map.class);
    var choices = (List<?>) parsed.get("choices");
    var first   = (java.util.Map<?,?>) choices.get(0);
    var message = (java.util.Map<?,?>) first.get("message");
    return (String) message.get("content");
  }
}
