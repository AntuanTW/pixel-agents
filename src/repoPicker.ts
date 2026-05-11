import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { addRecentRepo, readConfig } from './configPersistence.js';

export interface RepoPickResult {
  repoPath: string;
  displayName: string;
  recentRepos: string[];
}

/** Returns the picked repo path, or undefined if cancelled. */
export async function pickRepo(): Promise<RepoPickResult | undefined> {
  // If no recent repos, go straight to browse dialog
  // If there are recent repos, webview handles showing them (sent via settingsLoaded).
  // This function is called when the user clicks Browse in the webview RepoPicker.
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use this folder',
    title: 'Pick a repo for your agent',
  });

  if (!uris || uris.length === 0) return undefined;

  const repoPath = uris[0].fsPath;
  const displayName = path.basename(repoPath);

  // Warn if .git is missing, but allow
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    void vscode.window.showWarningMessage(
      `[Pixel Agents] "${displayName}" has no .git folder. The agent will still work but git features (branch detection) will be unavailable.`,
    );
  }

  addRecentRepo(repoPath);
  const updatedConfig = readConfig();

  return { repoPath, displayName, recentRepos: updatedConfig.recentRepos };
}
