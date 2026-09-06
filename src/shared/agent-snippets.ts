/** Shared by the website and CLI so their setup commands cannot drift. */
export function agentSnippets(profile: string, windows = false, pkg = 'zas-agent') {
  // An explicit tag avoids selecting an unbuilt local npm workspace.
  const runner = windows ? 'npx.cmd' : 'npx';
  const command = `${runner} -y ${pkg}@latest`;
  // cmd resolves both native executables and npm shims without PowerShell's
  // script execution policy or argument parsing affecting registration.
  const shell = windows ? 'cmd /d /c ' : '';
  return {
    pair: `${command} pair --profile ${profile}`,
    claude: `${shell}claude mcp add zas "--" ${command} --profile ${profile}`,
    codex: `${shell}codex mcp add zas "--" ${command} --profile ${profile}`,
  };
}
