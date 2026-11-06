<div align="center">
    <h1>Stage and Next</h1>
    <img src="logo.png" alt="Stage and Next logo" width="230">
    <br/>

[Voir la version française](./README.fr_ca.md)

</div>

## Description

One shortcut for reviewing and staging Git changes in VS Code.

Press **Ctrl+Alt+S** on Windows/Linux or **Cmd+Option+S** on macOS:

- With selected text in the modified side of a diff, run VS Code's **Git: Stage Selected Ranges** and stay on the file. Multiple selections are supported.
- With empty selections in a diff, save and stage the current file, then open the next unstaged file in the same repository.
- When the action opens an untracked file as a plain text editor, keep using the same shortcut to stage it and continue reviewing.
- With a file row focused in Source Control's **Changes** or **Untracked Changes**, stage that file and open the next one. Selections left in an inactive editor do not affect this action.
- With all editors closed, open the first unstaged change without staging anything. Prefer the selected Source Control repository, then another open repository with changes.

The shortcut leaves text editors opened outside the review action alone, so character bindings such as backtick type normally in Markdown and other files. Plain text tabs opened by the review action stay part of the review, including untracked files and staged-file views. Use **Stage and Next: Toggle Enabled** when you want to type the shortcut character in a review tab. Closing a review tab and reopening the file normally returns it to ordinary editing.

You can also run **Stage and Next: Stage Selection or File and Open Next Change** from the Command Palette or a changed file's Source Control context menu. Explicit commands also support ordinary text editors.

Run **Stage and Next: Toggle Enabled** from the Command Palette to disable or re-enable the actions and release their shortcuts. This preference persists across windows and reloads. You can also change **Stage and Next: Enabled** in Settings. The toggle remains available while disabled, even without an open Git repository.

Reviewed files stay open as normal tabs so VS Code's native mouse **Back/Forward** buttons and **Go Back/Go Forward** commands revisit the review sequence. After staging a whole file, the action replaces its working-tree view with the view from **Staged Changes** before opening the next file. Modified and renamed files compare **HEAD to the index**, so Back shows the staged highlights instead of an empty comparison against the updated working tree. New files show their index contents, and deleted files show their HEAD contents, matching Git's staged-file views. This also works with `git.closeDiffOnOperation` enabled. Closing a reviewed diff yourself can remove its native history entry.

The shortcut and menus follow the current Source Control **View & Sort** choices: List by Name, Path, or Status, or folders-first Tree order. For example, List by Name compares filenames across folders, so `src/apple.ts` comes before `docs/zebra.md`. After staging the last file, open the new last remaining file. Repeated presses then work backward from the end. When Git displays untracked files separately, those come after tracked files. Hidden untracked files are skipped. Staging stays within the current repository and skips already staged files. When no unstaged files remain, a status message appears.

Selected ranges use VS Code's own Git behavior, including its handling of line boundaries and unsaved edits. Select ranges on the modified (right-hand) side; selections on a read-only Git document show guidance and never stage the whole file. Empty selections work on either side. Whole-file staging saves only the target file first. Merge conflicts stay with VS Code's built-in conflict resolution actions.

## Change the shortcut

Open **Preferences: Open Keyboard Shortcuts**, search for `@command:review.stageAndNext`, and assign your shortcut to its existing entries. There are separate entries for diff editors and review-opened text tabs, Source Control, opening a change when all editors are closed, and each view/sort choice. Keep their `when` conditions and `args`: these pass the live view order and make the focused Source Control row take precedence over an inactive editor selection. The opening-only entries use `source: "browse"` and avoid intercepting text inputs, terminals, and Quick Open.

For existing custom bindings, include `config.stageAndNext.enabled` in every `when` condition so the toggle releases the key. Editor bindings also need `editorAreaFocus && (isInDiffEditor || stageAndNext.reviewEditor) && editorTextFocus`; opening-only bindings need `!activeEditor` and the existing input-focus exclusions. User bindings override extension defaults and must be updated separately.

If you previously added a custom binding for version 0.1.0, update it from the new extension defaults so it also passes `viewOrder`. A direct call to `review.stageAndNext` without `viewOrder` uses `scm.defaultViewMode` and `scm.defaultViewSortKey`; toolbar overrides are passed by the extension's shortcuts and menu entries. The Command Palette shows one action matching the current view order.

## Develop and install offline

Requires Node.js 22 or newer and desktop VS Code 1.96 or newer with its built-in Git extension enabled. There is no dependency installation or compilation step.

```sh
npm test
npm run test:integration
npm run package
code-insiders --install-extension ./dist/stage-and-next-0.1.6.vsix --force
```

`node scripts/package.cjs` also works directly without npm. The packager includes only the manifest, runtime source, English and French READMEs and licences, changelog, third-party notices, and project logo. Press F5 in this folder to launch an Extension Development Host. The native integration tests launch an isolated VS Code profile and disposable Git repository; set `VS_CODE_EXE` if VS Code is installed at a different location.

## Scope and privacy

This extension operates locally through VS Code's built-in Git extension. It contains no telemetry, network code, credentials, account identifiers, or dependencies. It stages changes without committing, pushing, or discarding them. The source can be published to a public repository. The `review-tools` publisher identifier is a local packaging identifier; select your own registered publisher before publishing to the Marketplace.

VS Code does not expose its focused Source Control row through a public extension API. The SCM shortcut briefly opens an empty read-only helper tab, uses VS Code's list selection command to open the focused row, then closes the helper. Focusing a folder or group will not stage another open file. Navigation stays within the target repository. In Tree view, it follows folders-first file order and opens the next changed file even if its folder is collapsed. Inline multi-file diff views use the active text editor when one is available; the normal per-file Changes diff is the primary workflow.

## Licence

Starting with version 0.1.5, this project uses the Québec Free and Open-Source Licence – Reciprocity (LiLiQ-R-1.1), following the repository template. Read the [English licence](./LICENSE.txt) or the [French licence](./LICENSE.fr_ca.txt).

The Visual Studio Code sorting code in [src/order.cjs](./src/order.cjs) retains its Microsoft copyright and MIT licence. Its complete notice and the MIT notice for earlier project versions are preserved in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Copyright

Copyright belongs to © His Majesty the King in Right of Canada, as represented by the Minister of Agriculture and Agri-Food, 2026.
