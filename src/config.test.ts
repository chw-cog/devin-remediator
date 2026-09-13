import { strict as assert } from "node:assert";
import { Config, ConfigProvider, Effect, Result } from "effect";
import { withConfig } from "./config.ts";

Deno.test("withConfig loads the API key from the supplied environment", async () => {
  for (const key of ["cog_first-key", "cog_second-key"]) {
    const config = await Effect.runPromise(
      withConfig({ DEVIN_API_KEY: key }, Effect.succeed),
    );
    assert.deepEqual(config, { devinApiKey: key });
  }
});

Deno.test("withConfig rejects missing or empty API keys before calling back", async () => {
  for (const env of [{}, { DEVIN_API_KEY: undefined }, { DEVIN_API_KEY: "" }]) {
    let called = false;
    const result = await Effect.runPromise(
      withConfig(env, () => {
        called = true;
        return Effect.void;
      }).pipe(Effect.result),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ConfigError");
    assert.equal(called, false);
  }
});

Deno.test("withConfig preserves callback failures", async () => {
  const result = await Effect.runPromise(
    withConfig(
      { DEVIN_API_KEY: "cog_test-key" },
      () => Effect.fail("callback failed"),
    ).pipe(Effect.result),
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure, "callback failed");
});

Deno.test("withConfig scopes its provider to the callback", async () => {
  const keys = await Effect.runPromise(
    Effect.gen(function* () {
      const inner = yield* withConfig(
        { DEVIN_API_KEY: "cog_inner-key" },
        () => Config.String("DEVIN_API_KEY"),
      );
      const outer = yield* Config.String("DEVIN_API_KEY");
      return { inner, outer };
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ DEVIN_API_KEY: "cog_outer-key" }),
      ),
    ),
  );
  assert.deepEqual(keys, {
    inner: "cog_inner-key",
    outer: "cog_outer-key",
  });
});
