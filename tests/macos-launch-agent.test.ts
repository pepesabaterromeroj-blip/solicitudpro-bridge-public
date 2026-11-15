import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchAgentCommand, launchAgentPaths, renderLaunchAgent } from '../local/macos-launch-agent.js';

test('LaunchAgent uses absolute executables, a fixed PATH and launchd lifecycle guards', () => {
  const plist = renderLaunchAgent({
    nodePath: '/usr/local/bin/node',
    entryPath: '/Users/test/Documents/solicitudpro-bridge/dist/local/start-relay.js',
    workingDirectory: '/Users/test/Documents/solicitudpro-bridge',
  });
  assert.match(plist, /<string>com\.solicitudpro\.bridge-relay<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>[\s\S]*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>15<\/integer>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.doesNotMatch(plist, /zsh|bash|\.zshrc|\.bashrc|token|credential/i);
});

test('LaunchAgent rejects relative or XML-unsafe execution paths', () => {
  assert.throws(() => renderLaunchAgent({ nodePath: 'node', entryPath: '/tmp/start.js', workingDirectory: '/tmp' }), /absolute/i);
  const plist = renderLaunchAgent({ nodePath: '/opt/a&b/node', entryPath: '/tmp/<bridge>/start.js', workingDirectory: '/tmp/bridge' });
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /&lt;bridge&gt;/);
});

test('launchctl commands target one user label and one plist', () => {
  const paths = launchAgentPaths('/Users/test');
  assert.deepEqual(paths, {
    directory: path.normalize('/Users/test/Library/LaunchAgents'),
    plist: path.normalize('/Users/test/Library/LaunchAgents/com.solicitudpro.bridge-relay.plist'),
  });
  assert.deepEqual(launchAgentCommand('bootstrap', 501, paths.plist), ['bootstrap', 'gui/501', paths.plist]);
  assert.deepEqual(launchAgentCommand('bootout', 501, paths.plist), ['bootout', 'gui/501', paths.plist]);
  assert.deepEqual(launchAgentCommand('start', 501, paths.plist), ['bootstrap', 'gui/501', paths.plist]);
  assert.deepEqual(launchAgentCommand('stop', 501, paths.plist), ['bootout', 'gui/501', paths.plist]);
  assert.deepEqual(launchAgentCommand('status', 501, paths.plist), ['print', 'gui/501/com.solicitudpro.bridge-relay']);
});
