package com.googlesource.gerrit.plugins.multianchorcomment.ai;

import static com.google.common.truth.Truth.assertThat;
import static org.junit.Assert.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.gerrit.server.config.PluginConfig;
import com.google.gerrit.server.config.PluginConfigFactory;
import com.google.gson.JsonSyntaxException;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

public class AiReviewClientTest {

  @Test
  public void reviewParsesJsonResponse() throws Exception {
    String responseBody =
        "{\"content\":[{\"text\":\"" +
        "[{\\\"path\\\":\\\"a.txt\\\",\\\"message\\\":\\\"msg\\\"," +
        "\\\"ranges\\\":[{\\\"startLine\\\":1,\\\"startCharacter\\\":0," +
        "\\\"endLine\\\":1,\\\"endCharacter\\\":1}]}]" +
        "\"}],\"stop_reason\":null}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      List<AiReviewClient.AiComment> comments = client.review("diff", "");

      assertThat(comments).hasSize(1);
      assertThat(comments.get(0).path).isEqualTo("a.txt");
      assertThat(comments.get(0).allRanges).hasSize(1);
      assertThat(comments.get(0).primaryRange.endCharacter).isEqualTo(1);
    }
  }

  @Test
  public void reviewRecoversTruncatedJsonArray() throws Exception {
    String responseBody =
        "{\"content\":[{\"text\":\"" +
        "[{\\\"path\\\":\\\"a.txt\\\",\\\"message\\\":\\\"msg\\\"," +
        "\\\"ranges\\\":[{\\\"startLine\\\":1,\\\"startCharacter\\\":0," +
        "\\\"endLine\\\":1,\\\"endCharacter\\\":1}]}," +
        "{\\\"path\\\":\\\"b.txt\\\",\\\"message\\\":\\\"msg2\\\"," +
      "\\\"ranges\\\":[{\\\"startLine\\\":2,\\\"startCharacter\\\":0" +
      "\"}],\"stop_reason\":\"max_tokens\"}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      List<AiReviewClient.AiComment> comments = client.review("diff", "");

      assertThat(comments).hasSize(1);
      assertThat(comments.get(0).path).isEqualTo("a.txt");
    }
  }

  @Test
  public void reviewRecoversWithNoCompleteObjects() throws Exception {
    String truncated = "[{\"path\":\"a.txt\"";
    String responseBody =
      "{\"content\":[{\"text\":\"" + jsonEscape(truncated) + "\"}]," +
      "\"stop_reason\":\"max_tokens\"}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      List<AiReviewClient.AiComment> comments = client.review("diff", "");

      assertThat(comments).isEmpty();
    }
  }

  @Test
  public void reviewRecoversTrailingComma() throws Exception {
    String truncated =
      "[{\"path\":\"a.txt\",\"message\":\"msg\"," +
      "\"ranges\":[{\"startLine\":1,\"startCharacter\":0," +
      "\"endLine\":1,\"endCharacter\":1}],}";
    String responseBody =
      "{\"content\":[{\"text\":\"" + jsonEscape(truncated) + "\"}]," +
      "\"stop_reason\":\"max_tokens\"}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      assertThrows(JsonSyntaxException.class, () -> client.review("diff", ""));
    }
  }

  @Test
  public void reviewStripsMarkdownFence() throws Exception {
    String responseBody =
        "{\"content\":[{\"text\":\"```json\\n" +
        "[{\\\"path\\\":\\\"a.txt\\\",\\\"message\\\":\\\"msg\\\"," +
        "\\\"ranges\\\":[{\\\"startLine\\\":1,\\\"startCharacter\\\":0," +
        "\\\"endLine\\\":1,\\\"endCharacter\\\":1}]}]\\n```\"}]," +
        "\"stop_reason\":null}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      List<AiReviewClient.AiComment> comments = client.review("diff", "");

      assertThat(comments).hasSize(1);
      assertThat(comments.get(0).path).isEqualTo("a.txt");
    }
  }

  @Test
  public void reviewFailsWithoutContent() throws Exception {
    String responseBody = "{\"stop_reason\":null}";

    try (TestServer server = new TestServer(responseBody)) {
      AiReviewClient client = createClient(server.url());
      assertThrows(RuntimeException.class, () -> client.review("diff", ""));
    }
  }

  private AiReviewClient createClient(String url) {
    PluginConfigFactory configFactory = mock(PluginConfigFactory.class);
    PluginConfig config = mock(PluginConfig.class);
    when(configFactory.getFromGerritConfig("multianchor_comment")).thenReturn(config);
    when(config.getString(eq("aiApiKey"), anyString())).thenReturn("test-key");
    when(config.getString(eq("aiApiUrl"), anyString())).thenReturn(url);
    when(config.getString(eq("aiModel"), anyString())).thenReturn("gpt-4o");

    return new AiReviewClient(new AiReviewConfig(configFactory, "multianchor_comment"));
  }

  private static class TestServer implements AutoCloseable {
    private final HttpServer server;

    private TestServer(String responseBody) throws IOException {
      server = HttpServer.create(new InetSocketAddress(0), 0);
      server.createContext("/", exchange -> {
        byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream os = exchange.getResponseBody()) {
          os.write(body);
        }
      });
      server.start();
    }

    private String url() {
      return "http://localhost:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }

  private static String jsonEscape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }
}
