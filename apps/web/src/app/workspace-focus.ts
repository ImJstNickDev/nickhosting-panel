/** Headings are optional in dense workspaces; the main landmark is always focusable. */
export function focusWorkspace() {
  const target =
    document.querySelector<HTMLElement>('[data-workspace-focus], h1') ??
    document.getElementById('content');
  target?.focus();
}
