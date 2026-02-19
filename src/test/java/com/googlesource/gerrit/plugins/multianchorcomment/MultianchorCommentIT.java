package com.googlesource.gerrit.plugins.hooks;

import com.google.gerrit.acceptance.LightweightPluginDaemonTest;
import com.google.gerrit.acceptance.NoHttpd;
import com.google.gerrit.acceptance.TestPlugin;
import org.junit.Test;

@NoHttpd
@TestPlugin(name = "hooks", sysModule = "com.googlesource.gerrit.plugins.hooks.PluginModule")
public class HooksIT extends LightweightPluginDaemonTest {

  @Test
  public void doNothing() throws Exception {}
}
