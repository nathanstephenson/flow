import type { Project } from "../../../src/protocol/projects.ts";

/**
 * Projects, arranged the way a dropdown has to draw them.
 *
 * The Session Host reports a flat list with a `group` label rather than a tree
 * (src/protocol/projects.ts), because one level of headings is all a dropdown can render. This turns
 * that list into the one level, and it is the whole of the transformation.
 *
 * DOM-free and here rather than in the component, for the reason `reapable.ts` is: `node --test` can
 * then hold it to account, and "which heading does this repository appear under" is the part with
 * the edge cases in it.
 */

export type ProjectGroup = {
  /**
   * The heading, or undefined for the Projects sitting directly in the Project Root. Those get no
   * heading at all — inventing one ("Root", "Other") would name a thing the reader never wrote.
   */
  group: string | undefined;
  items: Project[];
};

/**
 * One group per distinct label, in the order the Session Host reported them.
 *
 * The order is deliberately borrowed rather than recomputed. The host sorts by group and then by
 * name, which is what makes every Project sharing a label contiguous; sorting again here would be a
 * second copy of that rule, free to disagree with the first.
 */
export function groupProjects(projects: Project[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const project of projects) {
    const last = groups[groups.length - 1];
    if (last && last.group === project.group) {
      last.items.push(project);
      continue;
    }
    groups.push({ group: project.group, items: [project] });
  }
  return groups;
}

/**
 * How a path should be written into `projects.include`: relative to the Project Root when it sits
 * beneath it, and absolute when it does not.
 *
 * Purely about how config.json *reads*. Either spelling resolves to the same directory
 * (`includedProjects` in src/daemon/projects.ts), so nothing depends on this — but a file full of
 * `/home/you/workspace/work/api` is one nobody would want to hand-edit, and a relative entry also
 * survives the Project Root being moved. Which is the whole reason the root exists.
 *
 * `root` is the *expanded* root, because that is what the paths being compared are. A path that
 * merely shares a prefix as text is not beneath it — `/w/workspace-old` is not inside `/w/workspace`
 * — hence comparing against `root + "/"`.
 */
export function includeEntryFor(path: string, root: string | undefined): string {
  if (root === undefined || root === "") return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return path;
  const relative = path.slice(prefix.length);
  // The root itself relativises to nothing, and an empty entry names nothing, so it stays absolute.
  return relative === "" ? path : relative;
}
