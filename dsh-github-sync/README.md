# GitHub sync

A DeepSeek Harness plugin that commits workspace changes and pushes them to a
GitHub repository using the system `git` binary.

## What it does

- Watches the workspace directory (or a folder you choose) and, in `auto` mode,
  commits + pushes after a short debounce when files change.
- In `interval` mode, commits + pushes on a fixed interval.
- In `manual` mode, only syncs when you ask.
- Stores the GitHub token in the Harness credentials service — never in config
  and never in `.git/config`.

## Setup

1. Install the bundle (done for you by the Harness plugin manager).
2. Configure it. The easiest way is to ask the agent:

   > Configure GitHub sync to push the workspace to `owner/repo` on branch
   > `main` using this token: `ghp_...`

   That calls the `github_sync_configure` tool, which stores the token in the
   credentials service and saves the rest of the settings.

   Alternatively, edit the plugin `config` mapping directly.

3. Add a `.gitignore` in the synced folder so build output and dependencies are
   not committed (for example `node_modules/`, `.DS_Store`, `*.log`).

## Tools

- `github_sync` — commit and push now. Optional `message` argument overrides
  the commit message.
- `github_sync_status` — show repository, branch, mode, token state, and the
  last sync result.
- `github_sync_configure` — set repository, branch, mode, author, token, etc.
  Omitted fields are left unchanged.

## Config

These keys live in the plugin `config` mapping and can be changed at runtime
with `github_sync_configure`:

| Key | Type | Default | Description |
|---|---|---|---|
| `repository` | string | `''` | `owner/repo`, `https://github.com/owner/repo.git`, or `git@github.com:owner/repo.git` |
| `branch` | string | `main` | branch to push to |
| `mode` | string | `auto` | `auto`, `interval`, or `manual` |
| `intervalSeconds` | number | `300` | interval for `interval` mode |
| `debounceMs` | number | `1500` | debounce for `auto` mode |
| `authorName` | string | `DeepSeek Harness` | commit author name |
| `authorEmail` | string | `harness@deepseek.local` | commit author email |
| `commitMessage` | string | `sync: workspace changes` | default commit message |
| `sourceDirectory` | string | `''` | absolute path to sync; empty means the workspace directory |
| `auth` | string | `token` | `token` (HTTPS personal access token) or `ssh` (SSH key) |
| `push` | boolean | `true` | whether to push after committing |

## Authentication

- `token`: a GitHub fine-grained personal access token with **Contents:
  read/write** on the target repository. The token is passed to `git push`
  through an ephemeral `http.extraHeader`, so it is never written to disk by
  this plugin.
- `ssh`: use `git@github.com:owner/repo.git` as the repository and make sure
  the host can authenticate with its SSH key.
