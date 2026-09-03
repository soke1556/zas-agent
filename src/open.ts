// Opens a URL in the person's default browser and never waits for it. The
// child is detached with no stdio of its own: an MCP server's stdout is the
// protocol channel, and a browser that inherited it would corrupt the
// session. A browser that will not open is not a failed pairing — the link is
// printed either way — so every failure here is swallowed.
import { spawn } from 'node:child_process';

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const [command, args]: [string, string[]] = platform === 'win32'
      // `start` is a cmd built-in; the empty string is the window title it
      // would otherwise take the quoted URL for.
      ? ['cmd', ['/c', 'start', '', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // See above: the link is on screen.
  }
}
