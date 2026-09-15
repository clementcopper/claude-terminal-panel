/**
 * The least of `vscode` a host module needs to load outside VS Code. Used through esbuild's
 * `--alias:vscode=...` by the Node probes; see .claude/rules/probes.md.
 */
module.exports = {
  window: {
    showWarningMessage() {},
    createOutputChannel() {
      return { appendLine() {}, dispose() {} };
    }
  },
  workspace: { workspaceFolders: [] },
  env: {
    clipboard: {
      // The text a browser paste would deliver — `pbpaste` reads the same pasteboard string.
      readText() {
        try {
          return Promise.resolve(
            require('child_process').execFileSync('pbpaste', { encoding: 'utf8' })
          );
        } catch {
          return Promise.resolve('');
        }
      }
    }
  },
  Uri: {
    joinPath() {
      return {};
    }
  }
};
