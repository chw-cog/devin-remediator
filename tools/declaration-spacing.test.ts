import { deepStrictEqual } from "node:assert";
import plugin from "./declaration-spacing.ts";

const lint = (source: string) =>
  Deno.lint.runPlugin(plugin, "example.ts", source);

Deno.test("separates schemas, types, helpers, and classes", () => {
  const constructs = [
    "const schema = make({\n  value: true,\n});",
    "type Value = string;",
    "const helper = () => true;",
    "export class Service {}",
  ];
  const source = constructs.join("\n");
  const diagnostics = lint(source);
  deepStrictEqual(diagnostics.length, 3);
  let fixed = source;
  for (const diagnostic of diagnostics.toReversed()) {
    for (const fix of diagnostic.fix ?? []) {
      fixed = fixed.slice(0, fix.range[0]) + (fix.text ?? "") +
        fixed.slice(fix.range[1]);
    }
  }
  deepStrictEqual(fixed, constructs.join("\n\n"));
  deepStrictEqual(lint(fixed), []);
});

Deno.test("keeps imports, short constants, and function bodies compact", () => {
  deepStrictEqual(
    lint(
      'import a from "a";\nimport b from "b";\n\n' +
        "const first = 1;\nconst second = 2;\n\n" +
        "function run() {\n  const value = 1;\n  return value;\n}\n",
    ),
    [],
  );
});

Deno.test("preserves trailing comments and leading documentation", () => {
  const source =
    "type Value = string; // trailing\n/** Service docs */\nclass Service {}";
  const [diagnostic] = lint(source);
  const [fix] = diagnostic.fix ?? [];
  deepStrictEqual(
    source.slice(0, fix.range[0]) + fix.text + source.slice(fix.range[1]),
    "type Value = string; // trailing\n\n/** Service docs */\nclass Service {}",
  );
});

Deno.test("handles same-line constructs and CRLF", () => {
  for (const newline of ["", "\r\n"]) {
    const source = `type Value = string;${newline}class Service {}`;
    const [diagnostic] = lint(source);
    const [fix] = diagnostic.fix ?? [];
    const separator = newline || "\n";
    deepStrictEqual(
      source.slice(0, fix.range[0]) + fix.text + source.slice(fix.range[1]),
      `type Value = string;${separator}${separator}class Service {}`,
    );
  }
});
