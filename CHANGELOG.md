# Changelog

## 0.1.6

- Keep the review shortcut active in plain text tabs opened by the action, including untracked files and staged-file views.
- Preserve ordinary typing in unrelated text editors and release the shortcut when disabled with **Stage and Next: Toggle Enabled**.
- Track review tabs individually so closing and reopening a file normally returns it to ordinary editing.

## 0.1.5

- Follow the project template with English and Canadian French documentation, Crown copyright notices, and project branding.
- Adopt the template's English and French LiLiQ-R licences while preserving the Microsoft MIT notice and earlier project licence notices.
- Include bilingual documentation, licences, notices, and the logo in offline VSIX packages.

## 0.1.4

- Restrict editor shortcuts to diff editors and opening-only shortcuts to an empty editor area, so character bindings type normally in Markdown and other text editors.
- Add **Stage and Next: Toggle Enabled** to the Command Palette, backed by a persistent application setting that disables actions and releases their shortcuts.
- Keep Source Control shortcuts and explicit commands available for reviewing files.

## 0.1.3

- Replace completed working-tree review tabs with their Staged Changes view before advancing, so mouse Back shows the staged changes instead of an empty diff.
- Use HEAD-to-index comparisons for modified and renamed files, index contents for new files, and HEAD contents for deleted files.
- Keep the working-tree view after partial staging or failed operations.

## 0.1.2

- Open the first unstaged change when no relevant document is active, including an empty editor area, without staging anything.
- After staging the last item, open the new last remaining item instead of wrapping to the beginning.
- Preserve reviewed diff tabs in VS Code's native Back/Forward navigation history, including when Git closes diffs during staging.
- Keep the shortcut out of text inputs, terminals, and Quick Open when opening changes from an empty editor area.

## 0.1.1

- Follow the live Source Control view and sort choices when opening the next unstaged file, including List sorted by Name, Path, or Status and folders-first Tree order.
- Match VS Code's ordering for duplicate filenames, numeric filename sorting, and localized status labels.
- Apply the same view order from keyboard shortcuts, the Command Palette, and file context menus.

## 0.1.0

- Stage selected ranges with VS Code's existing Git action, keeping the current file open.
- Stage the active file and open the next unstaged file with one shortcut.
- Support text editors, either side of a diff, and focused Source Control file rows.
- Package offline with no third-party dependencies.
