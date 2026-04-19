package com.googlesource.gerrit.plugins.multianchorcomment.ai;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.google.inject.Inject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;

public class AiReviewClient {

  public static class AiComment {
    public String path;
    public String message;
    public List<Range> allRanges;
    public Range primaryRange;
  }

  private record AiRangeJson(int startLine, int startCharacter, int endLine, int endCharacter) {}
  private record AiCommentJson(String path, String message, List<AiRangeJson> ranges) {}
  private record Message(String role, String content) {}
  private record ChatRequest(String model, String system, List<Message> messages, int max_tokens) {}

  private static final String SYSTEM_PROMPT = """
    You are a code reviewer. Analyze the provided unified diff and return a JSON array
    of review comments. Each comment must follow this exact schema:

    [
      {
        "path": "src/Foo.java",
        "message": "Your review comment explaining the issue across all highlighted locations",
        "ranges": [
          {"startLine": 10, "startCharacter": 0, "endLine": 12, "endCharacter": 0},
          {"startLine": 45, "startCharacter": 0, "endLine": 45, "endCharacter": 0},
          {"startLine": 78, "startCharacter": 0, "endLine": 78, "endCharacter": 0}
        ]
      }
    ]

    CRITICAL RULES - you MUST follow these:

    1. ALWAYS look for patterns that appear in MULTIPLE locations and group them into ONE
       comment with MULTIPLE ranges. This is the most important feature of this review tool.

    2. Examples of when to use multiple ranges:
       - The same variable used incorrectly in several places -> one comment, all locations
       - A missing null check that should appear at multiple call sites -> one comment, all sites
       - A repeated code pattern that should be extracted -> one comment, all occurrences
       - Inconsistent naming across several lines -> one comment, all affected lines
       - The same anti-pattern repeated throughout the file -> one comment, every occurrence

    3. NEVER post separate comments for the same issue appearing in multiple places.
       Always combine them into one comment with multiple ranges.

    4. Single-range comments are only acceptable for truly isolated issues that appear
       exactly once and have no relation to any other part of the code.

    5. Aim for at least 50% of your comments to have multiple ranges.

    6. startLine/endLine are 1-based line numbers in the NEW file (lines starting with + or space).
       Do NOT reference removed lines (starting with -).

    7. Return ONLY the JSON array, no explanation, no markdown fences.
    """;

  private final HttpClient http;
  private final Gson gson;
  private final String apiKey;
  private final String apiUrl;
  private final String model;

  @Inject
  public AiReviewClient(AiReviewConfig config) {
    this.http   = HttpClient.newHttpClient();
    this.gson   = new Gson();
    this.apiKey = config.getApiKey();
    this.apiUrl = config.getApiUrl();
    this.model  = config.getModel();
  }

  public List<AiComment> review(String diff, String userPrompt) throws Exception {
    String userContent = """
    This code review tool supports multi-anchor comments — a single comment can highlight
    multiple non-adjacent line ranges simultaneously. Please make heavy use of this feature
    by grouping related issues across different locations into one comment with multiple ranges.

    Review this diff:

    """ + diff +
        (userPrompt != null && !userPrompt.isEmpty() ? "\n\nAdditional focus: " + userPrompt : "");

    String payload = gson.toJson(new ChatRequest(
        model,
        SYSTEM_PROMPT,
        List.of(new Message("user", userContent)),
        1000
    ));

    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(apiUrl))
        .header("x-api-key",         apiKey)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type",      "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(payload))
        .build();

    HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
    System.err.println("AI API raw response: " + response.body());
    String json = extractContent(response.body());

    List<AiCommentJson> raw = gson.fromJson(json,
        new TypeToken<List<AiCommentJson>>(){}.getType());

    return raw.stream().map(this::toAiComment).toList();
  }

  private AiComment toAiComment(AiCommentJson raw) {
    AiComment c   = new AiComment();
    c.path        = raw.path();
    c.message     = raw.message();
    c.allRanges   = raw.ranges().stream().map(r -> {
      Range range          = new Range();
      range.startLine      = r.startLine();
      range.startCharacter = r.startCharacter();
      range.endLine        = r.endLine();
      range.endCharacter   = r.endCharacter();
      return range;
    }).toList();
    c.primaryRange = c.allRanges.get(0);
    return c;
  }

  private String extractContent(String responseBody) {
    var parsed  = gson.fromJson(responseBody, java.util.Map.class);

    var content = (List<?>) parsed.get("content");
    if (content == null) {
      throw new RuntimeException("AI API error: " + responseBody);
    }
    var first = (java.util.Map<?,?>) content.get(0);
    String text = (String) first.get("text");

    // Strip markdown code fences if present
    text = text.strip();
    if (text.startsWith("```")) {
      text = text.replaceAll("^```[a-z]*\\n?", "").replaceAll("```$", "").strip();
    }

    return text;
  }
}
