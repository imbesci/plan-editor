// idiomorph ships no type declarations. Modelled from the JSDoc in
// node_modules/idiomorph/dist/idiomorph.esm.js — keep in sync when bumping.
declare module "idiomorph" {
  interface MorphCallbacks {
    /** Return false to skip adding the node. */
    beforeNodeAdded?: (node: Node) => boolean | void;
    afterNodeAdded?: (node: Node) => void;
    /** Return false to leave the old node untouched and skip its subtree. */
    beforeNodeMorphed?: (oldNode: Node, newNode: Node) => boolean | void;
    afterNodeMorphed?: (oldNode: Node, newNode: Node) => void;
    /** Return false to keep the node. */
    beforeNodeRemoved?: (node: Node) => boolean | void;
    afterNodeRemoved?: (node: Node) => void;
    beforeAttributeUpdated?: (attributeName: string, node: Element, mutationType: "update" | "remove") => boolean | void;
  }

  interface MorphOptions {
    morphStyle?: "outerHTML" | "innerHTML";
    ignoreActive?: boolean;
    ignoreActiveValue?: boolean;
    head?: { style?: "merge" | "append" | "morph" | "none" };
    callbacks?: MorphCallbacks;
  }

  export const Idiomorph: {
    morph(oldNode: Node, newContent: Node | string, options?: MorphOptions): Node[] | undefined;
  };
}
