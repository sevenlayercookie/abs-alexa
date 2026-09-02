import globals from "globals";
import js from "@eslint/js";

export default [
  { ignores: ["**/node_modules/**", "test/fixtures/**", "test/snapshots/**"] },
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      // The rule that earns its keep here. Assigning to an undeclared name used
      // to create a global that survived between Lambda invocations; reading one
      // throws. This caught 36 such sites, and later caught a require() that was
      // dropped during the module split -- something the tests could not see,
      // because that code path only runs against Amazon's live API.
      "no-undef": "error",
      // Everything below is real but stylistic. They are warnings, not errors,
      // so a red build always means something is actually broken. A linter that
      // cries wolf is a linter people stop reading.
      "no-unused-vars": ["warn", { args: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-prototype-builtins": "warn",
      // Worth keeping visible: a `let` in a switch case is scoped to the whole
      // switch, which is exactly how `let playUrl` collided across two cases
      // in PlaybackControllerHandler during the refactor.
      "no-case-declarations": "warn",
      // sanitizeForSSML strips control characters on purpose.
      "no-control-regex": "off",
    },
  },
];
