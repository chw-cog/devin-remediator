/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { inspect } from "node:util";
import { ConfigProvider, Layer, ManagedRuntime } from "effect";
import { DatabaseClient } from "../src/database.ts";
import { DevinSessionRepository } from "../src/devin-session-repository.ts";

const makeRuntime = (env: Record<string, string>) =>
  ManagedRuntime.make(
    DevinSessionRepository.layer.pipe(
      Layer.provideMerge(DatabaseClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

let runtime: ReturnType<typeof makeRuntime> | undefined;

self.onmessage = async (event) => {
  try {
    if (event.data.action === "initialize") {
      runtime = makeRuntime(event.data.env);
      await runtime.runPromise(DatabaseClient);
      self.postMessage({ ready: true });
    } else if (
      (event.data.action === "claim" || event.data.action === "claimPending") &&
      runtime !== undefined
    ) {
      const claims = await runtime.runPromise(
        DevinSessionRepository.use((repository) =>
          event.data.action === "claimPending"
            ? repository.claimPending
            : repository.claimDueObservations()
        ),
      );
      self.postMessage({ claims });
    } else if (event.data.action === "close" && runtime !== undefined) {
      await runtime.dispose();
      self.postMessage({ closed: true });
    } else throw new Error("Invalid worker request");
  } catch (error) {
    self.postMessage({ error: inspect(error, { depth: 10 }) });
  }
};
