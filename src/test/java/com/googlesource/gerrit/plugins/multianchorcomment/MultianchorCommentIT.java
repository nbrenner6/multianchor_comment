package com.googlesource.gerrit.plugins.multianchorcomment;

import com.google.gerrit.acceptance.LightweightPluginDaemonTest;
import com.google.gerrit.acceptance.NoHttpd;
import com.google.gerrit.acceptance.TestPlugin;
import org.junit.Test;

@NoHttpd
@TestPlugin(
    name = "multianchor_comment",
    sysModule = "com.googlesource.gerrit.plugins.multianchorcomment.PluginModule"
)
public class MultiAnchorCommentIT extends LightweightPluginDaemonTest {

  @Test
  public void pluginLoads() throws Exception {
  }
}
