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

  record AiRangeJson(int startLine, int startCharacter, int endLine, int endCharacter) {}
  record AiCommentJson(String path, String message, List<AiRangeJson> ranges) {}
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
        4096
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

  AiComment toAiComment(AiCommentJson raw) {
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

  String extractContent(String responseBody) {
    var parsed  = gson.fromJson(responseBody, java.util.Map.class);

    // Surface stop_reason so truncation is visible in logs
    String stopReason = (String) parsed.get("stop_reason");
    if ("max_tokens".equals(stopReason)) {
      System.err.println("[multianchor] WARNING: AI response was truncated (max_tokens reached). " +
          "Increase max_tokens or ask for fewer comments.");
    }

    var content = (List<?>) parsed.get("content");
    if (content == null) {
      throw new RuntimeException("AI API error: " + responseBody);
    }
    var first  = (java.util.Map<?,?>) content.get(0);
    String text = (String) first.get("text");

    // Strip markdown fences
    text = text.strip();
    if (text.startsWith("```")) {
      text = text.replaceAll("^```[a-z]*\\n?", "").replaceAll("```$", "").strip();
    }

    // If the response was truncated, the JSON array will be incomplete.
    // Recover by trimming to the last complete object so we can parse what we got.
    if ("max_tokens".equals(stopReason)) {
      text = recoverTruncatedJsonArray(text);
    }

    return text;
  }

  /**
   * Given a truncated JSON array string like:
   *   [{"a":1}, {"b":2}, {"c":"incomplet
   * Returns the longest valid prefix as a closed array:
   *   [{"a":1}, {"b":2}]
   */
  String recoverTruncatedJsonArray(String text) {
    // Walk backwards from the end to find the last '}' that closes a complete object.
    // Then close the array after it.
    int depth = 0;
    int lastCompleteObjectEnd = -1;
    boolean inString = false;
    char[] chars = text.toCharArray();

    for (int i = 0; i < chars.length; i++) {
      char c = chars[i];
      if (c == '\\' && inString) { i++; continue; } // skip escaped char
      if (c == '"')  { inString = !inString; continue; }
      if (inString)  { continue; }
      if (c == '{')  { depth++; }
      if (c == '}')  {
        depth--;
        if (depth == 0) lastCompleteObjectEnd = i; // top-level object closed
      }
    }

    if (lastCompleteObjectEnd == -1) {
      System.err.println("[multianchor] Could not recover any complete objects from truncated response.");
      return "[]";
    }

    // Slice to include everything up to and including the last complete object,
    // then close the array.
    String recovered = text.substring(0, lastCompleteObjectEnd + 1).stripTrailing();
    // Remove any trailing comma left after the last complete object
    if (recovered.endsWith(",")) {
      recovered = recovered.substring(0, recovered.length() - 1);
    }
    recovered = recovered + "]";
    System.err.println("[multianchor] Recovered " + recovered.chars().filter(c -> c == '{').count() + " complete comments from truncated response.");
    return recovered;
  }
}
