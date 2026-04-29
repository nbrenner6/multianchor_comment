package com.googlesource.gerrit.plugins.multianchorcomment.ai;

import com.google.gerrit.extensions.annotations.PluginName;
import com.google.gerrit.server.config.PluginConfig;
import com.google.gerrit.server.config.PluginConfigFactory;
import com.google.inject.Inject;
import com.google.inject.Singleton;

@Singleton
public class AiReviewConfig {

  private static final String DEFAULT_URL =
      "https://api.openai.com/v1/chat/completions";

  private final String apiKey;
  private final String apiUrl;
  private final String model;

  @Inject
  public AiReviewConfig(PluginConfigFactory configFactory,
                        @PluginName String pluginName) {
    PluginConfig cfg = configFactory.getFromGerritConfig(pluginName);
    this.apiKey = cfg.getString("aiApiKey", "");
    this.apiUrl = cfg.getString("aiApiUrl", DEFAULT_URL);
    this.model  = cfg.getString("aiModel",  "gpt-4o");
  }

  public String getApiKey() { return apiKey; }
  public String getApiUrl() { return apiUrl; }
  public String getModel()  { return model;  }
}
