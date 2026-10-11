import tailwindcss from "@tailwindcss/postcss";

const inheritGeneratedNodeSources = {
  postcssPlugin: "inherit-generated-node-sources",
  Once(root) {
    root.walk((node) => {
      if (node.source?.input?.file) return;

      let parent = node.parent;
      while (parent && !parent.source?.input?.file) {
        parent = parent.parent;
      }

      if (!parent?.source?.input?.file) return;

      node.source = {
        ...(node.source ?? {}),
        input: parent.source.input,
        start: node.source?.start ?? parent.source.start,
        end: node.source?.end ?? parent.source.end,
      };
    });
  },
};

export default {
  plugins: [tailwindcss(), inheritGeneratedNodeSources],
};
