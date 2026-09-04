import globals from "globals";
import js from "@eslint/js";
import n from "eslint-plugin-n";

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

  {
    // The deployed skill runs on nodejs16.x. Alexa-hosted fixes the runtime when
    // the skill is created and offers no alternative -- verified against skills
    // created from both the developer console and the CLI, all of which report
    // nodejs16.x. So everything under lambda/ must stay Node 16 compatible, and
    // this enforces it instead of relying on anyone remembering.
    //
    // Deliberately NOT applied to test/, which uses node:test (Node 18+) and
    // only ever runs on a developer machine or in CI.
    files: ["lambda/**/*.js"],
    plugins: { n },
    rules: {
      "n/no-unsupported-features/node-builtins": ["error", { version: ">=16.0.0" }],
      "n/no-unsupported-features/es-builtins": ["error", { version: ">=16.0.0" }],
      "n/no-unsupported-features/es-syntax": ["error", { version: ">=16.0.0" }],
    },
  },
];
