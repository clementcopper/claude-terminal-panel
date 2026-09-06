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
  Uri: {
    joinPath() {
      return {};
    }
  }
};
