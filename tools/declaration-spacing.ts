export default {
  name: "repo",
  rules: {
    "declaration-spacing": {
      create(context) {
        const source = context.sourceCode;
        const compactConstant = (node: Deno.lint.Statement) =>
          node.type === "VariableDeclaration" &&
          !source.getText(node).includes("\n") &&
          node.declarations.every((declaration) =>
            declaration.init?.type !== "ArrowFunctionExpression" &&
            declaration.init?.type !== "FunctionExpression"
          );

        return {
          Program(program) {
            for (let i = 1; i < program.body.length; i++) {
              const previous = program.body[i - 1];
              const current = program.body[i];
              if (
                (previous.type === "ImportDeclaration" &&
                  current.type === "ImportDeclaration") ||
                (compactConstant(previous) && compactConstant(current))
              ) continue;
              const gap = source.text.slice(
                previous.range[1],
                current.range[0],
              );
              if (/\r?\n[ \t]*\r?\n/.test(gap)) continue;
              const newline = gap.indexOf("\n");
              const position = previous.range[1] +
                (newline === -1 ? 0 : newline + 1);
              const separator = source.text.includes("\r\n") ? "\r\n" : "\n";
              context.report({
                node: current,
                message: "Separate top-level constructs with a blank line.",
                fix: (fixer) =>
                  fixer.insertTextBeforeRange(
                    [position, position],
                    newline === -1 ? separator.repeat(2) : separator,
                  ),
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
